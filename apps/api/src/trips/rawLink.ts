// Links a trip's RAW files to their JPEG captures by the same rule as uploads and the library
// reimport: exact file stem and DateTimeOriginal within 1000ms of taken_at. No fingerprint
// fallback, so an unmatched RAW stays unlinked. RAWs are never offered for species review.
import { statSync } from "node:fs";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { extractExif, readExifTags } from "../uploads/exif.js";
import { computeFileFingerprint } from "../uploads/fileFingerprint.js";
import { isRawExtension, isRawFile } from "@lifer/core/uploads/formats.js";
import { tagWithRegisteredVolume } from "../storageVolumes/resolve.js";
import { insertOriginal } from "../uploads/captureRows.js";
import { walkFiles } from "../library/walkFiles.js";

export interface RawCandidate {
  relativePath: string;
  absolutePath: string;
}

// Recursive walk, so RAWs are found in a "RAW" subfolder or anywhere else in the trip folder.
export async function listRawFiles(sourceFolder: string): Promise<RawCandidate[]> {
  const results: RawCandidate[] = [];
  for await (const { absolutePath, name } of walkFiles(sourceFolder)) {
    if (isRawExtension(name)) results.push({ relativePath: path.relative(sourceFolder, absolutePath), absolutePath });
  }
  // A TIFF is a RAW only when it holds sensor data (uploads/formats.ts); an edited TIFF is a photo.
  const raws: RawCandidate[] = [];
  for (const r of results) if (await isRawFile(r.absolutePath).catch(() => false)) raws.push(r);
  return raws;
}

export function stemOf(filename: string): string {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[/\\:*?"<>|]/g, "")
    .trim()
    .toLowerCase();
}

// Links a RAW sibling to one capture, after its import and again on each rescan, so a RAW added
// later is still picked up. Returns whether a link was made.
export async function linkRawForCapture(
  captureId: string,
  jpegFileName: string,
  takenAt: Date | null,
  sourceFolder: string,
  // true when Lifer copied the RAW there itself (a trip's sorted copies), so it's Lifer's to manage.
  managed = false,
): Promise<boolean> {
  if (!takenAt) return false;
  const already = await pool.query(`SELECT 1 FROM originals WHERE capture_id = $1 AND kind = 'raw' LIMIT 1`, [
    captureId,
  ]);
  if (already.rows.length > 0) return false;

  const stem = stemOf(jpegFileName);
  if (!stem) return false;
  const matches = (await listRawFiles(sourceFolder)).filter((r) => stemOf(r.relativePath) === stem);
  if (matches.length !== 1) return false;

  const candidate = matches[0];
  const tags = await readExifTags(candidate.absolutePath);
  const exif = await extractExif(candidate.absolutePath, tags);
  if (!exif.takenAt || Math.abs(exif.takenAt.getTime() - takenAt.getTime()) > 1000) return false;

  const { contentHash, exifFingerprint } = await computeFileFingerprint(candidate.absolutePath, tags);
  const fileSize = statSync(candidate.absolutePath).size;
  // captures_all: a hidden capture gets its RAW too (autoLinkMissingRaws).
  const ownerRes = await pool.query<{ user_id: string }>(`SELECT user_id FROM captures_all WHERE id = $1`, [captureId]);
  const userId = ownerRes.rows[0]?.user_id;
  if (!userId) return false;
  const volumeTag = await tagWithRegisteredVolume(userId, candidate.absolutePath);
  // Referenced in place like the trip's JPEGs, unless Lifer made the copy.
  await insertOriginal(pool, {
    userId,
    captureId,
    kind: "raw",
    ref: candidate.absolutePath,
    managed,
    contentHash,
    fileSize,
    exifFingerprint,
    ...volumeTag,
  });
  return true;
}

// Tries to link a RAW for every capture in this trip that has a JPEG but no RAW yet, hidden ones
// included (captures_all), so unhiding a photo finds its RAW already there.
export async function autoLinkMissingRaws(tripId: string, sourceFolder: string): Promise<number> {
  const res = await pool.query<{ id: string; taken_at: string | null; jpeg_ref: string }>(
    `SELECT c.id, c.taken_at, o.ref AS jpeg_ref
     FROM captures_all c
     JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
     WHERE c.trip_id = $1 AND c.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')`,
    [tripId],
  );
  let linked = 0;
  for (const row of res.rows) {
    const ok = await linkRawForCapture(
      row.id,
      path.basename(row.jpeg_ref),
      row.taken_at ? new Date(row.taken_at) : null,
      sourceFolder,
    );
    if (ok) linked++;
  }
  return linked;
}
