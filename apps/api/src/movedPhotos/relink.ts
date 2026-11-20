// Quiet relinking: finds photos whose files are missing, looks for them in the places photos live
// and updates where Lifer thinks they are. Lifer never moves, renames, writes or deletes the
// user's files here. A unique match (same size and quick hash, or the same file by inode) is
// relinked with no dialog and recorded in a batch Undo can reverse. Anything less certain goes to
// review: several candidates, or a file that was probably edited in place.
import { existsSync, realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as yieldToLoop, setTimeout as sleep } from "node:timers/promises";
import { pool } from "@lifer/core/db.js";
import { DATA_DIR, SINGLE_USER_MODE } from "@lifer/core/config.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";
import { log } from "@lifer/core/lib/log.js";
import { createJob, runningJobNames, type JobContext } from "../lib/job.js";
import { computeContentHash } from "../uploads/fileFingerprint.js";
import { computeExifFingerprint } from "../uploads/exif.js";
import { resolveOriginalPaths, tagWithRegisteredVolume, type VolumeTag } from "../storageVolumes/resolve.js";
import { listWatchedFolders } from "../library/watchedFolders.js";
import { isTripBusy } from "../trips/jobs.js";
import { findUnderNewRoot, loadTrip, movingTripId, onDisk, tripOriginals } from "../trips/moveFiles.js";
import { fingerprintFile, identityOf, quickHash } from "./fingerprint.js";
import { walkPlaces, type WalkStats } from "./walk.js";

const BATCH = 500;
// Enough for any one move; a whole drive's worth more is picked up by the next pass.
const MAX_MISSING = 20_000;
// Candidate reads per second: gentle on a network share or a spinning drive.
const READS_PER_SECOND = 200;
// Jobs that rewrite many stored paths at once; a pass waits for the next time instead.
const BUSY_JOBS = /^(storage-move|reorganize-originals|refile-originals|library-reimport)/;
const foldCase = process.platform !== "linux";
const key = (p: string) => (foldCase ? p.toLowerCase() : p);

export interface PassResult {
  missing: number;
  relinked: number;
  review: number;
  proposals: number;
  batchId: string | null;
  unreadableFolders: number;
  walk: WalkStats | null;
  /** The longest the event loop waited during the pass, in ms. */
  maxLagMs: number;
}

interface Extra {
  manual: boolean;
  userId: string | null;
  tripId: string | null;
}

export const movedPhotosJob = createJob<PassResult, Extra>("moved-photos", {
  manual: false,
  userId: null,
  tripId: null,
});
export const fingerprintJob = createJob<number>("moved-photos-fingerprints");

interface Missing {
  id: string;
  captureId: string | null;
  /** Where the file was, resolved on its drive. */
  ref: string;
  /** The stored path, which a relink is guarded on. */
  dbRef: string;
  volumeId: string | null;
  volumeRel: string | null;
  size: number | null;
  quickHash: string | null;
  mtimeMs: number | null;
  fileId: string | null;
  contentHashes: string[];
  exifStrict: string | null;
  tripId: string | null;
}

// ---------------------------------------------------------------------------------------------
// Places

export async function autoMovedPhotos(userId: string): Promise<boolean> {
  const res = await pool.query<{ find_moved_photos: boolean }>(`SELECT find_moved_photos FROM users WHERE id = $1`, [
    userId,
  ]);
  return res.rows[0]?.find_moved_photos ?? false;
}

export interface Places {
  library: string;
  trips: string[];
  watched: string[];
  chosen: string[];
}

export async function placesFor(userId: string): Promise<Places> {
  const trips = await pool.query<{ source_folder: string; destination_folder: string }>(
    `SELECT source_folder, destination_folder FROM trips WHERE user_id = $1`,
    [userId],
  );
  const chosen = await pool.query<{ path: string }>(
    `SELECT path FROM photo_places WHERE user_id = $1 ORDER BY created_at`,
    [userId],
  );
  const watched = SINGLE_USER_MODE ? (await listWatchedFolders()).filter((w) => w.userId === userId) : [];
  return {
    library: DATA_DIR,
    trips: [...new Set(trips.rows.flatMap((t) => [t.source_folder, t.destination_folder]))],
    watched: watched.map((w) => w.path),
    chosen: chosen.rows.map((r) => r.path),
  };
}

