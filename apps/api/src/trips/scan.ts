// Folder-walking logic for a Trip's reference-in-place source_folder — shared by the very
// first scan after creating a trip and any later manual rescan (new photos added, or the
// folder reorganized). Three responsibilities, run in this order every time:
//   1. Confirm every already-linked original is still where it was (matchAgainstKnownOriginals)
//      — silently relinks a moved/renamed file by content hash, never touches the file itself,
//      and marks a genuinely-missing one `stale` rather than deleting its capture/species
//      history (same "don't guess, don't destroy" philosophy as migration 013's original,
//      never-implemented design for scan_roots/fingerprint_collisions).
//   2. Surface any file in the folder matching no known original at all (findNewFiles) — these
//      go through the same species-assignment review UI as Bulk Import, just landing on
//      POST /trips/:id/import instead of POST /uploads.
//   3. (rawLink.ts) Auto-link any RAW file whose stem+timestamp matches an already-imported
//      capture's JPEG — a RAW is never a "new file" needing species review on its own.
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { computeContentHash } from "../uploads/fileFingerprint.js";
import { resolveTripIndexSpecies } from "./tripIndex.js";
import { importTripFile } from "./import.js";
import { listRawFiles, autoLinkMissingRaws } from "./rawLink.js";

const TRIP_IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png"]);

export interface CandidateFile {
  relativePath: string;
  absolutePath: string;
}

/** Recursive — mirrors the recursion Bulk Import/RawUpload already do client-side via
 *  `<input webkitdirectory>`, just server-side since this walks the server's own filesystem
 *  (see the plan's note on why trip folders are picked via browse-directory, not a browser
 *  file input). */
export function listCandidateFiles(sourceFolder: string): CandidateFile[] {
  const results: CandidateFile[] = [];
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
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
  newFiles: CandidateFile[];
}

/** Step 1 — reconcile every original already linked to this trip against what's actually on
 *  disk right now. `candidates` is the full current file listing (from listCandidateFiles),
 *  reused here so a moved file can be found among files findNewFiles hasn't yet claimed. */
export async function matchAgainstKnownOriginals(tripId: string, candidates: CandidateFile[]): Promise<{
  relinked: number;
  markedStale: number;
  collisions: number;
  claimedAbsolutePaths: Set<string>;
}> {
  const knownRes = await pool.query<KnownOriginal>(
    `SELECT o.id, o.ref, o.content_hash FROM originals o
     JOIN captures c ON c.id = o.capture_id
     WHERE c.trip_id = $1`,
    [tripId],
  );

  let relinked = 0;
  let markedStale = 0;
  let collisions = 0;
  const claimedAbsolutePaths = new Set<string>();

  for (const original of knownRes.rows) {
    if (existsSync(original.ref)) {
      claimedAbsolutePaths.add(original.ref);
      await pool.query(`UPDATE originals SET stale = false, last_seen_at = now() WHERE id = $1`, [original.id]);
      continue;
    }

    // Missing at its stored ref — look for it elsewhere in the folder by content hash before
    // giving up. Only ever compares against files not already claimed by another original
    // this same pass, so two missing originals can't both silently steal the same file.
    // Hash-only (no EXIF read) — relink matching never needs it, and skipping the exiftool
    // round-trip here matters: this runs once per unclaimed candidate for every missing
    // original, so it's the one place in this file where EXIF overhead would multiply fastest.
    const unclaimed = candidates.filter((c) => !claimedAbsolutePaths.has(c.absolutePath));
    const hashMatches = unclaimed.filter((candidate) => computeContentHash(candidate.absolutePath) === original.content_hash);

    if (hashMatches.length === 1) {
      // Silent relink — the DB record is updated, the file itself is never touched, moved, or
      // renamed by Lifer.
      await pool.query(`UPDATE originals SET ref = $1, stale = false, last_seen_at = now() WHERE id = $2`, [
        hashMatches[0].absolutePath,
        original.id,
      ]);
      claimedAbsolutePaths.add(hashMatches[0].absolutePath);
      relinked++;
    } else if (hashMatches.length > 1) {
      // Ambiguous — never guess which one is the real match (same rule the RAW-matching code
      // in uploads/routes.ts already follows). Recorded for manual review, left `stale` alone.
      await pool.query(
        `INSERT INTO fingerprint_collisions (exif_fingerprint, original_id) VALUES ($1, $2)`,
        [original.content_hash, original.id],
      );
      collisions++;
    } else {
      // Genuinely gone — preserve the capture/species history rather than deleting it; a
      // temporarily unmounted drive or a file that reappears later should self-heal on the
      // next rescan, not lose everything the user already told Lifer about it.
      await pool.query(`UPDATE originals SET stale = true WHERE id = $1`, [original.id]);
      markedStale++;
    }
  }

  return { relinked, markedStale, collisions, claimedAbsolutePaths };
}

