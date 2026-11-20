// Walks the places photos live and keeps seen_folders/seen_files current. Stat only: a folder
// whose mtime hasn't changed since the last walk isn't listed again (its files are as recorded),
// only its subfolders are visited. Files are never read here.
import { opendir, stat } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { pool } from "@lifer/core/db.js";
import { identityOf } from "./fingerprint.js";

const FLUSH = 500;
const YIELD_EVERY = 200;

export interface WalkStats {
  folders: number;
  /** Folders unchanged since the last walk, so not listed again. */
  foldersSkipped: number;
  /** Files stat'ed this walk (in changed folders). */
  filesStatted: number;
  /** Folders Lifer isn't allowed to read, skipped. */
  unreadable: string[];
}

interface FileRow {
  path: string;
  folder: string;
  name: string;
  size: number;
  mtimeMs: number;
  fileId: string | null;
}

async function upsertFiles(rows: FileRow[]): Promise<void> {
  if (rows.length === 0) return;
  // A file whose size or mtime changed gets its quick hash read again when it's next needed.
  await pool.query(
    `INSERT INTO seen_files (path, folder, name, size, mtime_ms, file_id)
     SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::float8[], $6::text[])
     ON CONFLICT (path) DO UPDATE SET folder = EXCLUDED.folder, name = EXCLUDED.name, size = EXCLUDED.size,
       mtime_ms = EXCLUDED.mtime_ms, file_id = EXCLUDED.file_id,
       quick_hash = CASE WHEN seen_files.size = EXCLUDED.size AND seen_files.mtime_ms = EXCLUDED.mtime_ms
                         THEN seen_files.quick_hash END`,
    [
      rows.map((r) => r.path),
      rows.map((r) => r.folder),
      rows.map((r) => r.name),
      rows.map((r) => r.size),
      rows.map((r) => r.mtimeMs),
      rows.map((r) => r.fileId),
    ],
  );
}

async function forgetFolder(dir: string): Promise<void> {
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  await pool.query(`DELETE FROM seen_files WHERE folder = $1 OR starts_with(folder, $2)`, [dir, prefix]);
  await pool.query(`DELETE FROM seen_folders WHERE path = $1 OR starts_with(path, $2)`, [dir, prefix]);
}

/** Brings the index of every file under `roots` up to date. `extensions` (lower case, with the
 *  dot) limits it to the kinds of files the library has. */
export async function walkPlaces(
  roots: string[],
  extensions: Set<string>,
  signal: AbortSignal,
  onProgress: (stats: WalkStats) => void = () => {},
): Promise<WalkStats> {
  const known = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const r of (
    await pool.query<{ path: string; parent: string | null; mtime_ms: number }>(
      `SELECT path, parent, mtime_ms FROM seen_folders`,
    )
  ).rows) {
    known.set(r.path, r.mtime_ms);
    if (r.parent) children.set(r.parent, [...(children.get(r.parent) ?? []), r.path]);
  }

  const stats: WalkStats = { folders: 0, foldersSkipped: 0, filesStatted: 0, unreadable: [] };
  const stack = roots.map((root) => ({ dir: root, parent: null as string | null }));
  let sinceYield = 0;
  const tick = async () => {
    if (++sinceYield < YIELD_EVERY) return;
    sinceYield = 0;
    onProgress(stats);
    await yieldToLoop();
    signal.throwIfAborted();
  };

  while (stack.length > 0) {
    const { dir, parent } = stack.pop()!;
    signal.throwIfAborted();
    let mtimeMs: number;
    try {
      const s = await stat(dir, { bigint: true });
      if (!s.isDirectory()) continue;
      mtimeMs = Number(s.mtimeMs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") await forgetFolder(dir);
      else stats.unreadable.push(dir);
      continue;
    }
    stats.folders++;
    await tick();
    if (known.get(dir) === mtimeMs) {
      stats.foldersSkipped++;
      for (const child of children.get(dir) ?? []) stack.push({ dir: child, parent: dir });
      continue;
    }

    let handle;
    try {
      handle = await opendir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") await forgetFolder(dir);
      else stats.unreadable.push(dir);
      continue;
    }
    const files: FileRow[] = [];
    const present: string[] = [];
    const subdirs: string[] = [];
    for await (const entry of handle) {
      // Dot-folders are Lifer's own (.lifer) or the system's. Symlinks aren't followed: one inside
      // the places is walked at its real path anyway, and one outside them is out of bounds.
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        subdirs.push(full);
        continue;
      }
      if (!entry.isFile() || !extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const s = await stat(full, { bigint: true }).catch(() => null);
      if (!s) continue;
      const id = identityOf(s);
      present.push(full);
      files.push({
        path: full,
        folder: dir,
        name: entry.name.toLowerCase(),
        size: id.size,
        mtimeMs: id.mtimeMs,
        fileId: id.fileId,
      });
      stats.filesStatted++;
      if (files.length >= FLUSH) await upsertFiles(files.splice(0));
      await tick();
    }
    await upsertFiles(files);
    await pool.query(`DELETE FROM seen_files WHERE folder = $1 AND NOT (path = ANY($2::text[]))`, [dir, present]);
    const now = new Set(subdirs);
    for (const old of children.get(dir) ?? []) if (!now.has(old)) await forgetFolder(old);
    // Subfolders are recorded unwalked (mtime -1) first, so a walk cut short still visits them
    // under this folder; the folder itself last, so it's listed again if that happens before.
    await pool.query(
      `INSERT INTO seen_folders (path, parent, mtime_ms) SELECT unnest($1::text[]), $2, -1 ON CONFLICT (path) DO NOTHING`,
      [subdirs, dir],
    );
    await pool.query(
      `INSERT INTO seen_folders (path, parent, mtime_ms) VALUES ($1, $2, $3)
       ON CONFLICT (path) DO UPDATE SET parent = EXCLUDED.parent, mtime_ms = EXCLUDED.mtime_ms`,
      [dir, parent, mtimeMs],
    );
    for (const sub of subdirs) stack.push({ dir: sub, parent: dir });
  }
  onProgress(stats);
  return stats;
}
