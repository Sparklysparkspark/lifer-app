// Free-space checks shared by every download, copy and export. Unknown free space (a network
// drive that reports nothing useful, a missing path) never blocks: the ENOSPC catch is the backstop.
import { readdir, stat, statfs } from "node:fs/promises";
import path from "node:path";

export const ROOM_MARGIN = 1.1;

export class DiskFullError extends Error {
  readonly code = "disk_full";
  constructor(
    readonly needed: number,
    readonly free: number,
    readonly path: string,
  ) {
    super(needed > 0 ? `Needs ${formatBytes(needed)}, ${formatBytes(free)} free` : "Not enough free space");
    this.name = "DiskFullError";
  }
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

/** Bytes free on the volume holding `target` (or its nearest existing parent); null if unknown. */
export async function freeSpace(target: string): Promise<number | null> {
  let dir = path.resolve(target);
  for (;;) {
    try {
      const s = await statfs(dir);
      const free = Number(s.bavail) * Number(s.bsize);
      return Number.isFinite(free) && free > 0 ? free : null;
    } catch (err) {
      const parent = path.dirname(dir);
      if ((err as NodeJS.ErrnoException).code !== "ENOENT" || parent === dir) return null;
      dir = parent;
    }
  }
}

/** Throws DiskFullError unless `bytes` (plus a 10% margin) fit where `target` lives. */
export async function ensureRoom(target: string, bytes: number): Promise<void> {
  if (!(bytes > 0)) return;
  const free = await freeSpace(target);
  const needed = Math.ceil(bytes * ROOM_MARGIN);
  if (free != null && free < needed) throw new DiskFullError(Math.ceil(bytes), free, target);
}

export function isDiskFull(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === "ENOSPC";
}

/** Total size of every file under `dir`; 0 when it doesn't exist. */
export async function dirSizeBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSizeBytes(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}
