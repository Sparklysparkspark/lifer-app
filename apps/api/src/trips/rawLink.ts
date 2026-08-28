// RAW-sibling auto-linking for Trips — same filename-stem + EXIF-timestamp matching rule as
// the main library's own upload flow (uploads/routes.ts's processOneRawUpload) and the
// library reimport tool (library/reimport.ts's recoverRaw): a RAW is only ever linked when
// its stem matches a JPEG's exactly AND its own DateTimeOriginal agrees with that capture's
// taken_at within 1000ms. No fingerprint fallback — same deliberately-deferred scope as those
// two — an unmatched RAW is simply never linked rather than guessed at.
//
// A trip's RAW files are never "new files" the review UI asks about (no species to assign —
// a RAW is a sibling to a JPEG, not a capture of its own), so this lives separately from
// scan.ts's listCandidateFiles/findNewFiles, which are scoped to what SHOULD be reviewed.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { extractExif, readExifTags } from "../uploads/exif.js";
import { computeFileFingerprint } from "../uploads/fileFingerprint.js";
import { RAW_EXTENSIONS } from "../uploads/rawExtensions.js";
import { tagWithRegisteredVolume } from "../storageVolumes/resolve.js";

export interface RawCandidate {
  relativePath: string;
  absolutePath: string;
}

// Same recursive, depth-agnostic walk as scan.ts's listCandidateFiles — works whether RAWs
// live in a "RAW" subfolder alongside "Adjusted" (the suggested convention, see TripsPage's
// own info tip) or anywhere else in the trip folder.
export function listRawFiles(sourceFolder: string): RawCandidate[] {
  const results: RawCandidate[] = [];
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolutePath);
      } else if (RAW_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push({ relativePath: path.relative(sourceFolder, absolutePath), absolutePath });
      }
    }
  }
  walk(sourceFolder);
  return results;
}

function stemOf(filename: string): string {
  return path
    .basename(filename, path.extname(filename))
    .replace(/[/\\:*?"<>|]/g, "")
    .trim()
    .toLowerCase();
}

// Tries to find and link a RAW sibling for one specific capture — called right after a JPEG
// import commits (import.ts) and again for every already-imported capture on each rescan
// (scan.ts's autoLinkMissingRaws), so a RAW added to the folder after its JPEG was already
// imported still gets picked up. Returns whether a link was made.
export async function linkRawForCapture(captureId: string, jpegFileName: string, takenAt: Date | null, sourceFolder: string): Promise<boolean> {
  if (!takenAt) return false;
  const already = await pool.query(`SELECT 1 FROM originals WHERE capture_id = $1 AND kind = 'raw' LIMIT 1`, [captureId]);
  if (already.rows.length > 0) return false;

  const stem = stemOf(jpegFileName);
  if (!stem) return false;
  const matches = listRawFiles(sourceFolder).filter((r) => stemOf(r.relativePath) === stem);
  if (matches.length !== 1) return false;

  const candidate = matches[0];
  const tags = await readExifTags(candidate.absolutePath);
  const exif = await extractExif(candidate.absolutePath, tags);
  if (!exif.takenAt || Math.abs(exif.takenAt.getTime() - takenAt.getTime()) > 1000) return false;

  const { contentHash, exifFingerprint } = await computeFileFingerprint(candidate.absolutePath, tags);
  const fileSize = statSync(candidate.absolutePath).size;
  // Looked up rather than threaded through both call sites (import.ts already has it in
  // scope, but scan.ts's autoLinkMissingRaws sweep doesn't) — cheap, and this function is
  // never called at a volume without a real, already-committed capture behind it.
  const ownerRes = await pool.query<{ user_id: string }>(`SELECT user_id FROM captures WHERE id = $1`, [captureId]);
  const volumeTag = ownerRes.rows[0]
    ? await tagWithRegisteredVolume(ownerRes.rows[0].user_id, candidate.absolutePath)
    : { volumeId: null, volumeRelativePath: null };
  // managed=false, ref=the file's own real path — a trip's RAW is exactly as external as its
  // JPEG sibling, never copied or moved (same convention as import.ts's own JPEG insert).
  await pool.query(
    `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose, volume_id, volume_relative_path)
     VALUES ($1, 'raw', 'path', $2, false, $3, $4, $5, $6, $7, $8)`,
    [
      captureId,
      candidate.absolutePath,
      contentHash,
      fileSize,
      exifFingerprint.strict,
      exifFingerprint.loose,
      volumeTag.volumeId,
      volumeTag.volumeRelativePath,
    ],
  );
  return true;
}

// Sweeps every capture in this trip that has a JPEG but no RAW yet — catches a RAW dropped
// into the folder after its JPEG sibling was already imported, on the next rescan.
export async function autoLinkMissingRaws(tripId: string, sourceFolder: string): Promise<number> {
  const res = await pool.query<{ id: string; taken_at: string | null; jpeg_ref: string }>(
    `SELECT c.id, c.taken_at, o.ref AS jpeg_ref
     FROM captures c
     JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
     WHERE c.trip_id = $1
       AND NOT EXISTS (SELECT 1 FROM originals ro WHERE ro.capture_id = c.id AND ro.kind = 'raw')`,
    [tripId],
  );
  let linked = 0;
  for (const row of res.rows) {
    const ok = await linkRawForCapture(row.id, path.basename(row.jpeg_ref), row.taken_at ? new Date(row.taken_at) : null, sourceFolder);
    if (ok) linked++;
  }
  return linked;
}
