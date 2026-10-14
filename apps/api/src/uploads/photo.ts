// POST /uploads: imports one photo under a species. mode=store files it in Lifer's library
// (optionally with its RAW sibling), mode=link references a file already on this server.
// A stored photo arrives as a `file` part, a `stagedId` or an `uploadId`; files are never held in memory.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import type { PoolClient } from "pg";
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
import {
  claimedPhotoFormat,
  isRawFile,
  sniffPhotoFormat,
  storedPhotoExtension,
  type PhotoFormat,
} from "@lifer/core/uploads/formats.js";
import { tagWithRegisteredVolume, resolveChosenVolumeDestination } from "../storageVolumes/resolve.js";
import { assertAllowedPath } from "@lifer/core/lib/allowedPaths.js";
import { moveToFolder } from "@lifer/core/lib/safeFs.js";
import { hashFile, moveFile } from "../lib/stagedUploads.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";
import { isUuid } from "../lib/validate.js";
import { replies, withSchemas } from "../lib/schema.js";
import { UploadResponses } from "./responses.js";
import { markCollected } from "../lib/userSpecies.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import type { ImageSource } from "@lifer/core/species/inference.js";
import { handleRawPrimaryUpload } from "./raw.js";
import { CULL_MARKS_OPTIONS, type CullMarks, type CullMarksOption } from "@lifer/shared";
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
  type ChosenVolume,
} from "./common.js";
import { moveManagedOriginalToSpeciesFolder, speciesFolder, type Subfolder } from "./managedFolders.js";
import { insertCapture, insertOriginal } from "./captureRows.js";

type UploadMode = "store" | "link";

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
  app.post(
    "/uploads",
    {
      preValidation: requireScope("photos.write"),
      schema: { response: { ...replies(UploadResponses[201], 201), 200: UploadResponses[200] } },
    },
    async (request, reply) => {
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
      // Any of the route's answers, each serialized through its status's schema.
      return reply.code(outcome.code).send(outcome.body as never);
    },
  );
}

type ImportResult = { code: number; body: unknown };
const result = (code: number, body: unknown): ImportResult => ({ code, body });

type SpeciesRow = {
  id: string;
  common_name: string | null;
  scientific_name: string;
  taxon_class: string | null;
  family: string | null;
};

/** Where an import files the photo and what it attaches it to, from the request's fields. */
interface ImportTarget {
  userId: string;
  mode: UploadMode;
  species: SpeciesRow;
  regionId: string | null;
  tripId: string | null;
  /** A trip's own folder: the destination ahead of chosenVolume and ORIGINALS_DIR. */
  tripBaseDir: string | null;
  chosenVolume: ChosenVolume | null;
  albumId: string | null;
  locationLabel: string | null;
}

/** The photo as a file on disk, wherever it came from. */
interface PhotoSource {
  path: string;
  fingerprint: string;
  fileSize: number;
  format: PhotoFormat;
  /** The uploaded file's name (store mode); the stored file is named after it. */
  fileName: string | null;
}

/** What the file reads gave: capture time, camera settings and the EXIF pair RAWs match on. */
interface PhotoMetadata {
  exif: ExtractedExif;
  time: CaptureTime | null;
  exifFingerprint: ExifFingerprint;
  marks: CullMarks;
  hidden: boolean;
}

type RawRef = { id: string; ref: string; managed: boolean };

/** Files written or moved before the transaction, and how to undo them. */
interface PreparedFiles {
  photoId: string;
  derivatives: { displayPath: string; thumbPath: string; width: number | null; height: number | null };
  /** Where the original is now: filed in the library (store) or where it already was (link). */
  originalRef: string;
  managed: boolean;
  volumeTag: { volumeId: string | null; volumeRelativePath: string | null };
  raw: { dest: string; hash: string; size: number; volumeRelativePath: string | null } | null;
  working: WorkingImage;
  written: string[];
  moved: Moved[];
}

