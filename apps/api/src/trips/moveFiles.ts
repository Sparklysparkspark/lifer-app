// "Move trip files" and "Point to where I moved them" on a trip.
// Moving puts each of the trip's Lifer-managed files at the same place under the chosen folder
// (a hard link on the same drive, else a copy checked byte for byte), saves its new path, and
// only then removes the original. One file at a time, so a cancel or a crash leaves every file
// either moved and recorded or untouched. Files Lifer doesn't manage (the user's own, linked
// where they are) move only when the user asks, by the same steps. Relinking only changes stored paths, after checking each file is
// at the new place.
import { constants, existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { access, mkdir, rmdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { idleJobStatus } from "@lifer/shared";
import { pool } from "@lifer/core/db.js";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";
import { DiskFullError, ROOM_MARGIN, formatBytes, freeSpace } from "@lifer/core/lib/freeSpace.js";
import { uniqueDestination } from "@lifer/core/lib/safeFs.js";
import { log } from "@lifer/core/lib/log.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { createJob, type JobContext } from "../lib/job.js";
import { IdParams, Nullable, Open, jobStatusFields, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { writeFileAtomicSync } from "../lib/atomicWrite.js";
import { removeEmptyDirsUpward } from "../lib/fsCleanup.js";
import { linkOrCopyOriginal, removeOriginal } from "../lib/originalsWrite.js";
import { locateManagedOriginal } from "../uploads/managedFolders.js";
import { findSidecarPath, metadataGoesInFile, sidecarPathFor } from "../uploads/exif.js";
import { tagWithRegisteredVolume, type VolumeTag } from "../storageVolumes/resolve.js";
import { isTripBusy } from "./jobs.js";

// Written when a move starts and removed when it ends, so a move cut short by a quit or crash
// carries on at the next start (resumeTripFileMove).
const journalPath = () => path.join(APP_DATA_DIR, "trip-file-move.json");
// Enough to show what went wrong; the counts cover the rest.
const MAX_DETAILS = 500;

type DetailReason = "missing" | "notManaged" | "outside" | "sizeDiffers" | "failed";
interface Detail {
  file: string;
  reason: DetailReason;
  message?: string;
}

interface TripRow {
  id: string;
  name: string;
  source_folder: string;
  destination_folder: string;
}

interface OriginalRow {
  id: string;
  capture_id: string;
  ref: string;
  managed: boolean;
  file_size: string | null;
  /** The size when Lifer last fingerprinted it, after any metadata it wrote into the file. */
  fp_size: string | null;
  volume_id: string | null;
  volume_relative_path: string | null;
}

export async function loadTrip(userId: string, tripId: string): Promise<TripRow | null> {
  const res = await pool.query<TripRow>(
    `SELECT id, name, source_folder, destination_folder FROM trips WHERE id = $1 AND user_id = $2`,
    [tripId, userId],
  );
  return res.rows[0] ?? null;
}

// Every file of the trip's photos, trashed and hidden ones included, so the folder moves whole.
export async function tripOriginals(userId: string, tripId: string): Promise<OriginalRow[]> {
  const res = await pool.query<OriginalRow>(
    `SELECT o.id, o.capture_id, o.ref, o.managed, o.file_size, o.fp_size, o.volume_id, o.volume_relative_path
       FROM originals o JOIN captures_all c ON c.id = o.capture_id
      WHERE c.trip_id = $1 AND o.user_id = $2 AND o.ref_type = 'path'
      ORDER BY o.ref`,
    [tripId, userId],
  );
  return res.rows;
}

class FolderError extends Error {}

/** A path as the disk spells it: the native realpath also takes the stored letter case on a
 *  case-insensitive drive, so a folder picked as "wildlife" compares equal to "Wildlife". */
export function onDisk(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return canonicalPath(p);
  }
}

/** The chosen folder, which may not exist yet: its nearest existing parent must be a folder Lifer
 *  may use. */
async function resolveTarget(folder: string): Promise<{ target: string; existing: string }> {
  if (!path.isAbsolute(folder)) throw new FolderError("Choose a folder");
  let existing = path.resolve(folder);
  const rest: string[] = [];
  while (!(await isDirectory(existing))) {
    if (await stat(existing).catch(() => null)) throw new FolderError("That's a file, not a folder");
    const parent = path.dirname(existing);
    if (parent === existing) throw new FolderError("That folder can't be used");
    rest.unshift(path.basename(existing));
    existing = parent;
  }
  const allowed = onDisk(assertAllowedPath(existing));
  return { target: path.join(allowed, ...rest), existing: allowed };
}

type Problem = "same_folder" | "inside_current" | "contains_current" | "read_only" | "no_room";
// "same_folder": everything is already in the folder picked, which the trip already saves to.

/** dev:ino of `p` and of each existing folder above it, nearest first. Compares folders by
 *  identity, since realpath keeps a different letter case on a case-insensitive drive. */
async function folderIds(p: string): Promise<string[]> {
  const ids: string[] = [];
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    const s = await stat(dir, { bigint: true }).catch(() => null);
    if (s && s.ino > 0n) ids.push(`${s.dev}:${s.ino}`);
    if (path.dirname(dir) === dir) return ids;
  }
}

interface PlanItem {
  id: string;
  captureId: string;
  from: string;
  rel: string;
  size: number;
  dev: number;
  /** The folder it keeps its place under, removed upward from once emptied. */
  root: string;
  /** The user's own file, linked where it was: moved only when they asked. */
  linked: boolean;
}

interface MovePlan {
  target: string;
  items: PlanItem[];
  /** Already under the chosen folder: moved by an earlier run that was stopped. */
  already: number;
  skipped: Detail[];
  missing: Detail[];
  /** On a drive that isn't connected: counted as failed, so the trip keeps its folder. */
  offline: Detail[];
  bytes: number;
  /** What has to be copied (files going to another drive); a same-drive move takes no room. */
  neededBytes: number;
  freeBytes: number | null;
  problem: Problem | null;
  message: string | null;
}

async function planMove(userId: string, trip: TripRow, folder: string, includeLinked = false): Promise<MovePlan> {
  const { target, existing } = await resolveTarget(folder);
  const root = onDisk(trip.destination_folder);
  // A linked file in a trip made from a folder may sit in that folder rather than the wildlife one.
  const sourceRoot = onDisk(trip.source_folder);
  // A subfolder of the trip's folder is a fine target: what's already in it counts as moved.
  const targetReal = onDisk(target);
  const items: PlanItem[] = [];
  const skipped: Detail[] = [];
  const missing: Detail[] = [];
  const offline: Detail[] = [];
  let already = 0;
  for (const row of await tripOriginals(userId, trip.id)) {
    if (!row.managed && !includeLinked) {
      skipped.push({ file: row.ref, reason: "notManaged" });
      continue;
    }
    // Resolves a file on a registered drive; null when that drive isn't connected.
    const found = await locateManagedOriginal(userId, { ...row, trip_destination: trip.destination_folder });
    if (!found) {
      offline.push({ file: row.ref, reason: "failed", message: "Its drive isn't connected" });
      continue;
    }
    const from = onDisk(found.path);
    if (isWithin(targetReal, from)) {
      already++;
      continue;
    }
    // Where the file keeps its place: the wildlife folder, or else the trip's own folder (a file
    // saved before the wildlife folder was changed, or the user's own linked one).
    const itemRoot = isWithin(root, from) ? root : isWithin(sourceRoot, from) ? sourceRoot : null;
    if (!itemRoot) {
      skipped.push({ file: from, reason: "outside" });
      continue;
    }
    const s = await stat(from).catch(() => null);
    if (!s?.isFile()) {
      missing.push({ file: from, reason: "missing" });
      continue;
    }
    items.push({
      id: row.id,
      captureId: row.capture_id,
      from,
      rel: path.relative(itemRoot, from),
      size: s.size,
      dev: s.dev,
      root: itemRoot,
      linked: !row.managed,
    });
  }

  const targetDev = (await stat(existing)).dev;
  let bytes = 0;
  let neededBytes = 0;
  for (const item of items) {
    bytes += item.size;
    if (item.dev !== targetDev) neededBytes += item.size;
  }
  const freeBytes = await freeSpace(existing);
  const writable = await access(existing, constants.W_OK).then(
    () => true,
    () => false,
  );

  const targetIds = await folderIds(existing);
  const targetExists = existing === target;
  const idsOf = (dir: string) =>
    stat(dir).then(
      () => folderIds(dir),
      (): string[] => [],
    );
  const idOf = async (dir: string) => (await idsOf(dir))[0];
  /** `dir` is inside the target folder (or is it), by path or by identity on disk. */
  const holds = async (dir: string) =>
    isWithin(targetReal, dir) || (targetExists && (await idsOf(dir)).includes(targetIds[0]));
  /** The target is inside `dir` by identity but not by path: another mount or alias of it. */
  const aliasInside = async (dir: string) => {
    const id = await idOf(dir);
    return !isWithin(dir, targetReal) && !!id && targetIds.includes(id);
  };
  const chose = (folder: string) => ` You chose ${target}. The trip's folder is ${folder}.`;
  let problem: Problem | null = null;
  let message: string | null = null;
  // Files already in the target count as moved, so the folder the trip saves to is a fine pick
  // while files elsewhere in the trip's folder still need to come in. Refused: a folder that holds
  // the trip's folders (the trip would claim all of it), and an alias of a folder inside them,
  // where files already there wouldn't be recognised and would be nested again.
  const holdsRoot = targetReal !== root && (await holds(root));
  const holdsSource = targetReal !== sourceRoot && (await holds(sourceRoot));
  if (holdsRoot || holdsSource) {
    problem = "contains_current";
    message = `That folder contains the trip's folder.${chose(holdsSource ? trip.source_folder : trip.destination_folder)}`;
  } else if ((await aliasInside(root)) || (await aliasInside(sourceRoot))) {
    problem = "inside_current";
    message = `Choose the folder through the trip's own folder path.${chose(trip.source_folder)}`;
  } else if (
    items.length === 0 &&
    already > 0 &&
    (targetReal === root || (targetExists && targetIds[0] === (await idOf(root))))
  ) {
    problem = "same_folder";
    message = "All of this trip's files are already in that folder, and new photos are saved there";
  } else if (items.length > 0 && !writable) {
    problem = "read_only";
    message = "Lifer can't save files in that folder. Choose another, or check the folder's permissions";
  } else if (freeBytes != null && neededBytes * ROOM_MARGIN > freeBytes) {
    problem = "no_room";
    message = `Not enough space there: the files need ${formatBytes(neededBytes)} and ${formatBytes(freeBytes)} is free`;
  }
  return { target, items, already, skipped, missing, offline, bytes, neededBytes, freeBytes, problem, message };
}

/** The very same file reached by two spellings: already where it should be, so left untouched. */
async function isSameEntry(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
  return sa.ino > 0n && sa.ino === sb.ino && sa.dev === sb.dev && sa.nlink === 1n;
}

async function isSecondLink(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a, { bigint: true }), stat(b, { bigint: true })]);
  return sa.ino > 0n && sa.ino === sb.ino && sa.dev === sb.dev && sa.nlink > 1n;
}

