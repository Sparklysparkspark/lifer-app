// Settings' "Reorganize": re-files every managed original under the folder layout the user's
// current settings ask for (managedFolders.ts decides where), then rewrites the moved captures'
// metadata. Each file stays under the folder it was filed under, never moved to another, except
// when its photo's trip changed (ReorganizeOnly.followTrip).
import { existsSync } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { ORIGINALS_DIR } from "@lifer/core/config.js";
import { log } from "@lifer/core/lib/log.js";
import { DiskFullError, ensureRoom, isDiskFull } from "@lifer/core/lib/freeSpace.js";
import { createJob, type JobContext } from "../lib/job.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { PLACE_FOLDER_LEVELS, keepsOriginalName } from "@lifer/shared";
import {
  extractExif,
  findSidecarPath,
  metadataGoesInFile,
  preserveFileName,
  readPreservedFileName,
  sidecarPathFor,
} from "./exif.js";
import { locateManagedOriginal, organizedFolderFor, type ManagedFileLocation } from "./managedFolders.js";
import { tagWithRegisteredVolume } from "../storageVolumes/resolve.js";
import { syncCaptureXmpSidecarsLogged } from "./xmpSidecarSync.js";
import { getFileNameTemplate } from "../settings/metadataSettings.js";
import { captureFacts, nextSeq, renderFileStem, stemPattern, templateValues } from "./templateVars.js";

/** The name the file name template gives a capture's file in `folder`. A name that already
 *  follows the template is kept, so running Reorganize again renames nothing; a capture's other
 *  files (its RAW, its video) take the name its first file got. */
async function templatedName(
  template: string,
  captureId: string,
  current: string,
  folder: string,
  chosen: Map<string, string>,
): Promise<string> {
  const ext = path.extname(current);
  const currentStem = path.basename(current, ext);
  const known = chosen.get(captureId);
  if (known) return `${known}${ext}`;
  const facts = await captureFacts(captureId);
  if (!facts) return path.basename(current);
  const preserved = await readPreservedFileName(current);
  const original = preserved ? path.basename(preserved, path.extname(preserved)) : currentStem;
  const values = await templateValues({ ...facts, original });
  let stem = currentStem;
  if (!stemPattern(template, values)?.test(currentStem)) {
    const seq = template.includes("{seq}") ? await nextSeq(folder, template, values) : null;
    stem = renderFileStem(template, { ...values, seq }) ?? currentStem;
  }
  chosen.set(captureId, stem);
  return `${stem}${ext}`;
}

/** `dest`, or the first "-2", "-3"... beside it that's free. */
function freeName(dest: string): string {
  const ext = path.extname(dest);
  const base = dest.slice(0, dest.length - ext.length);
  for (let n = 2; existsSync(dest); n++) dest = `${base}-${n}${ext}`;
  return dest;
}

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
      await ensureRoom(dest, (await stat(current)).size);
      await copyFile(current, dest).catch((err: unknown) => {
        throw isDiskFull(err) ? new DiskFullError(0, 0, dest) : err;
      });
      // Archive health treats a new mtime as an edit, so a copy keeps the original's.
      const { atime, mtime } = await stat(current);
      await utimes(dest, atime, mtime);
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

/** A RAW's or video's sidecar follows it, so other apps' edits stay with the file. */
async function moveSidecar(from: string, to: string): Promise<void> {
  const sidecar = await findSidecarPath(from);
  const target = sidecarPathFor(to);
  if (!sidecar || existsSync(target)) return;
  await rename(sidecar, target).catch((err: unknown) =>
    log.warn({ err, ref: sidecar }, "[reorganize] Couldn't move a sidecar with its file"),
  );
}

/** Limits a run to these captures' files, which then all get their metadata rewritten with
 *  `sync` (their place just changed, so their files' location fields follow). */
export interface ReorganizeOnly {
  captureIds: string[];
  sync?: { replacePlace?: boolean; replaceLabel?: boolean; replaceGps?: boolean };
  /** Their trip just changed, so a file may also change root: into the folder of the trip it's
   *  now in, or out of a trip's folder back to the library. */
  followTrip?: boolean;
}

/** The root a file belongs under once its photo's trip changed: that trip's folder, or the library
 *  for a file leaving a trip's folder. Null when the new root isn't there (a disconnected drive). */
function tripChangeRoot(found: ManagedFileLocation, tripFolder: string | null): ManagedFileLocation | null {
  const root = tripFolder ?? (found.tripRoot ? ORIGINALS_DIR : found.root!);
  if (path.resolve(root) === path.resolve(found.root!)) return found;
  if (!existsSync(root)) return null;
  // Off its old volume: the new path is tagged again once it's known.
  return { path: found.path, mountPath: null, root, tripRoot: !!tripFolder };
}