async function undoPreparedFiles(files: Pick<PreparedFiles, "written" | "moved">, working: WorkingImage | null) {
  removeFiles(files.written);
  await moveBack(files.moved);
  await working?.release();
}

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
  if (fields.mode && fields.mode !== "store" && fields.mode !== "link") {
    return result(400, { error: "mode must be store or link" });
  }
  const mode: UploadMode = fields.mode === "link" ? "link" : "store";
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

  const speciesRes = await pool.query<SpeciesRow>(
    `SELECT id, common_name, scientific_name, taxon_class, family FROM species WHERE id = $1`,
    [speciesId],
  );
  if (speciesRes.rows.length === 0) return result(400, { error: "Unknown species" });
  const target: ImportTarget = {
    userId,
    mode,
    species: speciesRes.rows[0],
    regionId,
    tripId,
    tripBaseDir,
    chosenVolume,
    albumId,
    locationLabel: fields.locationLabel?.trim() || null,
  };

  // A camera RAW (or a sensor-data TIFF) as the main file.
  if (mode === "store" && photo && fileName && (await isRawFile(photo.path, fileName))) {
    const rawMarks = await readCullMarks(photo.path);
    const rawDecision = cullDecision(rawMarks, cullOption);
    if (rawDecision === "skip") return result(200, { skipped: "rejected" });
    const rawResult = await handleRawPrimaryUpload(
      { path: photo.path, sha256: photo.sha256, size: photo.size },
      fileName,
      userId,
      target.species,
      chosenVolume,
      tripBaseDir,
      tripId,
      { regionId, locationLabel: target.locationLabel },
      { marks: rawMarks, hidden: rawDecision === "hide" },
    );
    return result(201, { ...rawResult, hidden: rawDecision === "hide" });
  }

  const source = await resolveSource(mode, fields, photo, fileName, fileMimetype);
  if ("code" in source) return source;

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
      [userId, source.fingerprint],
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
  const marks = await readPairCullMarks(source.path, raw?.path ?? null);
  const decision = cullDecision(marks, cullOption);
  if (decision === "skip") return result(200, { skipped: "rejected" });

  // exiftool reads the file where it is: a temp file, a resumable upload or a linked file.
  const tags = await readExifTags(source.path);
  const meta: PhotoMetadata = {
    exif: await extractExif(source.path, tags),
    time: captureTimeFromTags(tags),
    // Stored so a RAW sibling indexed later can be linked to this capture (exif.ts).
    exifFingerprint: await computeExifFingerprint(source.path, tags),
    marks,
    hidden: decision === "hide",
  };

  // Looked up before the transaction so file reads and exiftool never hold a pool connection.
  const filenameVerifiedRaw = raw ? null : await findFilenameVerifiedRaw(userId, source.fileName, meta.exif.takenAt);

  const files = await prepareFiles(target, source, meta, raw && rawFileName ? { file: raw, name: rawFileName } : null);
  const { captureId, claimedRaw } = await insertCaptureTx(target, source, meta, files, {
    rawSent: raw !== null,
    filenameVerifiedRaw,
  });
  await afterCommit(request.log, target, meta, files, captureId, claimedRaw, source.fingerprint);
  return result(201, { captureId, photoId: files.photoId, hidden: meta.hidden });
}

/** The photo on disk: the linked file itself (link) or the received upload (store). */
async function resolveSource(
  mode: UploadMode,
  fields: Record<string, string>,
  photo: ReceivedFile | null,
  fileName: string | null,
  fileMimetype: string | null,
): Promise<PhotoSource | ImportResult> {
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
    const format = await sniffPhotoFormat(allowedLinkPath);
    if (!format) return result(400, { error: "That file isn't a photo Lifer can read" });
    return {
      path: allowedLinkPath,
      fingerprint: await hashFile(allowedLinkPath),
      fileSize: (await stat(allowedLinkPath)).size,
      format,
      fileName: null,
    };
  }
  if (!photo) return result(400, { error: "No file uploaded" });
  if (!claimedPhotoFormat(fileMimetype, fileName)) return result(400, { error: UNSUPPORTED_PHOTO });
  const format = await sniffPhotoFormat(photo.path);
  if (!format) return result(400, { error: UNSUPPORTED_PHOTO });
  return { path: photo.path, fingerprint: photo.sha256, fileSize: photo.size, format, fileName };
}