/** The stored path for a file now at `dest` under `target`, on the target's volume when it has one. */
export function refFor(dest: string, target: string, tag: VolumeTag): [string, string | null, string | null] {
  if (!tag.volumeId) return [dest, null, null];
  return [dest, tag.volumeId, path.join(tag.volumeRelativePath || path.sep, path.relative(target, dest))];
}

/** Moves one file and records it; returns where it went. Never overwrites: a name already taken
 *  by another file gets a "-2" beside it. */
async function moveOne(item: PlanItem, target: string, tag: VolumeTag): Promise<string | null> {
  const dir = path.join(target, path.dirname(item.rel));
  const name = path.basename(item.rel);
  await mkdir(dir, { recursive: true });
  let dest = path.join(dir, name);
  // A run cut short may have linked this very file there already. Only a second link counts: the
  // same entry under another spelling (a case-insensitive drive) has one link, and is the original.
  // shortcut: a copy an earlier run made across drives isn't recognised, so it stays as a spare
  // "-2"; recognise it by an originals row pointing at it if that ever matters.
  if (existsSync(dest) && (await isSameEntry(item.from, dest))) return null;
  const placedBefore = existsSync(dest) && (await isSecondLink(item.from, dest));
  if (!placedBefore) {
    dest = await uniqueDestination(dir, name);
    await linkOrCopyOriginal(item.from, dest);
  }
  try {
    const res = await pool.query(
      `UPDATE originals SET ref = $1, volume_id = $2, volume_relative_path = $3, stale = false WHERE id = $4`,
      [...refFor(dest, target, tag), item.id],
    );
    if (res.rowCount === 0) throw new Error("The photo was deleted while its files were moving");
  } catch (err) {
    // Not recorded, so the original stays the photo; the spare copy goes.
    await removeOriginal(dest).catch(() => {});
    throw err;
  }
  // Recorded: a failed delete only leaves a spare copy behind.
  await removeOriginal(item.from).catch((err: unknown) =>
    log.warn({ err, ref: item.from }, "[trip-move] Moved a file but couldn't delete the old copy"),
  );
  return dest;
}

