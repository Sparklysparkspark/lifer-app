// Settings' "Reorganize": re-files every managed original under the folder layout the user's
// current settings ask for (managedFolders.ts decides where), then rewrites the moved captures'
// metadata. Each file stays under the folder it was filed under, never moved to another.
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import type { JobContext } from "../lib/job.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { extractExif } from "./exif.js";
import { locateManagedOriginal, organizedFolderFor } from "./managedFolders.js";
import { syncCaptureXmpSidecarsLogged } from "./xmpSidecarSync.js";

export interface ReorganizeCounts {
  moved: number;
  skipped: number;
  failed: number;
  /** Why the latest failed file couldn't be moved, so "3 failed" can be looked into. */
  lastError: string | null;
}

export interface ReorganizeResult extends ReorganizeCounts {
  total: number;
}

export const REORGANIZE_IDLE_COUNTS: ReorganizeCounts = { moved: 0, skipped: 0, failed: 0, lastError: null };

/** Moves `current` to `dest` (a rename, or a copy across drives) and then runs `saveRef`. If
 *  saving fails the file is put back, so the stored path still points at it. */
export async function moveOriginalFile(current: string, dest: string, saveRef: () => Promise<void>): Promise<void> {
  let copied = false;
  try {
    await rename(current, dest);
  } catch {
    try {
      await copyFile(current, dest);
    } catch (err) {
      await rm(dest, { force: true }).catch(() => {});
      throw err;
    }
    copied = true;
  }
  try {
    await saveRef();
  } catch (err) {
    if (copied) await rm(dest, { force: true }).catch(() => {});
    else await rename(dest, current).catch(() => {});
    throw err;
  }
  // The move already happened and is recorded, so a leftover source isn't a failed move.
  if (copied)
    await rm(current, { force: true }).catch((err) =>
      log.warn({ err, ref: current }, "[reorganize] Moved an original but couldn't delete its old copy"),
    );
}

/** `counts` is the job's live status, updated as files are handled. */
export async function runReorganize(
  ctx: JobContext<ReorganizeResult, ReorganizeCounts>,
  userId: string,
  counts: ReorganizeCounts,
): Promise<ReorganizeResult> {
  const settings = await getUserFileSettings(userId);

  const originalsRes = await pool.query<{
    id: string;
    ref: string;
    kind: string;
    capture_id: string | null;
    species_id: string | null;
    scientific_name: string | null;
    taken_at: Date | null;
    location_label: string | null;
    volume_id: string | null;
    volume_relative_path: string | null;
    trip_destination: string | null;
  }>(
    // captures_all without trashed ones: a hidden photo's files are organized like any other.
    `SELECT o.id, o.ref, o.kind, o.capture_id, o.volume_id, o.volume_relative_path,
            COALESCE(c.species_id, o.species_id) AS species_id,
            COALESCE(s1.scientific_name, s2.scientific_name) AS scientific_name,
            c.taken_at, c.location_label, t.destination_folder AS trip_destination
     FROM originals o
     LEFT JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
     LEFT JOIN trips t ON t.id = c.trip_id
     LEFT JOIN species s1 ON s1.id = c.species_id
     LEFT JOIN species s2 ON s2.id = o.species_id
     WHERE o.managed = true AND o.user_id = $1`,
    [userId],
  );
  const total = originalsRes.rows.length;
  ctx.update({ phase: "moving", total, processed: 0 });
  const bump = () => ctx.update({ processed: counts.moved + counts.skipped + counts.failed });

  // A file moves exactly when its species label changed, which also makes its embedded EXIF/XMP
  // label stale. Collect those captures and resync their metadata after the move loop.
  const captureIdsToResync = new Set<string>();
  for (const original of originalsRes.rows) {
    // Stops between files; the files already moved stay moved and get their metadata resynced.
    if (ctx.signal.aborted) break;
    ctx.update({ currentItem: path.basename(original.ref) });
    // One on a drive that isn't connected, or outside every folder Lifer files into, is left alone.
    const location =
      original.species_id && original.scientific_name ? await locateManagedOriginal(userId, original) : null;
    if (!location?.root || !existsSync(location.path)) {
      counts.skipped++;
      bump();
      continue;
    }
    const current = location.path;
    // Unmatched RAWs (capture_id NULL, filed straight into a species' own folder) have no
    // captures.taken_at to read a year from; the file's own EXIF is the only place left to look.
    const takenAt = original.capture_id ? original.taken_at : (await extractExif(current)).takenAt;

    const folder = await organizedFolderFor(
      userId,
      location,
      { kind: original.kind, speciesId: original.species_id!, takenAt, locationLabel: original.location_label },
      settings,
    );
    const dest = folder ? path.join(folder, path.basename(current)) : current;
    if (!folder || path.resolve(dest) === path.resolve(current)) {
      counts.skipped++;
      bump();
      continue;
    }
    try {
      await mkdir(folder, { recursive: true });
      if (existsSync(dest)) {
        // Another original already sits at this organized path: skip rather than overwrite.
        counts.skipped++;
        bump();
        continue;
      }
      const oldFolder = path.dirname(current);
      // A file on a drive or library root stays on it: its volume path follows the move.
      const volumeRelativePath = location.mountPath ? dest.slice(location.mountPath.length) : null;
      await moveOriginalFile(current, dest, async () => {
        await pool.query(
          `UPDATE originals SET ref = $1, volume_relative_path = COALESCE($2, volume_relative_path) WHERE id = $3`,
          [dest, volumeRelativePath, original.id],
        );
      });
      counts.moved++;
      if (original.capture_id) captureIdsToResync.add(original.capture_id);
      // Tidying the now-empty old folder is cosmetic, not part of the move.
      try {
        await removeEmptyDirsUpward(oldFolder, location.root);
      } catch (err) {
        log.warn(`[reorganize] Couldn't clean up ${oldFolder}: ${(err as Error).message}`);
      }
    } catch (err) {
      counts.failed++;
      counts.lastError = `${path.basename(current)}: ${(err as Error).message}`;
      log.warn({ err, ref: current, dest }, "[reorganize] Couldn't move an original");
    }
    bump();
  }

  // Best-effort: a stale embedded label or XMP sidecar is recoverable (the next reassignment or
  // reorganize pass fixes it) and shouldn't fail the whole job. Failures are logged there.
  ctx.update({ phase: "updating_metadata", currentItem: null });
  for (const captureId of captureIdsToResync) await syncCaptureXmpSidecarsLogged(userId, captureId);

  return { moved: counts.moved, skipped: counts.skipped, failed: counts.failed, lastError: counts.lastError, total };
}