/** `counts` is the job's live status, updated as files are handled. */
export async function runReorganize(
  ctx: JobContext<ReorganizeResult, ReorganizeCounts>,
  userId: string,
  counts: ReorganizeCounts,
  only?: ReorganizeOnly,
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
    region_id: string | null;
    trip_id: string | null;
    volume_id: string | null;
    volume_relative_path: string | null;
    trip_destination: string | null;
  }>(
    // captures_all without trashed ones: a hidden photo's files are organized like any other.
    `SELECT o.id, o.ref, o.kind, o.capture_id, o.volume_id, o.volume_relative_path,
            COALESCE(c.species_id, o.species_id) AS species_id,
            COALESCE(s1.scientific_name, s2.scientific_name) AS scientific_name,
            c.taken_at, c.location_label, c.region_id, c.trip_id, t.destination_folder AS trip_destination
     FROM originals o
     LEFT JOIN captures_all c ON c.id = o.capture_id AND c.deleted_at IS NULL
     LEFT JOIN trips t ON t.id = c.trip_id
     LEFT JOIN species s1 ON s1.id = c.species_id
     LEFT JOIN species s2 ON s2.id = o.species_id
     WHERE o.managed = true AND o.user_id = $1 AND ($2::uuid[] IS NULL OR o.capture_id = ANY($2::uuid[]))`,
    [userId, only?.captureIds ?? null],
  );
  const total = originalsRes.rows.length;
  // With a file name template, files are renamed too: a capture's main file first, so its RAW and
  // video take the same name.
  const nameTemplate = await getFileNameTemplate(userId);
  const renaming = !keepsOriginalName(nameTemplate);
  const chosenNames = new Map<string, string>();
  if (renaming) originalsRes.rows.sort((a, b) => Number(a.kind === "raw") - Number(b.kind === "raw"));
  // Every trip folder is a root, so a file still in the folder of a trip its photo left is found.
  const tripFolders = only?.followTrip
    ? (
        await pool.query<{ destination_folder: string }>(`SELECT destination_folder FROM trips WHERE user_id = $1`, [
          userId,
        ])
      ).rows.map((r) => r.destination_folder)
    : [];
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
    const found =
      original.species_id && original.scientific_name
        ? await locateManagedOriginal(userId, original, tripFolders)
        : null;
    const location = found?.root && only?.followTrip ? tripChangeRoot(found, original.trip_destination) : found;
    if (!found?.root || !location?.root || !existsSync(found.path)) {
      counts.skipped++;
      bump();
      continue;
    }
    const current = found.path;
    // Unmatched RAWs (capture_id NULL, filed straight into a species' own folder) have no
    // captures.taken_at to read a year from; the file's own EXIF is the only place left to look.
    const takenAt = original.capture_id ? original.taken_at : (await extractExif(current)).takenAt;

    const folder = await organizedFolderFor(
      userId,
      location,
      {
        kind: original.kind,
        speciesId: original.species_id!,
        takenAt,
        locationLabel: original.location_label,
        regionId: original.region_id,
        tripId: original.trip_id,
      },
      settings,
    );
    const name =
      folder && renaming && original.capture_id
        ? await templatedName(nameTemplate, original.capture_id, current, folder, chosenNames)
        : path.basename(current);
    let dest = folder ? path.join(folder, name) : current;
    if (!folder || path.resolve(dest) === path.resolve(current)) {
      counts.skipped++;
      bump();
      continue;
    }
    try {
      await mkdir(folder, { recursive: true });
      if (existsSync(dest)) {
        // Another original already sits at this organized path: a rename takes a free "-2"
        // beside it, a move is skipped. Nothing is ever overwritten.
        if (name === path.basename(current)) {
          counts.skipped++;
          bump();
          continue;
        }
        dest = freeName(dest);
        if (original.capture_id) chosenNames.set(original.capture_id, path.basename(dest, path.extname(dest)));
      }
      // Before the first rename, so {original} still means the camera's name later.
      if (name !== path.basename(current)) await preserveFileName(current, path.basename(current));
      const oldFolder = path.dirname(current);
      // A file on a drive or library root stays on it: its volume path follows the move.
      const volumeRelativePath = location.mountPath ? dest.slice(location.mountPath.length) : null;
      const newVolume = location === found ? null : await tagWithRegisteredVolume(userId, dest);
      await moveOriginalFile(current, dest, async () => {
        if (newVolume)
          await pool.query(`UPDATE originals SET ref = $1, volume_id = $2, volume_relative_path = $3 WHERE id = $4`, [
            dest,
            newVolume.volumeId,
            newVolume.volumeRelativePath,
            original.id,
          ]);
        else
          await pool.query(
            `UPDATE originals SET ref = $1, volume_relative_path = COALESCE($2, volume_relative_path) WHERE id = $3`,
            [dest, volumeRelativePath, original.id],
          );
      });
      counts.moved++;
      if (original.capture_id) captureIdsToResync.add(original.capture_id);
      if (!metadataGoesInFile(current)) await moveSidecar(current, dest);
      // Tidying the now-empty old folder is cosmetic, not part of the move.
      try {
        await removeEmptyDirsUpward(oldFolder, found.root);
      } catch (err) {
        log.warn(`[reorganize] Couldn't clean up ${oldFolder}: ${(err as Error).message}`);
      }
    } catch (err) {
      counts.failed++;
      counts.lastError = `${path.basename(current)}: ${(err as Error).message}`;
      log.warn({ err, ref: current, dest }, "[reorganize] Couldn't move an original");
      // Every later copy to that drive would fail the same way.
      if (err instanceof DiskFullError) {
        bump();
        break;
      }
    }
    bump();
  }

  // Best-effort: a stale embedded label or XMP sidecar is recoverable (the next reassignment or
  // reorganize pass fixes it) and shouldn't fail the whole job. Failures are logged there.
  ctx.update({ phase: "updating_metadata", currentItem: null });
  for (const captureId of only?.captureIds ?? captureIdsToResync)
    await syncCaptureXmpSidecarsLogged(userId, captureId, only?.sync);
  // The records kept beside the photos name them by path, so they follow the moves.
  if (captureIdsToResync.size > 0) {
    // Loaded here: the album modules import this one.
    const { syncAlbumIndexForCaptures } = await import("../albums/albumIndex.js");
    const { scheduleTripRecordsSave } = await import("../lib/libraryRecords.js");
    // Only photos in an album have an album record to follow them.
    const inAlbums = await pool.query<{ capture_id: string }>(
      `SELECT DISTINCT capture_id FROM album_captures WHERE capture_id = ANY($1::uuid[])`,
      [[...captureIdsToResync]],
    );
    await syncAlbumIndexForCaptures(inAlbums.rows.map((r) => r.capture_id)).catch((err: unknown) =>
      log.warn({ err }, "[reorganize] Couldn't update album records"),
    );
    scheduleTripRecordsSave(userId);
  }

  return { moved: counts.moved, skipped: counts.skipped, failed: counts.failed, lastError: counts.lastError, total };
}