/** A RAW's or video's sidecar follows it, so other apps' edits stay with the file. */
async function moveSidecar(from: string, dest: string): Promise<void> {
  if (metadataGoesInFile(from)) return;
  const sidecar = await findSidecarPath(from);
  const to = sidecarPathFor(dest);
  if (!sidecar || existsSync(to)) return;
  await linkOrCopyOriginal(sidecar, to);
  await removeOriginal(sidecar);
}

/** The trip's recovery record (tripIndex.ts) goes with its files. */
async function moveTripIndex(oldRoot: string, target: string): Promise<void> {
  const from = path.join(oldRoot, ".lifer", "index.json");
  const to = path.join(target, ".lifer", "index.json");
  if (!existsSync(from) || existsSync(to)) return;
  await mkdir(path.dirname(to), { recursive: true });
  await linkOrCopyOriginal(from, to);
  await removeOriginal(from);
  await rmdir(path.dirname(from)).catch(() => {});
}

const STOPS_EVERYTHING = new Set(["ENOSPC", "EACCES", "EPERM", "EROFS"]);

function plainMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (err instanceof DiskFullError || code === "ENOSPC") return "The drive is full";
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "Lifer isn't allowed to save files there";
  return (err as Error).message;
}

interface MoveCounts {
  tripId: string | null;
  tripName: string | null;
  folder: string | null;
  moved: number;
  skipped: number;
  missing: number;
  failed: number;
}