/** Every existing place, as the disk spells it, with places inside another one left out. */
export function rootsOf(places: Places): string[] {
  const all = [places.library, ...places.trips, ...places.watched, ...places.chosen]
    .map((p) => {
      try {
        return realpathSync.native(p);
      } catch {
        return null;
      }
    })
    .filter((p): p is string => p != null)
    .sort((a, b) => a.length - b.length);
  const roots: string[] = [];
  for (const p of all) if (!roots.some((r) => isWithin(canonicalPath(r), canonicalPath(p)))) roots.push(p);
  return roots;
}

const MOUNT_PARENTS = new Set(["/Volumes", "/media", "/mnt", "/run/media"]);

/** The file's drive is gone (unplugged, share not mounted) rather than the file moved: the nearest
 *  folder above it that exists is the top of the disk or where drives are mounted.
 *  shortcut: judged by path, so a drive mounted somewhere unusual counts as present; a missing
 *  file there is only searched for, never relinked to anything but a real match. */
export function driveGone(file: string): boolean {
  let dir = path.dirname(file);
  while (!existsSync(dir)) {
    const up = path.dirname(dir);
    if (up === dir) return true;
    dir = up;
  }
  return path.dirname(dir) === dir || MOUNT_PARENTS.has(dir) || MOUNT_PARENTS.has(path.dirname(dir));
}

// ---------------------------------------------------------------------------------------------
// Finding the missing

interface OriginalRow {
  id: string;
  capture_id: string | null;
  ref: string;
  volume_id: string | null;
  volume_relative_path: string | null;
  file_size: string;
  fp_size: string | null;
  fp_quick_hash: string | null;
  fp_mtime: Date | null;
  fp_file_id: string | null;
  content_hash: string;
  verified_hash: string | null;
  exif_fingerprint: string | null;
  trip_id: string | null;
}

/** Stats every original (one stat each, never a read) and returns those whose file is gone while
 *  its drive is there. A file changed since it was fingerprinted gets its fingerprint cleared, so
 *  the fingerprint pass reads it again. */
