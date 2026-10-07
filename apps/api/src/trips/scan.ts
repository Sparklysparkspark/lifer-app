// Scans a trip. The source folder is the user's own and only ever read; the destination folder
// holds Lifer's sorted copies. In order: relink or mark stale known originals in the destination,
// recover unknown destination files from the trip index, list unimported source files for review
// with the marks a culling app left on them (cullMarks.ts), then link RAWs to their imported JPEGs
// (rawLink.ts).
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import type { CullMarks } from "@lifer/shared";
import { readPairCullMarks } from "../uploads/cullMarks.js";
import { computeContentHash } from "../uploads/fileFingerprint.js";
import { ACCEPTED_PHOTO_EXTENSIONS, isRawFile } from "@lifer/core/uploads/formats.js";
import { resolveTripIndexSpecies } from "./tripIndex.js";
import { importTripFile, matchingSourceRaw } from "./import.js";
import { listRawFiles, autoLinkMissingRaws } from "./rawLink.js";

// Every photo format the app accepts (JPEG, PNG, WebP, TIFF, HEIC). A TIFF holding sensor data
// is a RAW instead: onlyPhotos drops it here and listRawFiles picks it up.
const TRIP_IMAGE_EXTENSIONS = new Set(ACCEPTED_PHOTO_EXTENSIONS.map((e) => e.toLowerCase()));

async function onlyPhotos(files: CandidateFile[]): Promise<CandidateFile[]> {
  const photos: CandidateFile[] = [];
  for (const f of files) if (!(await isRawFile(f.absolutePath).catch(() => false))) photos.push(f);
  return photos;
}

export interface CandidateFile {
  relativePath: string;
  absolutePath: string;
}

/** Recursive listing of photo files, skipping dotfiles and `skipFolder`. */
export function listCandidateFiles(sourceFolder: string, skipFolder?: string): CandidateFile[] {
  const results: CandidateFile[] = [];
  const skip = skipFolder ? path.resolve(skipFolder) : null;
  function walk(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip && path.resolve(absolutePath) === skip) continue;
        walk(absolutePath);
      } else if (TRIP_IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        results.push({ relativePath: path.relative(sourceFolder, absolutePath), absolutePath });
      }
    }
  }
  walk(sourceFolder);
  return results;
}

interface KnownOriginal {
  id: string;
  ref: string;
  content_hash: string;
}

export interface ScanResult {
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  newFiles: Array<CandidateFile & { cull: CullMarks }>;
}

// Each read is a small exiftool call (two with a sidecar, four with a RAW twin).
const CULL_READ_CONCURRENCY = 8;

/** Each file with its culling marks, read from it, its sidecar and its RAW twin in the source
 *  folder (the same stem rule the import uses to bring the RAW along). */
export async function withCullMarks(
  sourceFolder: string,
  destinationFolder: string,
  files: CandidateFile[],
  signal?: AbortSignal,
): Promise<Array<CandidateFile & { cull: CullMarks }>> {
  if (files.length === 0) return [];
  const destination = canonicalPath(destinationFolder);
  const sourceRaws = (await listRawFiles(sourceFolder)).filter((r) => !isWithin(destination, canonicalPath(r.absolutePath)));
  return mapWithConcurrency(files, CULL_READ_CONCURRENCY, async (file) => {
    signal?.throwIfAborted();
    const raw = matchingSourceRaw(file.absolutePath, sourceRaws);
    return { ...file, cull: await readPairCullMarks(file.absolutePath, raw?.absolutePath ?? null) };
  });
}

/** Reconciles every original linked to this trip with what's on disk. `candidates` is the full
 *  file listing, searched by content hash for moved files. */
export async function matchAgainstKnownOriginals(tripId: string, candidates: CandidateFile[], signal?: AbortSignal): Promise<{
  relinked: number;
  markedStale: number;
  collisions: number;
  claimedAbsolutePaths: Set<string>;
}> {
  const knownRes = await pool.query<KnownOriginal>(
    // captures_all, so a photo imported hidden is still a known file here.
    `SELECT o.id, o.ref, o.content_hash FROM originals o
     JOIN captures_all c ON c.id = o.capture_id
     WHERE c.trip_id = $1 AND c.deleted_at IS NULL`,
    [tripId],
  );

  let relinked = 0;
  let markedStale = 0;
  let collisions = 0;
  const claimedAbsolutePaths = new Set<string>();

  for (const original of knownRes.rows) {
    signal?.throwIfAborted();
    if (existsSync(original.ref)) {
      claimedAbsolutePaths.add(original.ref);
      await pool.query(`UPDATE originals SET stale = false, last_seen_at = now() WHERE id = $1`, [original.id]);
      continue;
    }

    // Missing at its ref: look for it by content hash among files not yet claimed in this pass.
    const unclaimed = candidates.filter((c) => !claimedAbsolutePaths.has(c.absolutePath));
    const unclaimedHashes = await Promise.all(unclaimed.map((c) => computeContentHash(c.absolutePath)));
    const hashMatches = unclaimed.filter((_, i) => unclaimedHashes[i] === original.content_hash);

    if (hashMatches.length === 1) {
      // Only the DB record changes; the file itself is never touched.
      await pool.query(`UPDATE originals SET ref = $1, stale = false, last_seen_at = now() WHERE id = $2`, [
        hashMatches[0].absolutePath,
        original.id,
      ]);
      claimedAbsolutePaths.add(hashMatches[0].absolutePath);
      relinked++;
    } else if (hashMatches.length > 1) {
      // Ambiguous: never guess. Recorded for manual review, `stale` left alone.
      await pool.query(
        `INSERT INTO fingerprint_collisions (exif_fingerprint, original_id) VALUES ($1, $2)`,
        [original.content_hash, original.id],
      );
      collisions++;
    } else {
      // Marked stale, not deleted, so an unmounted drive self-heals on the next rescan.
      await pool.query(`UPDATE originals SET stale = true WHERE id = $1`, [original.id]);
      markedStale++;
    }
  }

  return { relinked, markedStale, collisions, claimedAbsolutePaths };
}