interface MoveResult extends Omit<MoveCounts, "tripId" | "tripName" | "folder"> {
  tripId: string;
  tripName: string;
  folder: string;
  /** How many of the moved files were the user's own linked ones. */
  linkedMoved: number;
  /** The trip now points at the new folder: every file there was moved. */
  folderUpdated: boolean;
  /** Why the move stopped early, when a full drive or a refused write stopped it. */
  stopReason: string | null;
  details: Detail[];
  /** Details past the first MAX_DETAILS, counted only. */
  moreDetails: number;
}

const IDLE_COUNTS: MoveCounts = {
  tripId: null,
  tripName: null,
  folder: null,
  moved: 0,
  skipped: 0,
  missing: 0,
  failed: 0,
};

// One move at a time, whoever asks: two moves at once would compete for the same drive.
export const tripFileMoveJob = createJob<MoveResult, MoveCounts>("trip-file-move", IDLE_COUNTS);
let jobUserId: string | null = null;

/** The trip whose files are moving, if any. */
export const movingTripId = (): string | null =>
  tripFileMoveJob.status.running ? tripFileMoveJob.status.tripId : null;

async function runMove(
  ctx: JobContext<MoveResult, MoveCounts>,
  userId: string,
  tripId: string,
  folder: string,
  includeLinked: boolean,
): Promise<MoveResult> {
  const trip = await loadTrip(userId, tripId);
  if (!trip) throw new Error("This trip no longer exists");
  ctx.update({ tripName: trip.name, phase: "checking" });
  const plan = await planMove(userId, trip, folder, includeLinked);
  if (plan.problem) throw new Error(plan.message!);
  const counts = {
    moved: plan.already,
    skipped: plan.skipped.length,
    missing: plan.missing.length,
    failed: plan.offline.length,
  };
  ctx.update({ ...counts, folder: plan.target, phase: "moving", total: plan.items.length, processed: 0 });
  await mkdir(plan.target, { recursive: true });
  const tag = await tagWithRegisteredVolume(userId, plan.target);
  let linkedMoved = 0;
  const failures: Detail[] = [];
  const movedCaptures = new Set<string>();
  let stopReason: string | null = null;

  for (const [i, item] of plan.items.entries()) {
    // Stops between files, so every file is either moved and recorded or untouched.
    if (ctx.signal.aborted) break;
    // A drive unplugged mid-move: creating folders again would put them on the wrong disk.
    if (!existsSync(plan.target)) {
      stopReason = "The folder isn't there any more. Was its drive disconnected?";
      break;
    }
    ctx.update({ currentItem: path.basename(item.from) });
    try {
      const dest = await moveOne(item, plan.target, tag);
      counts.moved++;
      // Null: the file already was where it should be (the same file under another spelling).
      if (dest) {
        if (item.linked) linkedMoved++;
        movedCaptures.add(item.captureId);
        await moveSidecar(item.from, dest).catch((err: unknown) =>
          log.warn({ err, ref: item.from }, "[trip-move] Couldn't move a sidecar with its file"),
        );
        await removeEmptyDirsUpward(path.dirname(item.from), item.root).catch(() => {});
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT" && !existsSync(item.from)) {
        counts.missing++;
        plan.missing.push({ file: item.from, reason: "missing" });
      } else {
        counts.failed++;
        failures.push({ file: item.from, reason: "failed", message: plainMessage(err) });
        log.warn({ err, ref: item.from }, "[trip-move] Couldn't move a file");
        const code = (err as NodeJS.ErrnoException).code;
        // Every later file would fail the same way.
        if (err instanceof DiskFullError || (code && STOPS_EVERYTHING.has(code))) {
          stopReason = plainMessage(err);
          break;
        }
      }
    }
    ctx.update({ ...counts, processed: i + 1 });
  }

  const folderUpdated = !ctx.signal.aborted && stopReason === null && counts.failed === 0;
  if (folderUpdated) {
    ctx.update({ phase: "finishing", currentItem: null });
    await pool.query(
      `UPDATE trips SET destination_folder = $2,
              source_folder = CASE WHEN source_folder = destination_folder AND NOT $3 THEN $2 ELSE source_folder END
        WHERE id = $1`,
      // A started trip's folder is its source too, and follows, unless the new folder is inside it
      // (a Wildlife folder in the trip's folder): then it stays where Lifer looks for new photos.
      [tripId, plan.target, isWithin(onDisk(trip.source_folder), onDisk(plan.target))],
    );
    await moveTripIndex(trip.destination_folder, plan.target).catch((err: unknown) =>
      log.warn({ err }, "[trip-move] Couldn't move the trip's recovery record"),
    );
    // Only goes when nothing is left in it.
    await rmdir(trip.destination_folder).catch(() => {});
  }
  if (movedCaptures.size > 0) {
    // The records kept beside the photos name them by path, so they follow. Loaded here: the
    // album modules import the upload modules this one does.
    const { syncAlbumIndexForCaptures } = await import("../albums/albumIndex.js");
    const { scheduleTripRecordsSave } = await import("../lib/libraryRecords.js");
    await syncAlbumIndexForCaptures([...movedCaptures]).catch((err: unknown) =>
      log.warn({ err }, "[trip-move] Couldn't update album records"),
    );
    scheduleTripRecordsSave(userId);
  }
  const details = [...plan.offline, ...failures, ...plan.missing, ...plan.skipped];
  return {
    tripId,
    tripName: trip.name,
    folder: plan.target,
    ...counts,
    linkedMoved,
    folderUpdated,
    stopReason,
    details: details.slice(0, MAX_DETAILS),
    moreDetails: Math.max(0, details.length - MAX_DETAILS),
  };
}

