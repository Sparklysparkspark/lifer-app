// RAW files: the dedicated "Choose RAW files" picker (POST /uploads/raw) and a RAW dropped into
// the main import (handleRawPrimaryUpload, called from photo.ts).
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { withSchemas } from "../lib/schema.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { generateDerivatives } from "@lifer/core/uploads/image.js";
import { captureTimeFromTags, extractExif, computeExifFingerprint, readExifTags, extractEmbeddedPreview, type CaptureTime, type ExifFingerprint, type ExtractedExif } from "./exif.js";
import { syncCaptureXmpSidecars } from "./xmpSidecarSync.js";
import { isRawExtension, isRawFile } from "@lifer/core/uploads/formats.js";
import { originalsFolder } from "./organizedPath.js";
import { resolveSpeciesFolderName } from "./speciesFolderName.js";
import { resolveChosenVolumeDestination } from "../storageVolumes/resolve.js";
import { ensureDir } from "@lifer/core/lib/safeFs.js";
import { moveFile, receiveToFile } from "../lib/stagedUploads.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { log } from "@lifer/core/lib/log.js";
import { markCollected } from "../lib/userSpecies.js";
import type { CullMarks } from "@lifer/shared";
import { NO_CULL_MARKS } from "./cullMarks.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { contentHash } from "@lifer/core/species/inference.js";
import { findRawRelatedCaptures, type RawCaptureMatch } from "./rawMatching.js";
import { claimUploadById, isUploadSourceError, type ReceivedFile } from "./uploadSource.js";
import {
  UPLOAD_TX_TIMEOUTS,
  derivativeFiles,
  moveIntoLibrary,
  originalFilename,
  queueCaptureVectors,
  removeFiles,
  uploadTmpDir,
  type ChosenVolume,
} from "./common.js";

// RAWs processed at once per /uploads/raw request (exiftool plus a large file copy each).
const RAW_PROCESS_CONCURRENCY = 2;

interface RawUploadOutcome {
  filename: string;
  linked: boolean;
  collision: boolean;
  captureId?: string;
  speciesCommonName?: string | null;
  speciesScientificName?: string;
  /** Filed straight into a species' RAW folder without matching a capture (allowUnmatchedFallback). */
  filed?: boolean;
  /** Already present (identical content) in that species' RAW folder, so not added again. */
  duplicate?: boolean;
  /** Set for a RAW sent as a resumable upload. */
  uploadId?: string;
  /** Why a resumable upload couldn't be used (expired, not yours, already importing). */
  error?: string;
}

/** Files a RAW beside the JPEG of the one capture it matched and links it to that capture: in
 *  the capture's trip folder when it has one, and its location folder when the user organizes by
 *  location. A failed insert moves the file back so no filed copy is left without a row. */