/** An unlinked RAW with this photo's filename stem, verified by capture time. */
async function findFilenameVerifiedRaw(
  userId: string,
  fileName: string | null,
  takenAt: Date | null,
): Promise<RawRef | null> {
  if (!fileName || !takenAt) return null;
  const stem = sanitizeUploadName(path.basename(fileName, path.extname(fileName))).toLowerCase();
  if (!stem) return null;
  // The stem comparison runs in the query, as in rawMatching.ts.
  const candidates = await pool.query<RawRef>(
    `SELECT id, ref, managed FROM originals
     WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $1
       AND lower(regexp_replace(regexp_replace(ref, '^.*/', ''), '(-[0-9]+)?\\.[^.]+$', '')) = $2`,
    [userId, stem],
  );
  if (candidates.rows.length !== 1 || !existsSync(candidates.rows[0].ref)) return null;
  const candidateExif = await extractExif(candidates.rows[0].ref);
  if (candidateExif.takenAt && Math.abs(candidateExif.takenAt.getTime() - takenAt.getTime()) <= 1000) {
    return candidates.rows[0];
  }
  return null;
}

/** Slow file work, before the transaction so a pool connection is only held for the inserts:
 *  derivatives, and in store mode the photo (and any RAW sent with it) filed in the species tree.
 *  Undone (derivatives removed, files moved back) if anything here fails. */
async function prepareFiles(
  target: ImportTarget,
  source: PhotoSource,
  meta: PhotoMetadata,
  raw: { file: ReceivedFile; name: string } | null,
): Promise<PreparedFiles> {
  const photoId = randomUUID();
  const undo = { written: derivativeFiles(photoId), moved: [] as Moved[] };
  let working: WorkingImage | null = null;
  try {
    working = await prepareWorkingImage(source.path, source.format);
    const { displayPath, thumbPath, width, height } = await generateDerivatives(working.decodePath, photoId);
    const { chosenVolume } = target;
    // Link mode only remembers where the file already is; its bytes and metadata are never touched.
    let originalRef = source.path;
    let managed = false;
    let rawFiled: PreparedFiles["raw"] = null;
    if (target.mode === "store") {
      const base = target.tripBaseDir ?? chosenVolume?.baseDir ?? ORIGINALS_DIR;
      const settings = await getUserFileSettings(target.userId);
      const folderFor = (subfolder: Subfolder) =>
        speciesFolder(target.userId, target.species.id, base, folderOptions(subfolder, target, meta), settings);
      const photoExtension = storedPhotoExtension(source.format, source.fileName);
      originalRef = await moveIntoLibrary(
        source.path,
        await folderFor("Adjusted"),
        originalFilename(source.fileName, meta.time, photoExtension),
      );
      undo.moved.push({ from: source.path, to: originalRef });
      // Keywords, title and rating are written into the file after the import is saved
      // (syncCaptureXmpSidecars in afterCommit), so the upload doesn't wait on exiftool.
      managed = true;

      // A RAW sent with the photo is linked directly, in the same base folder as the photo.
      if (raw) {
        const rawExt = path.extname(raw.name).toLowerCase();
        const rawDest = await moveIntoLibrary(
          raw.file.path,
          await folderFor("RAW"),
          originalFilename(raw.name, meta.time, rawExt),
        );
        undo.moved.push({ from: raw.file.path, to: rawDest });
        rawFiled = {
          dest: rawDest,
          hash: raw.file.sha256,
          size: raw.file.size,
          volumeRelativePath: chosenVolume ? rawDest.slice(chosenVolume.mountPath.length) : null,
        };
      }
    }
    // A linked file is tagged with whatever registered volume it is on; a stored one only when
    // the user chose a drive. The main library is never volume-tagged.
    const volumeTag =
      target.mode === "link"
        ? await tagWithRegisteredVolume(target.userId, originalRef)
        : chosenVolume
          ? { volumeId: chosenVolume.volumeId, volumeRelativePath: originalRef.slice(chosenVolume.mountPath.length) }
          : { volumeId: null, volumeRelativePath: null };
    return {
      photoId,
      derivatives: { displayPath, thumbPath, width, height },
      originalRef,
      managed,
      volumeTag,
      raw: rawFiled,
      working,
      ...undo,
    };
  } catch (err) {
    await undoPreparedFiles(undo, working);
    throw err;
  }
}