// With place folders in the layout, a photo whose place changed (a new region, a renamed, merged or
// removed place name) moves to its new folder through runReorganize, limited to those photos.
// Changes queue up and run one after another, so two never move the same file at once.
export const refileJob = createJob<ReorganizeResult, ReorganizeCounts>("refile-originals", REORGANIZE_IDLE_COUNTS);
const refileQueue: Array<{ userId: string; only: ReorganizeOnly }> = [];

export function refileCaptures(userId: string, only: ReorganizeOnly): void {
  if (only.captureIds.length === 0) return;
  refileQueue.push({ userId, only });
  startRefiling();
}

function startRefiling(): void {
  if (refileQueue.length === 0) return;
  const started = refileJob.start(
    async (ctx) => {
      let total = 0;
      for (let next = refileQueue.shift(); next; next = refileQueue.shift()) {
        total += (await runReorganize(ctx, next.userId, refileJob.status, next.only)).total;
      }
      const { moved, skipped, failed, lastError } = refileJob.status;
      return { moved, skipped, failed, lastError, total };
    },
    { phase: "preparing" },
  );
  // Running already: picked up by that run, or by the next one if it was just finishing.
  if (!started) void refileJob.settled().then(startRefiling);
}

/** After these captures' place changed: their files move to the matching folders when the user
 *  has trip or place folders (and get their metadata rewritten there), else only the metadata is
 *  rewritten, a few at a time in the background. True when files are being moved. */
export async function followPlaceChange(
  userId: string,
  captureIds: string[],
  sync: ReorganizeOnly["sync"],
): Promise<boolean> {
  if (captureIds.length === 0) return false;
  if ((await getUserFileSettings(userId)).layout.some((l) => PLACE_FOLDER_LEVELS.has(l))) {
    refileCaptures(userId, { captureIds, sync });
    return true;
  }
  const limit = createLimiter(4);
  for (const id of captureIds) void limit(() => syncCaptureXmpSidecarsLogged(userId, id, sync));
  return false;
}
