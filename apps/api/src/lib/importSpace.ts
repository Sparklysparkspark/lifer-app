// How much room an import needs besides the originals, and whether the drives holding Lifer's
// working files and its database have it. An import never fills the drive PostgreSQL lives on:
// below CRITICAL_FREE new import work is refused (507 disk_full) and the Import page pauses.
import { stat, statfs } from "node:fs/promises";
import path from "node:path";
import { APP_DATA_DIR } from "@lifer/core/config.js";
import { DiskFullError } from "@lifer/core/lib/freeSpace.js";
import { uploadWorkDir } from "./uploadWorkDir.js";

const MB = 1e6;
const GB = 1e9;

// Bytes per photo, from the sizes the code writes. Previews (core/uploads/image.ts: 2560, 1024
// and 400 px WebP) measured 0.32 MB on a 24 MP photo; busy scenes run about three times that.
// The same set is made ahead while the user picks species (uploads/preparedAhead.ts) and is a
// second copy until the import takes it. The database holds the capture, photo and original
// rows, the photo's vectors and their index entries, plus WAL until a checkpoint. Working files
// (uploads/workingImage.ts, raw.ts: a decoded HEIC, a 64 MP matching copy, a RAW's preview) live
// only while a file is in flight. Every checked file is also kept whole until it is imported
// (lib/tusUploads.ts, lib/stagedUploads.ts), so the batch's own bytes count once on that drive.
export const IMPORT_BYTES = {
  previews: 1 * MB,
  previewsMadeAhead: 1 * MB,
  database: 0.25 * MB,
  workingPerFileInFlight: 100 * MB,
  filesInFlight: 4,
} as const;

/** Below this on the database's drive, no new import work starts. */
export const CRITICAL_FREE = 3 * GB;
const RESERVE_MIN = 5 * GB;
const RESERVE_SHARE = 0.05;

export type SpaceTier = "ok" | "tight" | "critical";

export interface Volume {
  free: number;
  total: number;
  /** Device id: drives that are the same disk share one budget. */
  dev: number;
}

/** Room kept free on a drive: 5 GB or 5 percent of it, whichever is larger. */
export const reserveFor = (total: number) => Math.max(RESERVE_MIN, total * RESERVE_SHARE);

/** What `files` photos totalling `bytes` add to each role's drive. */
export function estimateImportBytes(files: number, bytes: number) {
  const inFlight = Math.min(files, IMPORT_BYTES.filesInFlight) * IMPORT_BYTES.workingPerFileInFlight;
  return {
    uploads: bytes + inFlight,
    appData: files * (IMPORT_BYTES.previews + IMPORT_BYTES.previewsMadeAhead),
    database: files * IMPORT_BYTES.database,
  };
}

/** One drive's tier: critical under CRITICAL_FREE, tight when the batch and the reserve don't fit. */
export function tierFor(v: Pick<Volume, "free" | "total">, need: number): SpaceTier {
  if (v.free < CRITICAL_FREE) return "critical";
  return v.free < need + reserveFor(v.total) ? "tight" : "ok";
}

export interface SpaceCheck {
  tier: SpaceTier;
  /** Free bytes on the fullest drive involved; null when no drive reported its size. */
  free: number | null;
  /** Bytes to free so the rest of the batch fits above CRITICAL_FREE (0 when it does). */
  toFree: number;
}

type Probe = (dir: string) => Promise<Volume | null>;

/** statfs of `dir` or its nearest existing parent; null when the drive won't say (a network share). */
async function statVolume(dir: string): Promise<Volume | null> {
  let at = path.resolve(dir);
  for (;;) {
    try {
      const [s, st] = await Promise.all([statfs(at), stat(at)]);
      const free = Number(s.bavail) * Number(s.bsize);
      const total = Number(s.blocks) * Number(s.bsize);
      return Number.isFinite(free) && total > 0 ? { free, total, dev: st.dev } : null;
    } catch (err) {
      const parent = path.dirname(at);
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) return null;
      at = parent;
    }
  }
}

let probe: Probe = statVolume;
/** Tests stand in a fake drive. */
export function setVolumeProbe(fake: Probe | null): void {
  probe = fake ?? statVolume;
}

// The batch the Import page last asked about, so checks and imports made meanwhile know whether
// to keep fewer temporary files. The page asks again as it goes; a batch it stopped asking about
// is forgotten.
const BATCH_TTL_MS = 10 * 60_000;
let batch = { files: 0, bytes: 0, at: 0 };

/** Checks the drives an import writes to (uploads, previews, the database) for `files` photos of
 *  `bytes`. Drives that are one disk add their needs together. */
export async function checkImportSpace(files: number, bytes: number, remember = false): Promise<SpaceCheck> {
  if (remember) batch = { files, bytes, at: Date.now() };
  const need = estimateImportBytes(files, bytes);
  const roles: Array<[string, number]> = [
    [uploadWorkDir(), need.uploads],
    [APP_DATA_DIR, need.appData],
    [process.env.LIFER_PG_DATA || APP_DATA_DIR, need.database],
  ];
  const drives = new Map<number, { v: Volume; need: number }>();
  for (const [dir, n] of roles) {
    const v = await probe(dir);
    if (!v) continue;
    const d = drives.get(v.dev);
    if (d) d.need += n;
    else drives.set(v.dev, { v, need: n });
  }
  const rank: Record<SpaceTier, number> = { ok: 0, tight: 1, critical: 2 };
  let out: SpaceCheck = { tier: "ok", free: null, toFree: 0 };
  for (const { v, need: n } of drives.values()) {
    const tier = tierFor(v, n);
    const toFree = Math.max(0, n + CRITICAL_FREE - v.free);
    if (rank[tier] > rank[out.tier] || (rank[tier] === rank[out.tier] && (out.free === null || v.free < out.free)))
      out = { tier, free: v.free, toFree: tier === "critical" ? Math.max(toFree, CRITICAL_FREE - v.free) : toFree };
  }
  return out;
}

/** The tier for the batch the Import page is working through. */
export async function currentImportTier(): Promise<SpaceTier> {
  const live = Date.now() - batch.at < BATCH_TTL_MS;
  return (await checkImportSpace(live ? batch.files : 0, live ? batch.bytes : 0)).tier;
}

/** The 507 body for a full drive (DiskFullError, or ENOSPC from any write), else null. */
export function diskFullBody(err: unknown) {
  const full =
    err instanceof DiskFullError
      ? err
      : (err as NodeJS.ErrnoException | null)?.code === "ENOSPC"
        ? new DiskFullError(0, 0, "")
        : null;
  return full && { error: full.message, code: full.code, needed: full.needed, free: full.free, path: full.path };
}

/** Refuses new import work that would take a drive Lifer depends on under CRITICAL_FREE. */
export async function assertImportRoom(bytes: number): Promise<void> {
  const check = await checkImportSpace(1, Math.max(0, bytes));
  if (check.free === null) return;
  const after = check.free - bytes;
  if (check.tier === "critical" || after < CRITICAL_FREE)
    throw new DiskFullError(Math.max(check.toFree, CRITICAL_FREE - after), check.free, "");
}