/** Files no known original has claimed. */
export function findNewFiles(candidates: CandidateFile[], claimedAbsolutePaths: Set<string>): CandidateFile[] {
  return candidates.filter((c) => !claimedAbsolutePaths.has(c.absolutePath));
}

// Before asking for a species, check the trip's recovery index (tripIndex.ts): a file imported
// before a fresh install gets its species back without review.
async function autoRecoverFromIndex(
  tripId: string,
  userId: string,
  sourceFolder: string,
  newFiles: CandidateFile[],
  signal?: AbortSignal,
): Promise<{ recovered: number; stillNew: CandidateFile[] }> {
  const speciesByPath = await resolveTripIndexSpecies(
    sourceFolder,
    newFiles.map((f) => f.relativePath),
  );
  if (speciesByPath.size === 0) return { recovered: 0, stillNew: newFiles };

  let recovered = 0;
  const stillNew: CandidateFile[] = [];
  for (const file of newFiles) {
    signal?.throwIfAborted();
    const speciesId = speciesByPath.get(file.relativePath);
    if (!speciesId) {
      stillNew.push(file);
      continue;
    }
    try {
      // The trip index has no region to offer.
      await importTripFile(tripId, userId, speciesId, file.absolutePath, sourceFolder, file.relativePath, null);
      recovered++;
    } catch {
      // Failed recovery (e.g. a corrupt file) falls back to manual review.
      stillNew.push(file);
    }
  }
  return { recovered, stillNew };
}

export interface ScanOptions {
  signal?: AbortSignal;
  // Phases: "checking" (relink known files), "recovering" (from the trip index), "linking-raws".
  onPhase?: (phase: string) => void;
}

export async function scanTrip(
  tripId: string,
  userId: string,
  sourceFolder: string,
  destinationFolder: string,
  opts: ScanOptions = {},
): Promise<ScanResult> {
  const { signal, onPhase } = opts;
  onPhase?.("checking");
  const destinationImages = await onlyPhotos(listCandidateFiles(destinationFolder));
  // RAWs join the relink pass but are never offered for review: only autoLinkMissingRaws
  // handles them.
  const allDestination = [...destinationImages, ...(await listRawFiles(destinationFolder))];
  const { relinked, markedStale, collisions, claimedAbsolutePaths } = await matchAgainstKnownOriginals(tripId, allDestination, signal);
  onPhase?.("recovering");
  const unclaimedCopies = findNewFiles(destinationImages, claimedAbsolutePaths);
  const { recovered } = await autoRecoverFromIndex(tripId, userId, destinationFolder, unclaimedCopies, signal);
  signal?.throwIfAborted();
  onPhase?.("finding-new");
  const unimported = await findUnimportedFiles(userId, await onlyPhotos(listCandidateFiles(sourceFolder, destinationFolder)), signal);
  onPhase?.("reading-cull-marks");
  const newFiles = await withCullMarks(sourceFolder, destinationFolder, unimported, signal);
  onPhase?.("linking-raws");
  const rawsLinked = await autoLinkMissingRaws(tripId, destinationFolder);
  return { relinked, markedStale, collisions, recovered, rawsLinked, newFiles };
}

/** Source-folder photos whose content hash isn't yet a captures.fingerprint for this user, so a
 * photo imported any other way isn't offered again. One imported hidden counts as imported. */
export async function findUnimportedFiles(userId: string, files: CandidateFile[], signal?: AbortSignal): Promise<CandidateFile[]> {
  const known = new Set(
    (
      await pool.query<{ fingerprint: string }>(
        `SELECT fingerprint FROM captures_all WHERE user_id = $1 AND deleted_at IS NULL AND fingerprint IS NOT NULL`,
        [userId],
      )
    ).rows.map(
      (r) => r.fingerprint,
    ),
  );
  const unimported: CandidateFile[] = [];
  for (const file of files) {
    signal?.throwIfAborted();
    try {
      if (!known.has(await computeContentHash(file.absolutePath))) unimported.push(file);
    } catch {
      // unreadable right now: offer it, and the import reports the real problem
      unimported.push(file);
    }
  }
  return unimported;
}

/** Path-traversal guard: relativePath must resolve to a file inside the trip's folder. Both
 *  sides are realpath'd so a symlink can't point outside it. */
export function resolveWithinTripFolder(sourceFolder: string, relativePath: string): string | null {
  let root: string;
  let real: string;
  try {
    root = realpathSync(path.resolve(sourceFolder));
    real = realpathSync(path.resolve(root, relativePath));
  } catch {
    return null;
  }
  if (real === root || !isWithin(root, real)) return null;
  if (!statSync(real).isFile()) return null;
  return real;
}
