// Helpers shared by the upload endpoints (inspect.ts, raw.ts, photo.ts, video.ts).
import { randomUUID } from "node:crypto";
import { rmSync, existsSync } from "node:fs";
import { copyFile, link, rm, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { APP_DATA_DIR, ORIGINALS_DIR } from "../config.js";
import { ensureDir, moveToFolder } from "../lib/safeFs.js";
import { uploadTempDir } from "../lib/uploadWorkDir.js";
import { createLimiter } from "../lib/concurrency.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { photoVectors, storeCaptureEmbedding, storeIdCaptureEmbedding, type PhotoVectorKind } from "../species/embeddings.js";
import { idModel } from "../species/idModel.js";
import type { ImageSource } from "../species/inference.js";
import type { CaptureTime } from "./exif.js";
import { originalsFolder } from "./organizedPath.js";
import { resolveSpeciesFolderName, stripForbiddenNameChars } from "./speciesFolderName.js";

export type ChosenVolume = { baseDir: string; mountPath: string; volumeId: string };

// Upload file names keep trailing dots (unlike folder names): RAW/JPEG pairing compares stems
// with the names already stored, which were cleaned this way.
export const sanitizeUploadName = stripForbiddenNameChars;

// An upload transaction locks the species row until COMMIT, so these make Postgres end a stalled
// one rather than block every later upload for that species.
export const UPLOAD_TX_TIMEOUTS = `SET LOCAL idle_in_transaction_session_timeout = '2min'; SET LOCAL lock_timeout = '2min'`;

// On the library's drive (lib/uploadWorkDir.ts), so filing an upload is a rename.
export const uploadTmpDir = uploadTempDir;

/** A scratch path in the upload temp folder, keeping a sanitized extension so exiftool and sharp
 *  see the right type. */
export async function uploadTempPath(nameForExtension: string | null, fallbackExtension = ".upload"): Promise<string> {
  const dir = uploadTmpDir();
  await ensureDir(dir);
  const ext = nameForExtension ? path.extname(nameForExtension).toLowerCase() : "";
  return path.join(dir, `${randomUUID()}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : fallbackExtension}`);
}

const MAX_NAME_ATTEMPTS = 1000;

function candidateName(filename: string, attempt: number): string {
  if (attempt === 1) return filename;
  const ext = path.extname(filename);
  return `${path.basename(filename, ext)}-${attempt}${ext}`;
}

/** Files `source` into `dir` under a free name ("-2", "-3"... like writeNewFile) and returns the
 *  path used. A hard link then unlink never overwrites a file that appeared meanwhile, and is a
 *  rename in effect; on another drive (or a filesystem without links) it copies exclusively. */
export async function moveIntoLibrary(source: string, dir: string, filename: string): Promise<string> {
  await ensureDir(dir);
  for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS; attempt++) {
    const candidate = path.join(dir, candidateName(filename, attempt));
    try {
      await link(source, candidate);
      await unlink(source);
      return candidate;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EOPNOTSUPP" && code !== "EMLINK") throw err;
    }
    try {
      await copyFile(source, candidate, constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
      await rm(candidate, { force: true }).catch(() => {});
      throw err;
    }
    await rm(source, { force: true });
    return candidate;
  }
  throw new Error(`Couldn't find a free file name for ${filename} in ${dir}`);
}

/** The browser-supplied filename (sanitized) when there is one, else a date-based name. The date
 *  is the camera's own wall-clock day, so it agrees with the year folder in any server zone. */
export function originalFilename(uploadedName: string | null, time: CaptureTime | null, extension: string): string {
  if (uploadedName) {
    const base = sanitizeUploadName(path.basename(uploadedName, path.extname(uploadedName)));
    if (base) return `${base}${extension}`;
  }
  const datePart = time ? time.wallClock.slice(0, 10) : "undated";
  return `${datePart}-${randomUUID().slice(0, 8)}${extension}`;
}

// Vectors for a just-imported photo are computed after the response, a few at a time. Waiting
// jobs hold a file path rather than bytes where they can, so a big import stays out of memory.
const COMMIT_VECTOR_CONCURRENCY = 2;
const commitVectorLimit = createLimiter(COMMIT_VECTOR_CONCURRENCY);
// Photos with no file to read (S3, a RAW's embedded preview) wait holding their bytes: capped.
const MAX_BUFFERED_COMMIT_BYTES = 256 * 1024 * 1024;
let bufferedCommitBytes = 0;

/** `onDone` runs once the job is over either way, e.g. to remove a working copy it read. */
export function queueCaptureVectors(captureId: string, image: ImageSource, key: string, onError: (err: unknown) => void, onDone?: () => void): void {
  const heldBytes = "path" in image ? 0 : image.byteLength;
  if (heldBytes > 0 && bufferedCommitBytes + heldBytes > MAX_BUFFERED_COMMIT_BYTES) {
    // Left for the next backfill (server start or model download), like a failed computation.
    onError(new Error("Too many imported photos are waiting for species-matching vectors"));
    onDone?.();
    return;
  }
  bufferedCommitBytes += heldBytes;
  commitVectorLimit(async () => {
    try {
      const kinds: PhotoVectorKind[] = idModel.isDownloaded() ? ["clip", "id-crop"] : ["clip"];
      // Both in one job (one read and decode); storeIdCaptureEmbedding then reuses the second.
      const { vectors } = photoVectors(image, { kinds, key, priority: "commit" });
      await storeCaptureEmbedding(pool, captureId, await vectors.clip);
      await storeIdCaptureEmbedding(pool, captureId, image, { key, priority: "commit" });
    } finally {
      bufferedCommitBytes -= heldBytes;
    }
  })
    .catch(onError)
    .finally(() => onDone?.());
}

/** Files a Lifer-managed original into its species' RAW or Adjusted folder after it was linked
 *  to a capture. A file Lifer doesn't manage (managed=false) is never moved. Returns the new
 *  path, or the old one when nothing moved. */
export async function moveManagedOriginalToSpeciesFolder(
  currentRef: string,
  managed: boolean,
  userId: string,
  speciesId: string,
  kind: "raw" | "jpeg",
  organizeByYear: boolean,
  taxonClass: string | null,
  takenAt: Date | null,
  /** The file's own wall-clock capture time when known (see originalsFolder). */
  takenAtWallClock: string | null = null,
): Promise<string> {
  if (!managed || !existsSync(currentRef)) return currentRef;
  const folder = originalsFolder(ORIGINALS_DIR, {
    organizeByYear,
    speciesFolderName: await resolveSpeciesFolderName(userId, speciesId),
    taxonClass,
    takenAt,
    subfolder: kind === "raw" ? "RAW" : "Adjusted",
    takenAtWallClock,
  });
  const sourceDir = path.dirname(currentRef);
  // Already filed in the right folder: moving it would only rename it to "-2".
  if (path.resolve(sourceDir) === path.resolve(folder)) return currentRef;
  const dest = await moveToFolder(currentRef, folder);
  // Removes the emptied RAW/Adjusted folder and then the species folder, never the shared
  // taxon, year and location folders above them. Best effort.
  await removeEmptyDirsUpward(sourceDir, path.dirname(path.dirname(sourceDir))).catch(() => {});
  return dest;
}

// Every file generateDerivatives can write for a photo, so a failed import removes a partial set.
export function derivativeFiles(photoId: string): string[] {
  return ["display", "thumb", "medium"].map((dir) => path.join(APP_DATA_DIR, dir, `${photoId}.webp`));
}

export function removeFiles(files: string[]): void {
  for (const f of files) rmSync(f, { force: true });
}
