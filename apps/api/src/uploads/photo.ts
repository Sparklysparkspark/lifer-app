// POST /uploads: imports one photo under a species. mode=store files it in Lifer's library
// (optionally with its RAW sibling), mode=link references a local file, mode=s3 a bucket object.
// A stored photo arrives as a `file` part, a `stagedId` or an `uploadId`; files are never held in memory.
import { randomUUID, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { generateDerivatives } from "@lifer/core/uploads/image.js";
import {
  captureTimeFromTags,
  extractExif,
  computeExifFingerprint,
  readExifTags,
  type CaptureTime,
  type ExifFingerprint,
  type ExtractedExif,
} from "./exif.js";
import { syncCaptureXmpSidecars } from "./xmpSidecarSync.js";
import { fetchS3Object } from "../photoSources/s3.js";
import {
  claimedPhotoFormat,
  isRawFile,
  sniffPhotoFormat,
  storedPhotoExtension,
  type PhotoFormat,
} from "@lifer/core/uploads/formats.js";
import { originalsFolder } from "./organizedPath.js";
import { resolveSpeciesFolderName } from "./speciesFolderName.js";
import { tagWithRegisteredVolume, resolveChosenVolumeDestination } from "../storageVolumes/resolve.js";
import { assertAllowedPath } from "@lifer/core/lib/allowedPaths.js";
import { moveToFolder } from "@lifer/core/lib/safeFs.js";
import { hashFile, moveFile } from "../lib/stagedUploads.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { isUuid } from "../lib/validate.js";
import { withSchemas } from "../lib/schema.js";
import { markCollected } from "../lib/userSpecies.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import type { ImageSource } from "@lifer/core/species/inference.js";
import { handleRawPrimaryUpload } from "./raw.js";
import { CULL_MARKS_OPTIONS, type CullMarksOption } from "@lifer/shared";
import { cullDecision, readCullMarks, readPairCullMarks } from "./cullMarks.js";
import { prepareWorkingImage, type WorkingImage } from "./workingImage.js";
import {
  claimStagedFile,
  claimUploadById,
  isUploadSourceError,
  receiveMultipartFile,
  type ReceivedFile,
} from "./uploadSource.js";
import {
  UPLOAD_TX_TIMEOUTS,
  derivativeFiles,
  moveIntoLibrary,
  originalFilename,
  queueCaptureVectors,
  removeFiles,
  sanitizeUploadName,
  uploadTempPath,
  type ChosenVolume,
} from "./common.js";
import { moveManagedOriginalToSpeciesFolder } from "./managedFolders.js";

type UploadMode = "store" | "link" | "s3";

// Accepted formats are in formats.ts. The stored file gets the extension of its real (sniffed)
// format, which exiftool and other tools rely on.
const UNSUPPORTED_PHOTO = "Only JPEG, PNG, WebP, TIFF or HEIC photos are supported";

/** A file moved into the library, so a failed import can move it back instead of losing it. */
type Moved = { from: string; to: string };

async function moveBack(moved: Moved[]): Promise<void> {
  for (const m of moved.reverse()) await moveFile(m.to, m.from).catch(() => rm(m.to, { force: true }).catch(() => {}));
}

export async function photoUploadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Multipart: no body schema, the handler reads and checks each field as it streams in.
  app.post("/uploads", { preValidation: requireScope("photos.write"), schema: {} }, async (request, reply) => {
    // Each file part is streamed to its own temp file as it arrives (busboy needs every part
    // drained before it reads the next), so parts and fields can come in any order.
    const fields: Record<string, string> = {};
    const sources: ReceivedFile[] = [];
    let photo: ReceivedFile | null = null;
    let raw: ReceivedFile | null = null;
    let ok = false;
    let outcome: ImportResult;
    try {
      for await (const part of request.parts()) {
        if (part.type === "file") {
          const received = await receiveMultipartFile(part);
          sources.push(received);
          if (part.fieldname === "rawFile") raw ??= received;
          else photo ??= received;
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      outcome = await importPhoto(request, fields, photo, raw, sources);
      ok = outcome.code < 400;
    } finally {
      await Promise.all(sources.map((s) => s.finish(ok).catch(() => {})));
    }
    return reply.code(outcome.code).send(outcome.body);
  });
}

type ImportResult = { code: number; body: unknown };
const result = (code: number, body: unknown): ImportResult => ({ code, body });

// Returns the response instead of sending it, so the route can release the upload's sources
// (removing a used resumable upload) before the client hears back.
async function importPhoto(
  request: FastifyRequest,
  fields: Record<string, string>,
  photoPart: ReceivedFile | null,
  rawPart: ReceivedFile | null,
  sources: ReceivedFile[],
): Promise<ImportResult> {
  const userId = request.user!.id;
  const mode: UploadMode = fields.mode === "link" ? "link" : fields.mode === "s3" ? "s3" : "store";
  const speciesId = fields.speciesId;
  if (!speciesId) return result(400, { error: "speciesId field is required" });
  const regionId = fields.regionId || null;
  if (regionId !== null && !isUuid(regionId)) return result(400, { error: "regionId must be a region id" });
  if (!isUuid(speciesId)) return result(400, { error: "Unknown species" });
  if (fields.tripId && !isUuid(fields.tripId)) return result(400, { error: "Unknown trip" });
  if (fields.albumId && !isUuid(fields.albumId)) return result(400, { error: "Unknown album" });
  // What to do with a photo a culling app rejected. "ignore" when not sent, so a script keeps
  // importing exactly what it sends; the app's import screen sends the user's choice.
  const cullOption = (fields.cullMarks || "ignore") as CullMarksOption;
  if (!CULL_MARKS_OPTIONS.includes(cullOption)) return result(400, { error: "cullMarks must be skip, hide or ignore" });

  let photo = photoPart;
  let raw = rawPart;
  try {
    // The photo was already sent: as a resumable upload (uploadId), or once to be checked
    // (/uploads/inspect kept it as stagedId). 410 when it's no longer there, so the app sends
    // the file after all.
    if (mode === "store" && !photo && fields.uploadId) {
      photo = await claimUploadById(userId, fields.uploadId);
      sources.push(photo);
    } else if (mode === "store" && !photo && fields.stagedId) {
      photo = await claimStagedFile(userId, fields.stagedId, fields.fileName || null, fields.fileType || null);
      if (!photo) return result(410, { error: "The checked copy of this photo has expired. Send the file again." });
      sources.push(photo);
    }
    if (!raw && fields.rawUploadId) {
      if (mode !== "store") return result(400, { error: "rawUploadId is only supported for mode=store" });
      raw = await claimUploadById(userId, fields.rawUploadId);
      sources.push(raw);
    }
  } catch (err) {
    if (isUploadSourceError(err)) return result(err.statusCode, { error: err.message });
    throw err;
  }
  // A resumable upload's own name and type, unless the request names them.
  const fileName = photo ? fields.fileName || photo.filename : null;
  const fileMimetype = photo ? fields.fileType || photo.mimetype : null;

  // Store mode can write onto a registered external drive instead of ORIGINALS_DIR. Resolved
  // first so a disconnected drive fails before any file work.
  let chosenVolume: ChosenVolume | null = null;
  if (mode === "store" && fields.volumeId) {
    chosenVolume = isUuid(fields.volumeId) ? await resolveChosenVolumeDestination(userId, fields.volumeId) : null;
    if (!chosenVolume) {
      return result(400, { error: "That drive isn't connected right now" });
    }
  }

  // "Build a Trip": the trip's own folder is the destination, ahead of chosenVolume and
  // ORIGINALS_DIR. It's a plain folder, not a registered volume.
  let tripBaseDir: string | null = null;
  let tripId: string | null = null;
  if (mode === "store" && fields.tripId) {
    const tripRes = await pool.query<{ id: string; destination_folder: string }>(
      `SELECT id, destination_folder FROM trips WHERE id = $1 AND user_id = $2`,
      [fields.tripId, userId],
    );
    if (tripRes.rows.length === 0) {
      return result(400, { error: "Unknown trip" });
    }
    tripBaseDir = tripRes.rows[0].destination_folder;
    tripId = tripRes.rows[0].id;
  }

  // An album doesn't change where the file goes; the capture is only added to it before COMMIT.
  let albumId: string | null = null;
  if (fields.albumId) {
    const albumRes = await pool.query<{ id: string }>(`SELECT id FROM albums WHERE id = $1 AND user_id = $2`, [
      fields.albumId,
      userId,
    ]);
    if (albumRes.rows.length === 0) return result(400, { error: "Unknown album" });
    albumId = albumRes.rows[0].id;
  }

  const speciesRes = await pool.query<{
    id: string;
    common_name: string | null;
    scientific_name: string;
    taxon_class: string | null;
    family: string | null;
    aba_code: string | null;
    ebird_code: string | null;
    inat_iconic_taxon: string | null;
  }>(
    `SELECT id, common_name, scientific_name, taxon_class, family, aba_code, ebird_code, inat_iconic_taxon FROM species WHERE id = $1`,
    [speciesId],
  );
  if (speciesRes.rows.length === 0) return result(400, { error: "Unknown species" });
  const species = speciesRes.rows[0];

  // A camera RAW (or a sensor-data TIFF) as the main file.
  if (mode === "store" && photo && fileName && (await isRawFile(photo.path, fileName))) {
    const rawMarks = await readCullMarks(photo.path);
    const rawDecision = cullDecision(rawMarks, cullOption);
    if (rawDecision === "skip") return result(200, { skipped: "rejected" });
    const rawResult = await handleRawPrimaryUpload(
      { path: photo.path, sha256: photo.sha256, size: photo.size },
      fileName,
      userId,
      species,
      chosenVolume,
      tripBaseDir,
      tripId,
      { regionId, locationLabel: fields.locationLabel?.trim() || null },
      { marks: rawMarks, hidden: rawDecision === "hide" },
    );
    return result(201, { ...rawResult, hidden: rawDecision === "hide" });
  }

  // The photo as a file on disk, wherever it came from.
  let srcPath: string;
  let fingerprint: string;
  let fileSize: number;
  let originalRef: string | null = null;
  let s3Bytes: Buffer | null = null;
  let format: PhotoFormat | null;

  if (mode === "link") {
    const linkPath = fields.path;
    if (!linkPath || !path.isAbsolute(linkPath)) {
      return result(400, { error: "path must be an absolute filesystem path" });
    }
    // Same allowlist as reimport and trips: on a server only DATA_DIR and LIFER_LIBRARY_ROOTS
    // are readable (403 otherwise, checked before existence so it can't probe the disk).
    const allowedLinkPath = assertAllowedPath(linkPath);
    if (!existsSync(allowedLinkPath)) {
      return result(400, { error: "That file doesn't exist on this server" });
    }
    srcPath = allowedLinkPath;
    fingerprint = await hashFile(srcPath);
    fileSize = (await stat(srcPath)).size;
    originalRef = allowedLinkPath;
    format = await sniffPhotoFormat(srcPath);
  } else if (mode === "s3") {
    // The object is fetched only to make derivatives and read EXIF; it is never copied.
    const bucketKey = fields.bucketKey;
    if (!bucketKey) return result(400, { error: "bucketKey field is required for mode=s3" });
    try {
      s3Bytes = await fetchS3Object(bucketKey);
    } catch (err) {
      return result(400, { error: `Couldn't fetch that S3 object: ${(err as Error).message}` });
    }
    srcPath = await uploadTempPath(bucketKey, ".jpg");
    await writeFile(srcPath, s3Bytes);
    sources.push({
      path: srcPath,
      filename: null,
      mimetype: null,
      sha256: "",
      size: 0,
      origin: "multipart",
      uploadId: null,
      finish: () => rm(srcPath, { force: true }),
    });
    fingerprint = createHash("sha256").update(s3Bytes).digest("hex");
    fileSize = s3Bytes.length;
    originalRef = bucketKey;
    format = await sniffPhotoFormat(srcPath);
  } else {
    if (!photo) return result(400, { error: "No file uploaded" });
    if (!claimedPhotoFormat(fileMimetype, fileName)) return result(400, { error: UNSUPPORTED_PHOTO });
    srcPath = photo.path;
    fingerprint = photo.sha256;
    fileSize = photo.size;
    format = await sniffPhotoFormat(srcPath);
  }
  if (!format)
    return result(400, { error: mode === "store" ? UNSUPPORTED_PHOTO : "That file isn't a photo Lifer can read" });
  const photoExtension = storedPhotoExtension(format, fileName);

  if (raw && mode !== "store") {
    return result(400, { error: "rawFile is only supported for mode=store" });
  }
  const rawFileName = raw ? (raw.filename ?? null) : null;
  if (raw && (!rawFileName || !(await isRawFile(raw.path, rawFileName)))) {
    return result(400, { error: "rawFile doesn't look like a supported RAW format" });
  }

  // skipDuplicates=1: an exact copy you already have comes back as that photo (200, duplicate:
  // true) instead of a second capture, so a sync or import script can re-send files safely.
  // The app's own importer checks first via /uploads/inspect and asks instead.
  if (fields.skipDuplicates === "1") {
    const existing = await pool.query<{ id: string; current_photo_id: string | null }>(
      `SELECT id, current_photo_id FROM captures WHERE user_id = $1 AND fingerprint = $2 LIMIT 1`,
      [userId, fingerprint],
    );
    if (existing.rows[0]) {
      return result(200, {
        captureId: existing.rows[0].id,
        photoId: existing.rows[0].current_photo_id,
        duplicate: true,
      });
    }
  }

  // A verdict on the photo or on the RAW sent with it applies to both. Only the reading happens
  // here: a mark never changes or removes the file it's on.
  const marks = await readPairCullMarks(srcPath, raw?.path ?? null);
  const decision = cullDecision(marks, cullOption);
  if (decision === "skip") return result(200, { skipped: "rejected" });
  const hidden = decision === "hide";

  // exiftool reads the file where it is: a temp file, a resumable upload or a linked file.
  let exif: ExtractedExif;
  let time: CaptureTime | null;
  let exifFingerprint: ExifFingerprint;
  {
    const tags = await readExifTags(srcPath);
    exif = await extractExif(srcPath, tags);
    time = captureTimeFromTags(tags);
    // Stored so a RAW sibling indexed later can be linked to this capture (exif.ts).
    exifFingerprint = await computeExifFingerprint(srcPath, tags);
  }

  const { organizeByYear, organizeByLocation, namingStyles } = await getUserFileSettings(userId);
  const locationLabel = fields.locationLabel?.trim() || null;

  // An unlinked RAW with this photo's filename stem, verified by capture time. Looked up before
  // the transaction so file reads and exiftool never hold a pool connection.
  let filenameVerifiedRaw: { id: string; ref: string; managed: boolean } | null = null;
  if (!raw && fileName && exif.takenAt) {
    const stem = sanitizeUploadName(path.basename(fileName, path.extname(fileName))).toLowerCase();
    if (stem) {
      // The stem comparison runs in the query, as in rawMatching.ts.
      const candidates = await pool.query<{ id: string; ref: string; managed: boolean }>(
        `SELECT id, ref, managed FROM originals
         WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $1
           AND lower(regexp_replace(regexp_replace(ref, '^.*/', ''), '(-[0-9]+)?\\.[^.]+$', '')) = $2`,
        [userId, stem],
      );
      if (candidates.rows.length === 1 && existsSync(candidates.rows[0].ref)) {
        const candidateExif = await extractExif(candidates.rows[0].ref);
        if (candidateExif.takenAt && Math.abs(candidateExif.takenAt.getTime() - exif.takenAt.getTime()) <= 1000) {
          filenameVerifiedRaw = candidates.rows[0];
        }
      }
    }
  }

  // Slow file work happens before the transaction so a pool connection is only held for the
  // inserts. If the import doesn't commit, derivatives are removed and originals moved back.
  const written: string[] = [];
  const moved: Moved[] = [];
  const photoId = randomUUID();
  written.push(...derivativeFiles(photoId));
  let displayPath: string, thumbPath: string, width: number | null, height: number | null;
  // Store mode files the original in the browsable species tree. Link and s3 only remember
  // where the file already is; its bytes and metadata are never touched.
  let finalOriginalRef = originalRef;
  let managed = false;
  let rawOriginal: { dest: string; hash: string; size: number; volumeRelativePath: string | null } | null = null;
  let volumeTag: { volumeId: string | null; volumeRelativePath: string | null };
  let working: WorkingImage | null = null;
  try {
    working = await prepareWorkingImage(srcPath, format);
    ({ displayPath, thumbPath, width, height } = await generateDerivatives(working.decodePath, photoId));
    if (mode === "store") {
      const folder = originalsFolder(tripBaseDir ?? chosenVolume?.baseDir ?? ORIGINALS_DIR, {
        organizeByYear,
        organizeByLocation,
        locationLabel,
        speciesFolderName: await resolveSpeciesFolderName(userId, species.id),
        taxonClass: species.taxon_class,
        inatIconicTaxon: species.inat_iconic_taxon,
        namingStyles,
        takenAt: exif.takenAt,
        takenAtWallClock: time?.wallClock,
        subfolder: "Adjusted",
      });
      finalOriginalRef = await moveIntoLibrary(srcPath, folder, originalFilename(fileName, time, photoExtension));
      moved.push({ from: srcPath, to: finalOriginalRef });
      // Keywords, title and rating are written into the file after the import is saved
      // (syncCaptureXmpSidecars below), so the upload doesn't wait on exiftool.
      managed = true;
    }
    // A linked file is tagged with whatever registered volume it is on; a stored one only when
    // the user chose a drive. The main library is never volume-tagged.
    volumeTag =
      mode === "link" && finalOriginalRef
        ? await tagWithRegisteredVolume(userId, finalOriginalRef)
        : chosenVolume && finalOriginalRef
          ? {
              volumeId: chosenVolume.volumeId,
              volumeRelativePath: finalOriginalRef.slice(chosenVolume.mountPath.length),
            }
          : { volumeId: null, volumeRelativePath: null };

    // A RAW sent with the photo is linked directly, in the same base folder as the photo.
    if (raw && rawFileName) {
      const rawFolder = originalsFolder(tripBaseDir ?? chosenVolume?.baseDir ?? ORIGINALS_DIR, {
        organizeByYear,
        organizeByLocation,
        locationLabel,
        speciesFolderName: await resolveSpeciesFolderName(userId, species.id),
        taxonClass: species.taxon_class,
        inatIconicTaxon: species.inat_iconic_taxon,
        namingStyles,
        takenAt: exif.takenAt,
        takenAtWallClock: time?.wallClock,
        subfolder: "RAW",
      });
      const rawExt = path.extname(rawFileName).toLowerCase();
      const rawDest = await moveIntoLibrary(raw.path, rawFolder, originalFilename(rawFileName, time, rawExt));
      moved.push({ from: raw.path, to: rawDest });
      rawOriginal = {
        dest: rawDest,
        hash: raw.sha256,
        size: raw.size,
        volumeRelativePath: chosenVolume ? rawDest.slice(chosenVolume.mountPath.length) : null,
      };
    }
  } catch (err) {
    removeFiles(written);
    await moveBack(moved);
    await working?.release();
    throw err;
  }
  const refType = mode === "s3" ? "s3" : "path";

  // An already-indexed RAW this capture claims; moved into the species' RAW folder once the
  // claim has committed, so a rollback can never leave a moved file with a stale ref.
  let claimedRaw: { id: string; ref: string; managed: boolean } | null = null;
  let captureId: string;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(UPLOAD_TX_TIMEOUTS);

    const captureRes = await client.query<{ id: string }>(
      `INSERT INTO captures
         (user_id, species_id, fingerprint, exif_fingerprint, exif_fingerprint_loose, taken_at, lat, lon, camera_model, lens, focal_length_mm, aperture, shutter, iso, trip_id, region_id, location_label, quality_rating, cull_verdict, cull_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        userId,
        speciesId,
        fingerprint,
        exifFingerprint.strict,
        exifFingerprint.loose,
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
        regionId,
        locationLabel,
        exif.rating,
        marks.verdict,
        marks.label,
      ],
    );
    captureId = captureRes.rows[0].id;

    await client.query(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6)`,
      [photoId, captureId, displayPath, thumbPath, width, height],
    );

    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);

    // A hidden photo doesn't add its species to the life list until it's unhidden.
    if (!hidden) await markCollected(client, userId, speciesId, photoId, exif.takenAt);

    await client.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path)
       VALUES ($1, 'jpeg', $6, $2, $3, $4, $5, $7, $8, $9, $10)`,
      [
        captureId,
        finalOriginalRef,
        managed,
        fingerprint,
        fileSize,
        refType,
        exifFingerprint.strict,
        exifFingerprint.loose,
        volumeTag.volumeId,
        volumeTag.volumeRelativePath,
      ],
    );

    if (rawOriginal) {
      await client.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path)
         VALUES ($1, 'raw', 'path', $2, true, $3, $4, $5, $6, $7, $8)`,
        [
          captureId,
          rawOriginal.dest,
          rawOriginal.hash,
          rawOriginal.size,
          exifFingerprint.strict,
          exifFingerprint.loose,
          chosenVolume?.volumeId ?? null,
          rawOriginal.volumeRelativePath,
        ],
      );
    }

    // A RAW the scan job indexed before this photo arrived is linked now, when exactly one
    // unlinked RAW matches. Skipped when a RAW came with this request: a capture has one RAW
    // (UNIQUE (capture_id, kind)), so a stray match stays unlinked for review.
    if (!raw) {
      // Verified before the transaction; capture_id IS NULL is re-checked to close the race.
      if (filenameVerifiedRaw) {
        const res = await client.query(`UPDATE originals SET capture_id = $1 WHERE id = $2 AND capture_id IS NULL`, [
          captureId,
          filenameVerifiedRaw.id,
        ]);
        if ((res.rowCount ?? 0) === 1) claimedRaw = filenameVerifiedRaw;
      }

      if (!claimedRaw) {
        let unlinkedRaw: { id: string; ref: string; managed: boolean }[] = [];
        // Strict fingerprint, then loose, then the legacy server-zone pair (exif.ts).
        const pairs = [
          { strict: exifFingerprint.strict, loose: exifFingerprint.loose },
          ...(exifFingerprint.legacy ? [exifFingerprint.legacy] : []),
        ];
        for (const pair of pairs) {
          if (pair.strict) {
            const res = await client.query<{ id: string; ref: string; managed: boolean }>(
              `SELECT id, ref, managed FROM originals WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $2 AND exif_fingerprint = $1 LIMIT 2`,
              [pair.strict, userId],
            );
            unlinkedRaw = res.rows;
          }
          if (unlinkedRaw.length === 0 && pair.loose) {
            const res = await client.query<{ id: string; ref: string; managed: boolean }>(
              `SELECT id, ref, managed FROM originals WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $2 AND exif_fingerprint_loose = $1 LIMIT 2`,
              [pair.loose, userId],
            );
            unlinkedRaw = res.rows;
          }
          if (unlinkedRaw.length > 0) break;
        }
        if (unlinkedRaw.length === 1) {
          const match = unlinkedRaw[0];
          await client.query(`UPDATE originals SET capture_id = $1 WHERE id = $2`, [captureId, match.id]);
          claimedRaw = match;
        }
      }
    }

    if (albumId) {
      await client.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        albumId,
        captureId,
      ]);
    }

    // Last, since the rows above are written through the `captures` view, which hides it.
    if (hidden) await client.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [captureId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    removeFiles(written);
    await moveBack(moved);
    await working.release();
    throw err;
  } finally {
    client.release();
  }

  // This photo may just have become the species' cover: frame the card on the animal.
  if (!hidden) ensureDefaultCardCropLater(userId, speciesId);

  // The claimed RAW now belongs to this capture: file it in the species' RAW folder, within the
  // folder (library, drive or trip) it was filed under. If the move works but the ref can't be
  // saved, it's moved back so the stored path stays true.
  if (claimedRaw) {
    const claimed = claimedRaw;
    try {
      const move = await moveManagedOriginalToSpeciesFolder(userId, claimed.id, speciesId);
      if (move) {
        try {
          await pool.query(
            `UPDATE originals SET ref = $1, volume_relative_path = COALESCE($2, volume_relative_path) WHERE id = $3`,
            [move.to, move.volumeRelativePath, claimed.id],
          );
        } catch (err) {
          await moveToFolder(move.to, path.dirname(move.from), path.basename(move.from)).catch(() => {});
          throw err;
        }
      }
    } catch (err) {
      request.log.warn(
        { err, captureId, originalId: claimed.id },
        "Linked this capture's RAW but couldn't move it into the species folder",
      );
    }
  }

  // Writes the capture's first XMP sidecar(s) (species, EXIF, rating) in the background.
  syncCaptureXmpSidecars(userId, captureId).catch((err) =>
    request.log.warn({ err, captureId }, "Couldn't write this capture's XMP sidecar"),
  );

  // Embeddings are queued so the upload never waits on a model; a failure is left for the next
  // backfill. The queue holds a file path when there is one, and a working copy lives until its job ends.
  const removeCopy = working.detachInferenceCopy();
  const vectorSource: ImageSource = removeCopy
    ? { path: working.inferencePath }
    : mode !== "s3" && finalOriginalRef
      ? { path: finalOriginalRef }
      : s3Bytes!;
  await working.release();
  queueCaptureVectors(
    captureId,
    vectorSource,
    fingerprint,
    (err) => request.log.warn({ err, captureId }, "Couldn't compute a species-suggestion embedding for this capture"),
    removeCopy ?? undefined,
  );

  return result(201, { captureId, photoId, hidden });
}