function startMove(userId: string, tripId: string, folder: string, includeLinked: boolean): boolean {
  if (tripFileMoveJob.status.running) return false;
  writeFileAtomicSync(journalPath(), JSON.stringify({ userId, tripId, folder, includeLinked }));
  jobUserId = userId;
  return tripFileMoveJob.start(
    async (ctx) => {
      try {
        return await runMove(ctx, userId, tripId, folder, includeLinked);
      } finally {
        // Done, cancelled or failed: only a quit or crash leaves the journal for a resume.
        rmSync(journalPath(), { force: true });
      }
    },
    { tripId, phase: "checking" },
  );
}

/** At startup: carries on a move a quit or crash cut short. Files it already moved are found in
 *  the new folder and counted as moved. */
export async function resumeTripFileMove(): Promise<void> {
  let saved: { userId: string; tripId: string; folder: string; includeLinked?: boolean };
  try {
    saved = JSON.parse(readFileSync(journalPath(), "utf8"));
  } catch {
    return;
  }
  // Cut short after the trip took its new folder: nothing is left to do.
  const trip = await loadTrip(saved.userId, saved.tripId);
  if (!trip || canonicalPath(trip.destination_folder) === canonicalPath(saved.folder)) {
    rmSync(journalPath(), { force: true });
    return;
  }
  log.info({ tripId: saved.tripId }, "[trip-move] Resuming a move of a trip's files that was cut short");
  startMove(saved.userId, saved.tripId, saved.folder, saved.includeLinked === true);
}