/** Step 2 — whatever's left in the folder after every already-known original has claimed its
 *  file (moved or not) is either brand new or was never imported. Returned as-is for the
 *  review UI; nothing is written to the database here. */
export function findNewFiles(candidates: CandidateFile[], claimedAbsolutePaths: Set<string>): CandidateFile[] {
  return candidates.filter((c) => !claimedAbsolutePaths.has(c.absolutePath));
}

// Step 3 — before asking the user to redo anything, check whether this "new" file was already
// imported once before and recorded in the trip's own recovery index (tripIndex.ts). This is
// what makes a fresh install/empty-database scenario NOT mean reassigning species to every
// photo in a trip folder by hand again — see the index's own comment for why it lives inside
// the trip folder itself rather than anywhere Lifer owns.
async function autoRecoverFromIndex(
  tripId: string,
  userId: string,
  sourceFolder: string,
  newFiles: CandidateFile[],
): Promise<{ recovered: number; stillNew: CandidateFile[] }> {
  const speciesByPath = await resolveTripIndexSpecies(
    sourceFolder,
    newFiles.map((f) => f.relativePath),
  );
  if (speciesByPath.size === 0) return { recovered: 0, stillNew: newFiles };

  let recovered = 0;
  const stillNew: CandidateFile[] = [];
  for (const file of newFiles) {
    const speciesId = speciesByPath.get(file.relativePath);
    if (!speciesId) {
      stillNew.push(file);
      continue;
    }
    try {
      await importTripFile(tripId, userId, speciesId, file.absolutePath, sourceFolder, file.relativePath);
      recovered++;
    } catch {
      // A recovery attempt failing (e.g. a corrupt file) shouldn't be silently swallowed —
      // fall back to normal manual review for this one file instead of losing it entirely.
      stillNew.push(file);
    }
  }
  return { recovered, stillNew };
}

export async function scanTrip(tripId: string, userId: string, sourceFolder: string): Promise<ScanResult> {
  const imageCandidates = listCandidateFiles(sourceFolder);
  // RAW files join the relink pass (a moved/renamed RAW original needs the same content-hash
  // recovery a moved JPEG gets) but never findNewFiles below — a bare RAW with no JPEG sibling
  // has no species to review it against, so it's only ever handled by autoLinkMissingRaws.
  const allCandidates = [...imageCandidates, ...listRawFiles(sourceFolder)];
  const { relinked, markedStale, collisions, claimedAbsolutePaths } = await matchAgainstKnownOriginals(tripId, allCandidates);
  const newFiles = findNewFiles(imageCandidates, claimedAbsolutePaths);
  const { recovered, stillNew } = await autoRecoverFromIndex(tripId, userId, sourceFolder, newFiles);
  const rawsLinked = await autoLinkMissingRaws(tripId, sourceFolder);
  return { relinked, markedStale, collisions, recovered, rawsLinked, newFiles: stillNew };
}

/** Path-traversal guard for GET /trips/:id/scan-preview and POST /trips/:id/import — a
 *  relativePath must resolve to somewhere genuinely inside the trip's own source_folder. */
export function resolveWithinTripFolder(sourceFolder: string, relativePath: string): string | null {
  const resolved = path.resolve(sourceFolder, relativePath);
  const root = path.resolve(sourceFolder) + path.sep;
  if (!resolved.startsWith(root)) return null;
  if (!existsSync(resolved) || !statSync(resolved).isFile()) return null;
  return resolved;
}