function folderOptions(subfolder: Subfolder, target: ImportTarget, meta: PhotoMetadata) {
  return {
    subfolder,
    takenAt: meta.exif.takenAt,
    wallClock: meta.time?.wallClock,
    locationLabel: target.locationLabel,
    // A trip folder never gets the location layer, as trip imports file it.
    allowLocation: !target.tripBaseDir,
  };
}

/** Links an unlinked RAW to the capture. capture_id IS NULL is re-checked here, so of two
 *  imports racing for one RAW only the first gets it. */
async function claimRaw(client: PoolClient, captureId: string, raw: RawRef): Promise<boolean> {
  const res = await client.query(`UPDATE originals SET capture_id = $1 WHERE id = $2 AND capture_id IS NULL`, [
    captureId,
    raw.id,
  ]);
  return (res.rowCount ?? 0) === 1;
}

/** The single unlinked RAW whose EXIF fingerprint matches: strict, then loose, then the legacy
 *  server-zone pair (exif.ts). None when nothing or more than one matches. */
async function findFingerprintRaw(
  client: PoolClient,
  userId: string,
  fingerprint: ExifFingerprint,
): Promise<RawRef | null> {
  const pairs = [
    { strict: fingerprint.strict, loose: fingerprint.loose },
    ...(fingerprint.legacy ? [fingerprint.legacy] : []),
  ];
  for (const pair of pairs) {
    let found: RawRef[] = [];
    if (pair.strict) {
      const res = await client.query<RawRef>(
        `SELECT id, ref, managed FROM originals WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $2 AND exif_fingerprint = $1 LIMIT 2`,
        [pair.strict, userId],
      );
      found = res.rows;
    }
    if (found.length === 0 && pair.loose) {
      const res = await client.query<RawRef>(
        `SELECT id, ref, managed FROM originals WHERE kind = 'raw' AND capture_id IS NULL AND user_id = $2 AND exif_fingerprint_loose = $1 LIMIT 2`,
        [pair.loose, userId],
      );
      found = res.rows;
    }
    if (found.length > 0) return found.length === 1 ? found[0] : null;
  }
  return null;
}

/** The capture, its photo, originals, album membership and any RAW it claims, in one
 *  transaction. A failure undoes the file work too. */