/** Each file under `root`, looked for at the same place under `target` with the size Lifer
 *  recorded. Also used when Lifer notices a trip's folder moved (movedPhotos/relink.ts). */
export async function findUnderNewRoot(rows: OriginalRow[], root: string, target: string) {
  const found: Array<{ id: string; ref: string }> = [];
  const details: Detail[] = [];
  let missing = 0;
  let sizeDiffers = 0;
  let outside = 0;
  for (const row of rows) {
    const old = canonicalPath(row.ref);
    if (!isWithin(root, old)) {
      outside++;
      continue;
    }
    const candidate = path.join(target, path.relative(root, old));
    const s = await stat(candidate).catch(() => null);
    const sizeOk =
      row.file_size == null ||
      Number(row.file_size) === s?.size ||
      (row.fp_size != null && Number(row.fp_size) === s?.size);
    if (!s?.isFile()) {
      missing++;
      details.push({ file: candidate, reason: "missing" });
    } else if (!sizeOk) {
      sizeDiffers++;
      details.push({ file: candidate, reason: "sizeDiffers" });
    } else found.push({ id: row.id, ref: candidate });
  }
  return { found, details, missing, sizeDiffers, outside };
}

const tripNotFound = notFoundOnInvalidId("Trip not found");
const FolderBody = Type.Object(
  {
    folder: Type.String({ minLength: 1 }),
    includeLinked: Type.Optional(
      Type.Boolean({
        description: "Also move the user's own files linked where they are (copied, checked, then removed)",
      }),
    ),
  },
  { additionalProperties: false },
);
const DetailSchema = Open({
  file: Type.String(),
  reason: Type.Enum(["missing", "notManaged", "outside", "sizeDiffers", "failed"]),
  message: Type.Optional(Type.String()),
});
const CountFields = {
  moved: Type.Integer(),
  skipped: Type.Integer({ description: "Kept where they are: not managed by Lifer, or outside the trip's folder" }),
  missing: Type.Integer(),
  failed: Type.Integer(),
};
export const TripFileMoveStatus = Open({
  ...jobStatusFields(
    Open({
      tripId: Type.String(),
      tripName: Type.String(),
      folder: Type.String(),
      ...CountFields,
      linkedMoved: Type.Integer({ description: "Of those moved, the user's own linked files" }),
      folderUpdated: Type.Boolean(),
      stopReason: Nullable(Type.String()),
      details: Type.Array(DetailSchema),
      moreDetails: Type.Integer(),
    }),
  ),
  tripId: Nullable(Type.String()),
  tripName: Nullable(Type.String()),
  folder: Nullable(Type.String()),
  ...CountFields,
});
const MoveCheck = Open({
  folder: Type.String({ description: "The chosen folder, as it will be used" }),
  files: Type.Integer({ description: "Files that will move" }),
  bytes: Type.Number(),
  neededBytes: Type.Number({ description: "Space the move takes there (files coming from another drive)" }),
  freeBytes: Nullable(Type.Number()),
  alreadyThere: Type.Integer(),
  notManaged: Type.Integer({
    description: "The user's own files, linked where they are: moved only with includeLinked (then counted in files)",
  }),
  outside: Type.Integer({ description: "Files outside the trip's folder, which stay where they are" }),
  missing: Type.Integer(),
  problem: Nullable(Type.Enum(["same_folder", "inside_current", "contains_current", "read_only", "no_room"])),
  message: Nullable(Type.String()),
});
const RelinkResult = Open({
  total: Type.Integer(),
  found: Type.Integer(),
  missing: Type.Integer(),
  sizeDiffers: Type.Integer(),
  outside: Type.Integer(),
  details: Type.Array(DetailSchema),
  moreDetails: Type.Integer(),
  applied: Type.Boolean(),
});