async function findMissing(ctx: JobContext<PassResult, Extra>, userId: string, tripId: string | null) {
  const missing: Missing[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  let processed = 0;
  const moving = movingTripId();
  for (;;) {
    const batch = await pool.query<OriginalRow>(
      `SELECT o.id, o.capture_id, o.ref, o.volume_id, o.volume_relative_path, o.file_size, o.fp_size,
              o.fp_quick_hash, o.fp_mtime, o.fp_file_id, o.content_hash, o.verified_hash, o.exif_fingerprint,
              c.trip_id
         FROM originals o LEFT JOIN captures_all c ON c.id = o.capture_id
        WHERE o.user_id = $1 AND o.ref_type = 'path' AND o.id > $2 AND ($3::uuid IS NULL OR c.trip_id = $3)
        ORDER BY o.id LIMIT ${BATCH}`,
      [userId, cursor, tripId],
    );
    if (batch.rows.length === 0) break;
    cursor = batch.rows[batch.rows.length - 1].id;
    const resolved = await resolveOriginalPaths(batch.rows);
    const changed: string[] = [];
    const present: string[] = [];
    for (const [i, row] of batch.rows.entries()) {
      const where = resolved[i];
      // A disconnected drive, or a trip whose files are being moved right now.
      if (!where.connected || !where.path || (moving && row.trip_id === moving)) continue;
      const s = await stat(where.path, { bigint: true }).catch((err: NodeJS.ErrnoException) => err);
      if (!(s instanceof Error)) {
        present.push(row.id);
        const now = identityOf(s);
        if (row.fp_quick_hash && (row.fp_mtime?.getTime() !== now.mtimeMs || Number(row.fp_size) !== now.size))
          changed.push(row.id);
      } else if (s.code === "ENOENT" && !driveGone(where.path) && missing.length < MAX_MISSING) {
        missing.push({
          id: row.id,
          captureId: row.capture_id,
          ref: where.path,
          dbRef: row.ref,
          volumeId: row.volume_id,
          volumeRel: row.volume_relative_path,
          size: row.fp_size != null ? Number(row.fp_size) : Number(row.file_size),
          quickHash: row.fp_quick_hash,
          mtimeMs: row.fp_mtime?.getTime() ?? null,
          fileId: row.fp_file_id,
          contentHashes: [row.content_hash, row.verified_hash].filter((h): h is string => !!h),
          exifStrict: row.exif_fingerprint,
          tripId: row.trip_id,
        });
      }
    }
    if (changed.length > 0)
      await pool.query(`UPDATE originals SET fp_quick_hash = NULL WHERE id = ANY($1::uuid[])`, [changed]);
    // Reviews for photos that are back (found by another pass or put back by the user) go.
    if (present.length > 0)
      await pool.query(`DELETE FROM moved_photo_reviews WHERE original_id = ANY($1::uuid[])`, [present]);
    processed += batch.rows.length;
    ctx.update({ processed });
    await yieldToLoop();
    ctx.throwIfCancelled();
  }
  return missing;
}

// ---------------------------------------------------------------------------------------------
// Matching

interface Candidate {
  path: string;
  size: number;
  mtimeMs: number;
  fileId: string | null;
  quickHash: string | null;
}

interface Match {
  m: Missing;
  candidate: Candidate;
}

interface Review {
  m: Missing;
  candidates: string[];
  reason: "several" | "probably";
}

let lastRead = 0;
/** Paces candidate reads to READS_PER_SECOND and yields between them. */
async function paceRead(signal: AbortSignal): Promise<void> {
  const wait = lastRead + 1000 / READS_PER_SECOND - Date.now();
  if (wait > 0) await sleep(wait, undefined, { signal });
  else await yieldToLoop();
  lastRead = Date.now();
}

/** A candidate's quick hash, read once and kept in seen_files while the file is unchanged. Null
 *  when the file changed or went since the walk. */
async function candidateHash(c: Candidate, signal: AbortSignal): Promise<string | null> {
  if (c.quickHash) return c.quickHash;
  const now = await stat(c.path).catch(() => null);
  if (!now?.isFile() || now.size !== c.size) return null;
  await paceRead(signal);
  const hash = await quickHash(c.path, c.size).catch(() => null);
  if (hash) {
    c.quickHash = hash;
    await pool.query(`UPDATE seen_files SET quick_hash = $2 WHERE path = $1 AND size = $3`, [c.path, hash, c.size]);
  }
  return hash;
}

async function loadCandidates(missing: Missing[]): Promise<Candidate[]> {
  const sizes = [...new Set(missing.map((m) => m.size).filter((s): s is number => s != null))];
  const ids = [...new Set(missing.map((m) => m.fileId).filter((s): s is string => s != null))];
  const res = await pool.query<{
    path: string;
    size: string;
    mtime_ms: number;
    file_id: string | null;
    quick_hash: string | null;
  }>(
    `SELECT path, size, mtime_ms, file_id, quick_hash FROM seen_files
      WHERE size = ANY($1::bigint[]) OR file_id = ANY($2::text[])`,
    [sizes, ids],
  );
  return withoutKnownFiles(
    res.rows.map((r) => ({
      path: r.path,
      size: Number(r.size),
      mtimeMs: r.mtime_ms,
      fileId: r.file_id,
      quickHash: r.quick_hash,
    })),
  );
}

/** Leaves out files another photo already points at, so a relink never makes a duplicate. */
async function withoutKnownFiles<T extends { path: string }>(candidates: T[]): Promise<T[]> {
  if (candidates.length === 0) return candidates;
  const known = await pool.query<{ k: string }>(
    foldCase
      ? `SELECT lower(ref) AS k FROM originals WHERE lower(ref) = ANY($1::text[])`
      : `SELECT ref AS k FROM originals WHERE ref = ANY($1::text[])`,
    [candidates.map((c) => key(c.path))],
  );
  const taken = new Set(known.rows.map((r) => r.k));
  return candidates.filter((c) => !taken.has(key(c.path)));
}

/** Paths an Undo took a photo back from: never relinked to again automatically. */
async function undoneTargets(ids: string[]): Promise<Set<string>> {
  const res = await pool.query<{ original_id: string; new_ref: string }>(
    `SELECT ch.original_id, ch.new_ref FROM relink_changes ch JOIN relink_batches b ON b.id = ch.batch_id
      WHERE b.undone_at IS NOT NULL AND ch.original_id = ANY($1::uuid[])`,
    [ids],
  );
  return new Set(res.rows.map((r) => `${r.original_id}|${key(r.new_ref)}`));
}

async function findMatches(missing: Missing[], signal: AbortSignal): Promise<{ matches: Match[]; reviews: Review[] }> {
  const candidates = await loadCandidates(missing);
  const bySize = new Map<number, Candidate[]>();
  const byFileId = new Map<string, Candidate>();
  for (const c of candidates) {
    bySize.set(c.size, [...(bySize.get(c.size) ?? []), c]);
    if (c.fileId) byFileId.set(c.fileId, c);
  }
  const undone = await undoneTargets(missing.map((m) => m.id));
  const allowed = (m: Missing, c: Candidate) => !undone.has(`${m.id}|${key(c.path)}`);

  const proposed: Match[] = [];
  const reviews: Review[] = [];
  const unmatched: Missing[] = [];
  for (const m of missing) {
    signal.throwIfAborted();
    // Same volume and inode: a rename or a folder moved on the same drive. Inode numbers can be
    // reused or unstable (network shares), so it must also be the same size and content, or the
    // same size and mtime.
    const same = m.fileId ? byFileId.get(m.fileId) : undefined;
    if (same && allowed(m, same) && same.size === m.size) {
      const verified = m.quickHash
        ? (await candidateHash(same, signal)) === m.quickHash
        : m.mtimeMs != null && same.mtimeMs === m.mtimeMs;
      if (verified) {
        proposed.push({ m, candidate: same });
        continue;
      }
    }
    // Same size and the same bytes at both ends (or, before the fingerprint pass reached it, the
    // same full content).
    const sized = (m.size != null ? (bySize.get(m.size) ?? []) : []).filter((c) => allowed(m, c));
    const hits: Candidate[] = [];
    for (const c of sized) {
      if (m.quickHash) {
        if ((await candidateHash(c, signal)) === m.quickHash) hits.push(c);
      } else if (m.contentHashes.length > 0 && sized.length <= 20) {
        await paceRead(signal);
        const full = await computeContentHash(c.path).catch(() => null);
        if (full && m.contentHashes.includes(full)) hits.push(c);
      }
    }
    if (hits.length === 1) proposed.push({ m, candidate: hits[0] });
    else if (hits.length > 1) {
      // Exact copies: the one that is the same file (inode) wins, otherwise the user picks.
      const sameFile = hits.find((c) => c.fileId && c.fileId === m.fileId);
      if (sameFile) proposed.push({ m, candidate: sameFile });
      else reviews.push({ m, candidates: hits.map((c) => c.path), reason: "several" });
    } else unmatched.push(m);
  }

  // Two photos can't end up pointing at one file: a file claimed twice goes to review for both.
  const claims = new Map<string, Match[]>();
  for (const p of proposed) claims.set(key(p.candidate.path), [...(claims.get(key(p.candidate.path)) ?? []), p]);
  const matches: Match[] = [];
  for (const group of claims.values()) {
    if (group.length === 1) matches.push(group[0]);
    else for (const p of group) reviews.push({ m: p.m, candidates: [p.candidate.path], reason: "several" });
  }

  reviews.push(...(await editedInPlace(unmatched, signal)));
  return { matches, reviews };
}

/** Files edited in place have new bytes, so the hashes miss. Same file name, a similar size and
 *  the same capture time and camera serial (the EXIF fingerprint) make it probably the same: only
 *  ever offered for review. */
async function editedInPlace(unmatched: Missing[], signal: AbortSignal): Promise<Review[]> {
  const withExif = unmatched.filter((m) => m.exifStrict && m.size);
  if (withExif.length === 0) return [];
  const names = [...new Set(withExif.map((m) => path.basename(m.ref).toLowerCase()))];
  const res = await pool.query<{ path: string; name: string; size: string }>(
    `SELECT path, name, size FROM seen_files WHERE name = ANY($1::text[])`,
    [names],
  );
  const byName = new Map<string, Array<{ path: string; size: number }>>();
  for (const r of await withoutKnownFiles(res.rows))
    byName.set(r.name, [...(byName.get(r.name) ?? []), { path: r.path, size: Number(r.size) }]);
  const reviews: Review[] = [];
  for (const m of withExif) {
    // Within half to double the size: a metadata edit or a re-save, not another photo.
    const near = (byName.get(path.basename(m.ref).toLowerCase()) ?? [])
      .filter((c) => c.size >= m.size! / 2 && c.size <= m.size! * 2)
      .slice(0, 5);
    const same: string[] = [];
    for (const c of near) {
      await paceRead(signal);
      const fp = await computeExifFingerprint(c.path).catch(() => null);
      if (fp?.strict && fp.strict === m.exifStrict) same.push(c.path);
    }
    if (same.length > 0) reviews.push({ m, candidates: same, reason: "probably" });
  }
  return reviews;
}

// ---------------------------------------------------------------------------------------------
// Applying and undoing

export interface Relink {
  originalId: string;
  captureId: string | null;
  oldRef: string;
  oldVolumeId: string | null;
  oldVolumeRel: string | null;
  newRef: string;
}

interface TripChange {
  tripId: string;
  oldSource: string;
  oldDestination: string;
  newSource: string;
  newDestination: string;
}

/** The registered drive (or library root) each file is on. Looked up once per folder, since a
 *  lookup can shell out; skipped when no drive is registered at all. */
async function volumeTags(userId: string, files: string[]): Promise<VolumeTag[]> {
  const none: VolumeTag = { volumeId: null, volumeRelativePath: null };
  const any = await pool.query(`SELECT 1 FROM storage_volumes WHERE removed_at IS NULL LIMIT 1`);
  if (!any.rowCount) return files.map(() => none);
  const byFolder = new Map<string, VolumeTag>();
  const tags: VolumeTag[] = [];
  for (const file of files) {
    const dir = path.dirname(file);
    let tag = byFolder.get(dir);
    if (!tag) byFolder.set(dir, (tag = await tagWithRegisteredVolume(userId, dir)));
    tags.push(
      tag.volumeId
        ? {
            volumeId: tag.volumeId,
            volumeRelativePath: path.join(tag.volumeRelativePath || path.sep, path.basename(file)),
          }
        : none,
    );
  }
  return tags;
}

/** Points each photo at its new path and records the batch for Undo. Guarded on the old path, so
 *  a photo that changed meanwhile is left alone. Returns the batch id and how many changed. */
export async function applyRelinks(
  userId: string,
  items: Relink[],
  opts: { announced?: boolean; trip?: TripChange } = {},
): Promise<{ batchId: string; count: number }> {
  const tags = await volumeTags(
    userId,
    items.map((i) => i.newRef),
  );
  const client = await pool.connect();
  let count = 0;
  let batchId: string;
  try {
    await client.query("BEGIN");
    const t = opts.trip;
    batchId = (
      await client.query<{ id: string }>(
        `INSERT INTO relink_batches (user_id, announced, trip_id, old_source_folder, old_destination_folder,
                                     new_source_folder, new_destination_folder)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [userId, opts.announced ?? false, t?.tripId, t?.oldSource, t?.oldDestination, t?.newSource, t?.newDestination],
      )
    ).rows[0].id;
    for (const [i, item] of items.entries()) {
      const res = await client.query(
        `UPDATE originals SET ref = $2, volume_id = $3, volume_relative_path = $4, stale = false,
                health = CASE WHEN health = 'missing' THEN NULL ELSE health END
          WHERE id = $1 AND ref = $5 AND user_id = $6`,
        [item.originalId, item.newRef, tags[i].volumeId, tags[i].volumeRelativePath, item.oldRef, userId],
      );
      if (!res.rowCount) continue;
      count++;
      await client.query(
        `INSERT INTO relink_changes (batch_id, original_id, old_ref, old_volume_id, old_volume_relative_path, new_ref)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [batchId, item.originalId, item.oldRef, item.oldVolumeId, item.oldVolumeRel, item.newRef],
      );
    }
    await client.query(`DELETE FROM moved_photo_reviews WHERE original_id = ANY($1::uuid[])`, [
      items.map((i) => i.originalId),
    ]);
    if (t) {
      await client.query(`UPDATE trips SET source_folder = $2, destination_folder = $3 WHERE id = $1`, [
        t.tripId,
        t.newSource,
        t.newDestination,
      ]);
      await client.query(`DELETE FROM trip_folder_proposals WHERE trip_id = $1`, [t.tripId]);
    }
    if (count === 0 && !t) await client.query(`DELETE FROM relink_batches WHERE id = $1`, [batchId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await afterPathsChanged(
    userId,
    items.map((i) => i.captureId),
  );
  return { batchId, count };
}

/** The records kept beside the photos name them by path, so they follow (as after a move). */
async function afterPathsChanged(userId: string, captureIds: Array<string | null>): Promise<void> {
  const ids = [...new Set(captureIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const { syncAlbumIndexForCaptures } = await import("../albums/albumIndex.js");
  const { scheduleTripRecordsSave } = await import("../lib/libraryRecords.js");
  await syncAlbumIndexForCaptures(ids).catch((err: unknown) => log.warn({ err }, "[moved-photos] album records"));
  scheduleTripRecordsSave(userId);
}

/** Puts every path in the batch (and a trip's folders) back. False when there's nothing to undo. */
export async function undoBatch(userId: string, batchId: string): Promise<boolean> {
  const client = await pool.connect();
  const captureIds: string[] = [];
  try {
    await client.query("BEGIN");
    const batch = await client.query<{
      trip_id: string | null;
      old_source_folder: string | null;
      old_destination_folder: string | null;
      new_source_folder: string | null;
      new_destination_folder: string | null;
    }>(
      `UPDATE relink_batches SET undone_at = now(), announced = true
        WHERE id = $1 AND user_id = $2 AND undone_at IS NULL
        RETURNING trip_id, old_source_folder, old_destination_folder, new_source_folder, new_destination_folder`,
      [batchId, userId],
    );
    const b = batch.rows[0];
    if (!b) {
      await client.query("ROLLBACK");
      return false;
    }
    const res = await client.query<{ capture_id: string | null }>(
      `UPDATE originals o SET ref = ch.old_ref, volume_id = ch.old_volume_id,
              volume_relative_path = ch.old_volume_relative_path
         FROM relink_changes ch
        WHERE ch.batch_id = $1 AND o.id = ch.original_id AND o.ref = ch.new_ref
        RETURNING o.capture_id`,
      [batchId],
    );
    for (const r of res.rows) if (r.capture_id) captureIds.push(r.capture_id);
    if (b.trip_id)
      await client.query(
        `UPDATE trips SET source_folder = $2, destination_folder = $3
          WHERE id = $1 AND source_folder = $4 AND destination_folder = $5`,
        [b.trip_id, b.old_source_folder, b.old_destination_folder, b.new_source_folder, b.new_destination_folder],
      );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  await afterPathsChanged(userId, captureIds);
  return true;
}

async function saveReviews(userId: string, reviews: Review[]): Promise<void> {
  for (const r of reviews) {
    await pool.query(
      `INSERT INTO moved_photo_reviews (original_id, user_id, candidates, reason) VALUES ($1, $2, $3, $4)
       ON CONFLICT (original_id) DO UPDATE SET candidates = EXCLUDED.candidates, reason = EXCLUDED.reason,
         dismissed_at = CASE WHEN moved_photo_reviews.candidates = EXCLUDED.candidates
                             THEN moved_photo_reviews.dismissed_at END`,
      [r.m.id, userId, r.candidates, r.reason],
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Trip folders

interface TripFolders {
  id: string;
  source_folder: string;
  destination_folder: string;
}

/** The folder whose move is offered: the trip's folder, or its wildlife folder when that lives
 *  elsewhere. */
function tripRoot(trip: TripFolders): string {
  const source = canonicalPath(trip.source_folder);
  const dest = canonicalPath(trip.destination_folder);
  return isWithin(source, dest) ? source : dest;
}

/** The trip's folders once `root` moved to `folder`: the other one follows when it was inside. */
function movedFolders(trip: TripFolders, folder: string): { source: string; destination: string } {
  const root = tripRoot(trip);
  const follow = (p: string) =>
    isWithin(root, canonicalPath(p)) ? path.join(folder, path.relative(root, canonicalPath(p))) : p;
  return { source: follow(trip.source_folder), destination: follow(trip.destination_folder) };
}

/** When most of a trip's files turned up under one new folder, in their old places relative to
 *  it, offers that folder as the trip's. */
async function proposeTripFolders(
  userId: string,
  relinked: Relink[],
  tripOf: Map<string, string | null>,
): Promise<number> {
  const byTrip = new Map<string, Relink[]>();
  for (const r of relinked) {
    const tripId = tripOf.get(r.originalId);
    if (tripId) byTrip.set(tripId, [...(byTrip.get(tripId) ?? []), r]);
  }
  let proposals = 0;
  for (const [tripId, items] of byTrip) {
    const trip = (
      await pool.query<TripFolders>(`SELECT id, source_folder, destination_folder FROM trips WHERE id = $1`, [tripId])
    ).rows[0];
    if (!trip) continue;
    const root = tripRoot(trip);
    const votes = new Map<string, number>();
    for (const r of items) {
      const old = canonicalPath(r.oldRef);
      if (!isWithin(root, old)) continue;
      const suffix = path.sep + path.relative(root, old);
      const now = canonicalPath(r.newRef);
      if (!key(now).endsWith(key(suffix))) continue;
      const folder = now.slice(0, now.length - suffix.length);
      votes.set(folder, (votes.get(folder) ?? 0) + 1);
    }
    const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    if (!best || key(best[0]) === key(root) || !existsSync(best[0])) continue;
    const rows = await tripOriginals(userId, tripId);
    const found = rows.filter((o) => isWithin(canonicalPath(best[0]), canonicalPath(o.ref))).length;
    if (found * 2 <= rows.length) continue;
    const res = await pool.query(
      `INSERT INTO trip_folder_proposals (trip_id, user_id, folder, found, total) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trip_id) DO UPDATE SET found = EXCLUDED.found, total = EXCLUDED.total,
         folder = EXCLUDED.folder, created_at = now(),
         announced = trip_folder_proposals.announced AND trip_folder_proposals.folder = EXCLUDED.folder,
         dismissed_at = CASE WHEN trip_folder_proposals.folder = EXCLUDED.folder
                             THEN trip_folder_proposals.dismissed_at END
       RETURNING dismissed_at`,
      [tripId, userId, best[0], found, rows.length],
    );
    if (!res.rows[0]?.dismissed_at) proposals++;
  }
  return proposals;
}

/** "This trip's folder moved to <folder>. Use it?": relinks the trip's other files found in their
 *  old places under the new folder (the same check as "Point to where I moved them") and points
 *  the trip at it, as one batch Undo can reverse. */
export async function useTripFolder(
  userId: string,
  tripId: string,
): Promise<{ batchId: string; count: number } | null> {
  const proposal = (
    await pool.query<{ folder: string }>(
      `SELECT folder FROM trip_folder_proposals WHERE trip_id = $1 AND user_id = $2`,
      [tripId, userId],
    )
  ).rows[0];
  const trip = await loadTrip(userId, tripId);
  if (!proposal || !trip || !existsSync(proposal.folder)) return null;
  if (isTripBusy(tripId))
    throw Object.assign(new Error("Wait for this trip's files to finish first"), { statusCode: 409 });
  const root = tripRoot(trip);
  const rows = await tripOriginals(userId, tripId);
  const { found } = await findUnderNewRoot(
    rows.filter((r) => !existsSync(r.ref)),
    root,
    onDisk(proposal.folder),
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const folders = movedFolders(trip, onDisk(proposal.folder));
  return applyRelinks(
    userId,
    found.map((f) => {
      const row = byId.get(f.id)!;
      return {
        originalId: f.id,
        captureId: row.capture_id,
        oldRef: row.ref,
        oldVolumeId: row.volume_id,
        oldVolumeRel: row.volume_relative_path,
        newRef: f.ref,
      };
    }),
    {
      announced: true,
      trip: {
        tripId,
        oldSource: trip.source_folder,
        oldDestination: trip.destination_folder,
        newSource: folders.source,
        newDestination: folders.destination,
      },
    },
  );
}

// ---------------------------------------------------------------------------------------------
// The pass

function busy(): boolean {
  for (const name of runningJobNames) if (BUSY_JOBS.test(name)) return true;
  return false;
}

async function libraryExtensions(userId: string): Promise<Set<string>> {
  const res = await pool.query<{ ext: string }>(
    `SELECT DISTINCT lower(substring(ref from '\\.[^./\\\\]+$')) AS ext FROM originals WHERE user_id = $1`,
    [userId],
  );
  return new Set(res.rows.map((r) => r.ext).filter(Boolean));
}

async function runPass(ctx: JobContext<PassResult, Extra>, userId: string, tripId: string | null): Promise<PassResult> {
  ctx.update({ phase: "checking", processed: 0, total: null });
  const missing = await findMissing(ctx, userId, tripId);
  const result: PassResult = {
    missing: missing.length,
    relinked: 0,
    review: 0,
    proposals: 0,
    batchId: null,
    unreadableFolders: 0,
    walk: null,
    maxLagMs: 0,
  };
  // Nothing missing: no walk, no reads.
  if (missing.length === 0) return result;

  ctx.update({ phase: "looking", processed: 0, total: null });
  const roots = rootsOf(await placesFor(userId));
  const walk = await walkPlaces(roots, await libraryExtensions(userId), ctx.signal, (s) =>
    ctx.update({ processed: s.filesStatted }),
  );
  result.walk = walk;
  result.unreadableFolders = walk.unreadable.length;
  if (walk.unreadable.length > 0)
    log.warn(
      { folders: walk.unreadable.slice(0, 20), count: walk.unreadable.length },
      "[moved-photos] Skipped folders Lifer can't read",
    );

  ctx.update({ phase: "matching", processed: 0, total: missing.length });
  const { matches, reviews } = await findMatches(missing, ctx.signal);
  ctx.throwIfCancelled();
  if (busy()) return result;

  const relinks: Relink[] = matches
    .filter(({ m }) => !(m.tripId && isTripBusy(m.tripId)))
    .map(({ m, candidate }) => ({
      originalId: m.id,
      captureId: m.captureId,
      oldRef: m.dbRef,
      oldVolumeId: m.volumeId,
      oldVolumeRel: m.volumeRel,
      newRef: candidate.path,
    }));
  if (relinks.length > 0) {
    const { batchId, count } = await applyRelinks(userId, relinks);
    result.relinked = count;
    result.batchId = count > 0 ? batchId : null;
    result.proposals = await proposeTripFolders(userId, relinks, new Map(missing.map((m) => [m.id, m.tripId])));
  }
  await saveReviews(userId, reviews);
  result.review = reviews.length;
  return result;
}

export interface LookOptions {
  tripId?: string | null;
  manual?: boolean;
}

const lastLook = new Map<string, number>();
// Automatic looks (a failed open, opening a trip) at most this often per user and trip.
const AUTO_EVERY_MS = 10 * 60_000;

/** Starts a pass in the background. False when one is running, the user turned automatic looks
 *  off (for an automatic one), one ran recently, or a library-wide job is rewriting paths. */
export async function startLook(userId: string, opts: LookOptions = {}): Promise<boolean> {
  if (movedPhotosJob.status.running || busy()) return false;
  if (!opts.manual) {
    if (!(await autoMovedPhotos(userId))) return false;
    const k = `${userId}|${opts.tripId ?? ""}`;
    if (Date.now() - (lastLook.get(k) ?? 0) < AUTO_EVERY_MS) return false;
    lastLook.set(k, Date.now());
  }
  const tripId = opts.tripId ?? null;
  return movedPhotosJob.start(
    async (ctx) => {
      const lag = monitorEventLoopDelay({ resolution: 10 });
      lag.enable();
      try {
        const result = await runPass(ctx, userId, tripId);
        result.maxLagMs = Math.round(lag.max / 1e6);
        // After an automatic look, fingerprints for files that don't have one yet.
        if (!opts.manual) setImmediate(() => void startFingerprints(userId));
        return result;
      } finally {
        lag.disable();
      }
    },
    { manual: opts.manual === true, userId, tripId, phase: "checking" },
  );
}

/** A file failed to open: look for it (and anything else that moved) soon. */
export function reportMissingFile(userId: string): void {
  startLook(userId).catch((err) => log.warn({ err }, "[moved-photos] Couldn't start a look"));
}

// ---------------------------------------------------------------------------------------------
// Fingerprints for photos imported before they were taken, or changed since

/** Fingerprints every original without one, in small batches with pauses. Resumable: only rows
 *  without a fingerprint are read, and each is saved as soon as it's done. */
export async function startFingerprints(userId: string): Promise<void> {
  fingerprintJob.start(async (ctx) => {
    let done = 0;
    let cursor = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const batch = await pool.query<{
        id: string;
        ref: string;
        volume_id: string | null;
        volume_relative_path: string | null;
      }>(
        `SELECT id, ref, volume_id, volume_relative_path FROM originals
          WHERE user_id = $1 AND ref_type = 'path' AND fp_quick_hash IS NULL AND id > $2
          ORDER BY id LIMIT 100`,
        [userId, cursor],
      );
      if (batch.rows.length === 0) break;
      cursor = batch.rows[batch.rows.length - 1].id;
      const resolved = await resolveOriginalPaths(batch.rows);
      for (const [i, row] of batch.rows.entries()) {
        // Paths are being rewritten: the rest waits for the next time.
        if (busy() || movedPhotosJob.status.running) return done;
        const where = resolved[i];
        if (!where.connected || !where.path) continue;
        await paceRead(ctx.signal);
        const fp = await fingerprintFile(where.path).catch(() => null);
        if (!fp) continue;
        await pool.query(
          `UPDATE originals SET fp_quick_hash = $2, fp_size = $3, fp_mtime = $4, fp_file_id = $5
            WHERE id = $1 AND ref = $6`,
          [row.id, fp.quickHash, fp.size, fp.mtime, fp.fileId, row.ref],
        );
        ctx.update({ processed: ++done });
      }
    }
    return done;
  });
  await fingerprintJob.settled();
}

const START_DELAY_MS = 4 * 60_000;

/** Once Lifer has been open a few minutes: a quiet look for moved photos, then fingerprints. */
export function scheduleMovedPhotos(): void {
  setTimeout(async () => {
    try {
      const users = await pool.query<{ id: string }>(`SELECT id FROM users WHERE find_moved_photos`);
      for (const u of users.rows) {
        await startLook(u.id);
        await movedPhotosJob.settled();
      }
    } catch (err) {
      log.warn({ err }, "[moved-photos] Startup look failed");
    }
  }, START_DELAY_MS).unref();
}