async function fileRawWithCapture(
  match: RawCaptureMatch,
  file: { path: string; sha256: string; size: number },
  rawFileName: string,
  userId: string,
  exif: ExtractedExif,
  time: CaptureTime | null,
  fingerprint: ExifFingerprint,
  chosenVolume: ChosenVolume | null,
): Promise<void> {
  const { organizeByYear, organizeByLocation } = await getUserFileSettings(userId);
  const folder = originalsFolder(match.trip_folder ?? chosenVolume?.baseDir ?? ORIGINALS_DIR, {
    organizeByYear,
    organizeByLocation,
    locationLabel: match.location_label,
    speciesFolderName: await resolveSpeciesFolderName(userId, match.species_id),
    taxonClass: match.taxon_class,
    takenAt: exif.takenAt,
    takenAtWallClock: time?.wallClock,
    subfolder: "RAW",
  });
  const dest = await moveIntoLibrary(file.path, folder, originalFilename(rawFileName, time, path.extname(rawFileName).toLowerCase()));
  const volumeRelativePath = chosenVolume ? dest.slice(chosenVolume.mountPath.length) : null;
  try {
    await pool.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id, volume_id, volume_relative_path)
       VALUES ($1, 'raw', 'path', $2, true, $3, $4, $5, $6, $7, $8, $9)`,
      [match.id, dest, file.sha256, file.size, fingerprint.strict, fingerprint.loose, userId, chosenVolume?.volumeId ?? null, volumeRelativePath],
    );
  } catch (err) {
    await moveFile(dest, file.path).catch(() => rmSync(dest, { force: true }));
    throw err;
  }
}

// The RAW arrives already on disk at `tmpPath` (a temp file or a resumable upload; whatever is
// left there afterwards is the caller's), so a batch of big files is never held in memory. It is
// moved into the library when it's kept. `contentHash` is its sha256, taken while receiving.
async function processOneRawUpload(
  tmpPath: string,
  contentHash: string,
  fileSize: number,
  rawFileName: string,
  userId: string,
  speciesId: string | null,
  allowUnmatchedFallback: boolean,
  chosenVolume: ChosenVolume | null,
): Promise<RawUploadOutcome> {
  const tags = await readExifTags(tmpPath);
  const exif = await extractExif(tmpPath, tags);
  const time = captureTimeFromTags(tags);
  const fingerprint = await computeExifFingerprint(tmpPath, tags);

  const matches = await findRawRelatedCaptures(userId, rawFileName, exif, fingerprint, time);

  if (matches.length === 1) {
    const match = matches[0];
    await fileRawWithCapture(match, { path: tmpPath, sha256: contentHash, size: fileSize }, rawFileName, userId, exif, time, fingerprint, chosenVolume);
    return {
      filename: rawFileName,
      linked: true,
      collision: false,
      captureId: match.id,
      speciesCommonName: match.common_name,
      speciesScientificName: match.scientific_name,
    };
  }

  // No match. The folder import never guesses, but a species page's own picker
  // (allowUnmatchedFallback, RawUpload.tsx) knows the species, so the RAW is filed there.
  if (matches.length === 0 && allowUnmatchedFallback && speciesId) {
    const speciesRes = await pool.query<{ common_name: string | null; scientific_name: string; taxon_class: string | null }>(
      `SELECT common_name, scientific_name, taxon_class FROM species WHERE id = $1`,
      [speciesId],
    );
    const species = speciesRes.rows[0];
    if (species) {
      const { organizeByYear } = await getUserFileSettings(userId);
      // A content-identical file already filed for this species is the same photo: skip it.
      const existing = await pool.query(
        `SELECT 1 FROM originals WHERE kind = 'raw' AND species_id = $1 AND content_hash = $2 AND user_id = $3 LIMIT 1`,
        [speciesId, contentHash, userId],
      );
      if (existing.rows.length > 0) {
        return { filename: rawFileName, linked: false, collision: false, duplicate: true };
      }

      const folder = originalsFolder(chosenVolume?.baseDir ?? ORIGINALS_DIR, {
        organizeByYear,
        speciesFolderName: await resolveSpeciesFolderName(userId, speciesId),
        taxonClass: species.taxon_class,
        takenAt: exif.takenAt,
        takenAtWallClock: time?.wallClock,
        subfolder: "RAW",
      });
      // A plain name collision gets a "-2" suffix; identical content was ruled out above.
      const dest = await moveIntoLibrary(tmpPath, folder, originalFilename(rawFileName, time, path.extname(rawFileName).toLowerCase()));
      const volumeRelativePath = chosenVolume ? dest.slice(chosenVolume.mountPath.length) : null;
      try {
        await pool.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id, species_id, volume_id, volume_relative_path)
           VALUES (NULL, 'raw', 'path', $1, true, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [dest, contentHash, fileSize, fingerprint.strict, fingerprint.loose, userId, speciesId, chosenVolume?.volumeId ?? null, volumeRelativePath],
        );
      } catch (err) {
        await moveFile(dest, tmpPath).catch(() => rmSync(dest, { force: true }));
        throw err;
      }
      return {
        filename: rawFileName,
        linked: false,
        collision: false,
        filed: true,
        speciesCommonName: species.common_name,
        speciesScientificName: species.scientific_name,
      };
    }
  }

  // A RAW with no kept JPEG is never copied into Lifer; it stays where it was.
  return { filename: rawFileName, linked: false, collision: matches.length > 1 };
}

/** A RAW dropped into the main import. When it matches an imported JPEG it becomes that
 *  capture's RAW; otherwise it is a new, unedited capture whose photo is the RAW's embedded
 *  preview (or no photo at all when it has none). The file is on disk already (`file.path`) and
 *  is moved into the library; a failed import moves it back. */
export async function handleRawPrimaryUpload(
  file: { path: string; sha256: string; size: number },
  rawFileName: string,
  userId: string,
  species: { id: string; common_name: string | null; scientific_name: string; taxon_class: string | null; family: string | null },
  chosenVolume: ChosenVolume | null,
  tripBaseDir: string | null,
  tripId: string | null,
  // The region and place picked at import, so the capture shows on that region's checklist.
  place: { regionId: string | null; locationLabel: string | null },
  // The culling app's marks, kept on a new capture; `hidden` imports it hidden (captures/hidden.ts).
  cull: { marks: CullMarks; hidden: boolean } = { marks: NO_CULL_MARKS, hidden: false },
): Promise<{ captureId: string; photoId: string | null; linkedExisting: boolean }> {
  const tags = await readExifTags(file.path);
  const exif: ExtractedExif = await extractExif(file.path, tags);
  const time: CaptureTime | null = captureTimeFromTags(tags);
  const fingerprint: ExifFingerprint = await computeExifFingerprint(file.path, tags);
  let previewBuffer: Buffer | null = await extractEmbeddedPreview(file.path);

  const { organizeByYear, organizeByLocation } = await getUserFileSettings(userId);
  const rawHash = file.sha256;

  const matches = await findRawRelatedCaptures(userId, rawFileName, exif, fingerprint, time);
  if (matches.length === 1) {
    await fileRawWithCapture(matches[0], file, rawFileName, userId, exif, time, fingerprint, chosenVolume);
    return { captureId: matches[0].id, photoId: null, linkedExisting: true };
  }

  // No match (or an ambiguous one, left for manual review): a new capture under the species being
  // imported into. Files are written before the transaction and removed again on failure.
  const written: string[] = [];
  let photo: { id: string; displayPath: string; thumbPath: string; width: number | null; height: number | null } | null = null;
  let dest: string | null = null;
  const moveBack = async () => {
    if (dest) await moveFile(dest, file.path).catch(() => rmSync(dest!, { force: true }));
  };
  try {
    if (previewBuffer) {
      const photoId = randomUUID();
      written.push(...derivativeFiles(photoId));
      // An unreadable preview (some sensor-data TIFFs carry a stub) just means no photo yet.
      const d = await generateDerivatives(previewBuffer, photoId).catch(() => null);
      if (d) photo = { id: photoId, ...d };
      else previewBuffer = null;
    }
    const folder = originalsFolder(tripBaseDir ?? chosenVolume?.baseDir ?? ORIGINALS_DIR, {
      organizeByYear,
      organizeByLocation,
      locationLabel: place.locationLabel,
      speciesFolderName: await resolveSpeciesFolderName(userId, species.id),
      taxonClass: species.taxon_class,
      takenAt: exif.takenAt,
      takenAtWallClock: time?.wallClock,
      subfolder: "RAW",
    });
    dest = await moveIntoLibrary(file.path, folder, originalFilename(rawFileName, time, path.extname(rawFileName).toLowerCase()));
  } catch (err) {
    removeFiles(written);
    await moveBack();
    throw err;
  }
  const filedRaw = dest!;
  const volumeRelativePath = chosenVolume ? filedRaw.slice(chosenVolume.mountPath.length) : null;
  const photoId = photo?.id ?? null;

  const client = await pool.connect();
  let captureId: string;
  try {
    await client.query("BEGIN");
    await client.query(UPLOAD_TX_TIMEOUTS);
    const captureRes = await client.query<{ id: string }>(
      `INSERT INTO captures
         (user_id, species_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon, camera_model, lens, focal_length_mm, aperture, shutter, iso, trip_id, quality_rating, region_id, location_label, cull_verdict, cull_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        userId,
        species.id,
        rawHash,
        fingerprint.strict,
        fingerprint.loose,
        exif.takenAt,
        exif.lat,
        exif.lon,
        exif.cameraModel,
        exif.lens,
        exif.focalLengthMm,
        exif.aperture,
        exif.shutter,
        exif.iso,
        tripId,
        exif.rating,
        place.regionId,
        place.locationLabel,
        cull.marks.verdict,
        cull.marks.label,
      ],
    );
    captureId = captureRes.rows[0].id;

    if (photo) {
      await client.query(`INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6)`, [
        photo.id,
        captureId,
        photo.displayPath,
        photo.thumbPath,
        photo.width,
        photo.height,
      ]);
      await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photo.id, captureId]);
    }

    if (!cull.hidden) await markCollected(client, userId, species.id, photoId, exif.takenAt);

    await client.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, user_id, volume_id, volume_relative_path)
       VALUES ($1, 'raw', 'path', $2, true, $3, $4, $5, $6, $7, $8, $9)`,
      [captureId, filedRaw, rawHash, file.size, fingerprint.strict, fingerprint.loose, userId, chosenVolume?.volumeId ?? null, volumeRelativePath],
    );

    // Last, since the rows above are written through the `captures` view, which hides it.
    if (cull.hidden) await client.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [captureId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    removeFiles(written);
    await moveBack();
    throw err;
  } finally {
    client.release();
  }

  // This photo may just have become the species' cover: frame the card on the animal.
  if (!cull.hidden) ensureDefaultCardCropLater(userId, species.id);
  // A RAW's species keywords and rating go in an .xmp sidecar next to it, where Lightroom and
  // digiKam look.
  syncCaptureXmpSidecars(userId, captureId).catch(() => {});

  if (previewBuffer) {
    queueCaptureVectors(captureId, previewBuffer, contentHash(previewBuffer), (err) =>
      log.warn({ err, captureId }, "Couldn't compute a species-suggestion embedding for this RAW capture"),
    );
  }

  return { captureId, photoId, linkedExisting: false };
}

export async function rawUploadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // One or many RAWs per request (file parts or `uploadIds`), each matched against imported
  // JPEGs. Only a unique match links; anything else is not kept.
  // Multipart: no body schema, the handler reads and checks each field as it streams in.
  app.post("/uploads/raw", { preValidation: requireAuth, schema: {} }, async (request, reply) => {
    const userId = request.user!.id;
    // Each part is streamed to a temp file and processed in the background while the next is
    // read. The client sends the fields below before any file part.
    let speciesId: string | null = null;
    let allowUnmatchedFallback = false;
    let volumeId: string | null = null;
    let chosenVolume: ChosenVolume | null = null;
    let volumeResolved = false;
    const uploadIds: string[] = [];
    const tmpDir = uploadTmpDir();
    await ensureDir(tmpDir);
    const limit = createLimiter(RAW_PROCESS_CONCURRENCY);
    // null: a file that turned out not to be a RAW (an edited TIFF), left out like a JPEG.
    const pending: Promise<RawUploadOutcome | null>[] = [];
    // Set when the request fails part way: queued files are then only cleaned up, not imported.
    let abandoned = false;

    const resolveVolume = async (): Promise<boolean> => {
      if (volumeResolved) return true;
      volumeResolved = true;
      if (!volumeId) return true;
      chosenVolume = await resolveChosenVolumeDestination(userId, volumeId);
      return chosenVolume !== null;
    };

    // `source` is the RAW on disk; whatever is left of it when the task ends is removed, except
    // a resumable upload whose import failed, which is kept for a retry.
    const queue = (source: ReceivedFile, filename: string) => {
      const volume = chosenVolume;
      const spId = speciesId;
      const fallback = allowUnmatchedFallback;
      const task = limit(async (): Promise<RawUploadOutcome | null> => {
        let ok = false;
        try {
          if (abandoned) return { filename, linked: false, collision: false };
          if (!(await isRawFile(source.path, filename))) {
            ok = true;
            return null;
          }
          const outcome = await processOneRawUpload(source.path, source.sha256, source.size, filename, userId, spId, fallback, volume);
          ok = true;
          return source.uploadId ? { ...outcome, uploadId: source.uploadId } : outcome;
        } finally {
          await source.finish(ok || source.origin !== "tus").catch(() => {});
        }
      });
      // Marked handled now: a file can fail while later parts are still being read, before
      // Promise.all below is attached, and an unhandled rejection would end the process.
      task.catch(() => {});
      pending.push(task);
    };

    try {
      for await (const part of request.parts()) {
        if (part.type !== "file") {
          if (part.fieldname === "speciesId") speciesId = String(part.value);
          else if (part.fieldname === "allowUnmatchedFallback") allowUnmatchedFallback = String(part.value) === "1";
          else if (part.fieldname === "volumeId") volumeId = String(part.value);
          else if (part.fieldname === "uploadIds" || part.fieldname === "uploadIds[]" || part.fieldname === "uploadId") {
            uploadIds.push(...String(part.value).split(",").map((v) => v.trim()).filter(Boolean));
          }
          continue;
        }
        if (!part.filename || !isRawExtension(part.filename)) {
          // Folder pickers include non-RAW siblings (JPEGs, .DS_Store, XMP, THM). busboy is one
          // sequential stream, so a skipped part must still be drained or the parser stalls.
          part.file.resume();
          continue;
        }
        if (!(await resolveVolume())) {
          part.file.resume();
          abandoned = true;
          return reply.code(400).send({ error: "That drive isn't connected right now" });
        }
        const filename = part.filename;
        const tmpPath = path.join(tmpDir, `${randomUUID()}${path.extname(filename).toLowerCase()}`);
        let received: { fingerprint: string; bytes: number };
        try {
          received = await receiveToFile(part.file, tmpPath);
        } catch (err) {
          rmSync(tmpPath, { force: true });
          throw err;
        }
        queue(
          { path: tmpPath, filename, mimetype: part.mimetype, sha256: received.fingerprint, size: received.bytes, origin: "multipart", uploadId: null, finish: async () => rmSync(tmpPath, { force: true }) },
          filename,
        );
      }

      // Resumable uploads, once every field is known. One that can't be used is reported on its
      // own rather than failing the others.
      const unusable: RawUploadOutcome[] = [];
      if (uploadIds.length > 0 && !(await resolveVolume())) {
        abandoned = true;
        return reply.code(400).send({ error: "That drive isn't connected right now" });
      }
      for (const uploadId of [...new Set(uploadIds)]) {
        let source: ReceivedFile;
        try {
          source = await claimUploadById(userId, uploadId);
        } catch (err) {
          if (!isUploadSourceError(err)) throw err;
          unusable.push({ filename: "", uploadId, linked: false, collision: false, error: err.message });
          continue;
        }
        const filename = source.filename ?? "";
        if (!isRawExtension(filename)) {
          await source.finish(true);
          continue;
        }
        queue(source, filename);
      }

      const results = [...(await Promise.all(pending)).filter((r): r is RawUploadOutcome => r !== null), ...unusable];
      if (results.length === 0) {
        return reply.code(400).send({ error: "No supported RAW files found in that upload" });
      }
      return reply.code(201).send({ results });
    } catch (err) {
      abandoned = true;
      throw err;
    } finally {
      // Every started file finishes (and removes its temp file) before the request ends, so a
      // failure never leaves an unawaited rejection behind to crash the process.
      await Promise.allSettled(pending);
    }
  });
}