async function insertCaptureTx(
  target: ImportTarget,
  source: PhotoSource,
  meta: PhotoMetadata,
  files: PreparedFiles,
  rawLinking: { rawSent: boolean; filenameVerifiedRaw: RawRef | null },
): Promise<{ captureId: string; claimedRaw: RawRef | null }> {
  const { userId, species } = target;
  // Connected inside the try, so a failed connect still undoes the file work.
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query(UPLOAD_TX_TIMEOUTS);

    const captureId = await insertCapture(client, {
      userId,
      speciesId: species.id,
      fingerprint: source.fingerprint,
      exifFingerprint: meta.exifFingerprint,
      exif: meta.exif,
      tripId: target.tripId,
      regionId: target.regionId,
      locationLabel: target.locationLabel,
      cull: meta.marks,
    });

    const { displayPath, thumbPath, width, height } = files.derivatives;
    await client.query(
      `INSERT INTO photos (id, capture_id, display_path, thumb_path, width, height) VALUES ($1,$2,$3,$4,$5,$6)`,
      [files.photoId, captureId, displayPath, thumbPath, width, height],
    );

    await client.query(`UPDATE captures SET current_photo_id = $1 WHERE id = $2`, [files.photoId, captureId]);

    // A hidden photo doesn't add its species to the life list until it's unhidden.
    if (!meta.hidden) await markCollected(client, userId, species.id, files.photoId, meta.exif.takenAt);

    await insertOriginal(client, {
      userId,
      captureId,
      kind: "jpeg",
      ref: files.originalRef,
      managed: files.managed,
      contentHash: source.fingerprint,
      fileSize: source.fileSize,
      exifFingerprint: meta.exifFingerprint,
      ...files.volumeTag,
    });

    if (files.raw) {
      await insertOriginal(client, {
        userId,
        captureId,
        kind: "raw",
        ref: files.raw.dest,
        managed: true,
        contentHash: files.raw.hash,
        fileSize: files.raw.size,
        exifFingerprint: meta.exifFingerprint,
        volumeId: target.chosenVolume?.volumeId ?? null,
        volumeRelativePath: files.raw.volumeRelativePath,
      });
    }

    // A RAW the scan job indexed before this photo arrived is linked now, when exactly one
    // unlinked RAW matches. Skipped when a RAW came with this request: a capture has one RAW
    // (UNIQUE (capture_id, kind)), so a stray match stays unlinked for review.
    let claimedRaw: RawRef | null = null;
    if (!rawLinking.rawSent) {
      const byName = rawLinking.filenameVerifiedRaw;
      if (byName && (await claimRaw(client, captureId, byName))) claimedRaw = byName;
      if (!claimedRaw) {
        const byFingerprint = await findFingerprintRaw(client, userId, meta.exifFingerprint);
        if (byFingerprint && (await claimRaw(client, captureId, byFingerprint))) claimedRaw = byFingerprint;
      }
    }

    if (target.albumId) {
      await client.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        target.albumId,
        captureId,
      ]);
    }

    // Last, since the rows above are written through the `captures` view, which hides it.
    if (meta.hidden) await client.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [captureId]);

    await client.query("COMMIT");
    return { captureId, claimedRaw };
  } catch (err) {
    await client?.query("ROLLBACK").catch(() => {});
    await undoPreparedFiles(files, files.working);
    throw err;
  } finally {
    client?.release();
  }
}

/** Background work once the import is saved: the card crop, filing a claimed RAW, the XMP
 *  sidecar and species-matching vectors. None of it fails the import. */
async function afterCommit(
  log: FastifyBaseLogger,
  target: ImportTarget,
  meta: PhotoMetadata,
  files: PreparedFiles,
  captureId: string,
  claimedRaw: RawRef | null,
  fingerprint: string,
): Promise<void> {
  const { userId, species } = target;
  // This photo may just have become the species' cover: frame the card on the animal.
  if (!meta.hidden) ensureDefaultCardCropLater(userId, species.id);

  // The claimed RAW now belongs to this capture: file it in the species' RAW folder, within the
  // folder (library, drive or trip) it was filed under. If the move works but the ref can't be
  // saved, it's moved back so the stored path stays true.
  if (claimedRaw) {
    try {
      const move = await moveManagedOriginalToSpeciesFolder(userId, claimedRaw.id, species.id);
      if (move) {
        try {
          await pool.query(
            `UPDATE originals SET ref = $1, volume_relative_path = COALESCE($2, volume_relative_path) WHERE id = $3`,
            [move.to, move.volumeRelativePath, claimedRaw.id],
          );
        } catch (err) {
          await moveToFolder(move.to, path.dirname(move.from), path.basename(move.from)).catch(() => {});
          throw err;
        }
      }
    } catch (err) {
      log.warn(
        { err, captureId, originalId: claimedRaw.id },
        "Linked this capture's RAW but couldn't move it into the species folder",
      );
    }
  }

  // Writes the capture's first XMP sidecar(s) (species, EXIF, rating) in the background.
  syncCaptureXmpSidecars(userId, captureId).catch((err) =>
    log.warn({ err, captureId }, "Couldn't write this capture's XMP sidecar"),
  );

  // Embeddings are queued so the upload never waits on a model; a failure is left for the next
  // backfill. The queue holds a file path, and a working copy lives until its job ends.
  const { working } = files;
  const removeCopy = working.detachInferenceCopy();
  const vectorSource: ImageSource = { path: removeCopy ? working.inferencePath : files.originalRef };
  await working.release();
  queueCaptureVectors(
    captureId,
    files.photoId,
    vectorSource,
    fingerprint,
    (err) => log.warn({ err, captureId }, "Couldn't compute a species-suggestion embedding for this capture"),
    removeCopy ?? undefined,
  );
}