/** A 400 for a folder that can't be used, else rethrows. */
function folderErrorReply(err: unknown): { error: string } {
  if (err instanceof FolderError) return { error: err.message };
  throw err;
}

export async function tripFileMoveRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // What a move to `folder` would do, for the confirm step. Changes nothing.
  app.post(
    "/trips/:id/move-files/check",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, body: FolderBody, response: replies(MoveCheck) },
    },
    async (request, reply) => {
      const trip = await loadTrip(request.user!.id, request.params.id);
      if (!trip) return reply.code(404).send({ error: "Trip not found" });
      let plan: MovePlan;
      try {
        plan = await planMove(request.user!.id, trip, request.body.folder, request.body.includeLinked);
      } catch (err) {
        return reply.code(400).send(folderErrorReply(err));
      }
      const count = (reason: DetailReason) => plan.skipped.filter((d) => d.reason === reason).length;
      return {
        folder: plan.target,
        files: plan.items.length,
        bytes: plan.bytes,
        neededBytes: plan.neededBytes,
        freeBytes: plan.freeBytes,
        alreadyThere: plan.already,
        notManaged: count("notManaged") + plan.items.filter((i) => i.linked).length,
        outside: count("outside"),
        missing: plan.missing.length + plan.offline.length,
        problem: plan.problem,
        message: plan.message,
      };
    },
  );

  app.post(
    "/trips/:id/move-files",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, body: FolderBody, response: replies(Type.Object({ started: Type.Boolean() })) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripId = request.params.id;
      const trip = await loadTrip(userId, tripId);
      if (!trip) return reply.code(404).send({ error: "Trip not found" });
      if (tripFileMoveJob.status.running)
        return reply.code(409).send({ error: "Files are already moving. Try again once that's done" });
      if (isTripBusy(tripId))
        return reply.code(409).send({ error: "Wait for this trip's scan or import to finish first" });
      // Checked here too, so a refused folder is refused before a single file is touched.
      let plan: MovePlan;
      try {
        plan = await planMove(userId, trip, request.body.folder, request.body.includeLinked);
      } catch (err) {
        return reply.code(400).send(folderErrorReply(err));
      }
      if (plan.problem) return reply.code(400).send({ error: plan.message! });
      if (plan.items.length + plan.already === 0)
        return reply.code(400).send({ error: "This trip has no files Lifer can move" });
      if (!startMove(userId, tripId, request.body.folder, request.body.includeLinked === true))
        return reply.code(409).send({ error: "Files are already moving. Try again once that's done" });
      return { started: true };
    },
  );

  app.get(
    "/trips/move-files/status",
    { preValidation: requireScope("trips.read"), schema: { response: replies(TripFileMoveStatus) } },
    async (request) =>
      // Someone else's move on a shared server isn't theirs to see.
      jobUserId === request.user!.id ? tripFileMoveJob.status : { ...idleJobStatus(), ...IDLE_COUNTS },
  );

  app.post(
    "/trips/move-files/cancel",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) } },
    async (request) => ({ cancelled: jobUserId === request.user!.id && tripFileMoveJob.cancel() }),
  );

  // "Point to where I moved them": the user moved the trip's folder. Each file is looked for at
  // the same place under `folder` and must have the size Lifer recorded. Without `apply` it only
  // reports; with it, the files found and the trip's folder are updated in one transaction.
  app.post(
    "/trips/:id/relink",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          { folder: Type.String({ minLength: 1 }), apply: Type.Optional(Type.Boolean()) },
          { additionalProperties: false },
        ),
        response: replies(RelinkResult),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const trip = await loadTrip(userId, request.params.id);
      if (!trip) return reply.code(404).send({ error: "Trip not found" });
      if (movingTripId() === trip.id) return reply.code(409).send({ error: "This trip's files are moving right now" });
      if (!path.isAbsolute(request.body.folder)) return reply.code(400).send({ error: "Choose a folder" });
      const target = assertAllowedPath(request.body.folder);
      if (!(await isDirectory(target))) return reply.code(400).send({ error: "That folder doesn't exist" });

      const rows = await tripOriginals(userId, trip.id);
      const { found, details, missing, sizeDiffers, outside } = await findUnderNewRoot(
        rows,
        onDisk(trip.destination_folder),
        target,
      );

      const apply = request.body.apply === true;
      if (apply) {
        if (found.length === 0 && rows.length > 0)
          return reply.code(400).send({ error: "None of this trip's photos are in that folder" });
        const tag = await tagWithRegisteredVolume(userId, target);
        const refs = found.map((f) => refFor(f.ref, target, tag));
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `UPDATE originals o SET ref = u.ref, volume_id = u.volume_id::uuid,
                    volume_relative_path = u.rel, stale = false
               FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS u(id, ref, volume_id, rel)
              WHERE o.id = u.id`,
            [found.map((f) => f.id), refs.map((r) => r[0]), refs.map((r) => r[1]), refs.map((r) => r[2])],
          );
          await client.query(
            `UPDATE trips SET destination_folder = $2,
                    source_folder = CASE WHEN source_folder = destination_folder AND NOT $3 THEN $2 ELSE source_folder END
              WHERE id = $1`,
            [trip.id, target, isWithin(onDisk(trip.source_folder), onDisk(target))],
          );
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      }
      return {
        total: rows.length,
        found: found.length,
        missing,
        sizeDiffers,
        outside,
        details: details.slice(0, MAX_DETAILS),
        moreDetails: Math.max(0, details.length - MAX_DETAILS),
        applied: apply,
      };
    },
  );
}
