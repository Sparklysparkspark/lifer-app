// Startup migration: moves display/thumb caches from DATA_DIR to APP_DATA_DIR and rewrites their
// rows. Idempotent; the row rewrite always runs, so an interrupted run finishes next start.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { DATA_DIR, APP_DATA_DIR } from "../config.js";
import { log } from "../lib/log.js";

const DERIVATIVE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i;

export async function migrateDerivativesLocation(): Promise<void> {
  if (DATA_DIR === APP_DATA_DIR) return; // an explicit APP_DATA_DIR=DATA_DIR setup, nothing to move

  let filesMoved = 0;
  for (const sub of ["display", "thumb"] as const) {
    const oldDir = path.join(DATA_DIR, sub);
    const newDir = path.join(APP_DATA_DIR, sub);
    if (!existsSync(oldDir)) continue;
    // A folder can exist but not be listable (macOS privacy controls, e.g. Desktop). Best effort:
    // skip it and leave the files where they are, still found at their old path.
    try {
      mkdirSync(newDir, { recursive: true });
      for (const entry of readdirSync(oldDir, { withFileTypes: true })) {
        // Only Lifer's own "<uuid>.webp"-style files: in the flat layout this folder sits among
        // the user's own, and a folder of theirs could happen to be called "display".
        if (!entry.isFile() || !DERIVATIVE_FILE.test(entry.name)) continue;
        const to = path.join(newDir, entry.name);
        if (existsSync(to)) continue; // already moved by a previous run
        moveFile(path.join(oldDir, entry.name), to);
        filesMoved++;
      }
    } catch (err) {
      log.error({ err, dir: oldDir }, "Couldn't scan an old derivatives folder, skipping it");
    }
  }
  const client = await pool.connect();
  let rowsUpdated = 0;
  try {
    await client.query("BEGIN");
    for (const [sub, column] of [
      ["display", "display_path"],
      ["thumb", "thumb_path"],
    ] as const) {
      const oldDir = path.join(DATA_DIR, sub);
      const newDir = path.join(APP_DATA_DIR, sub);
      const stale = await client.query<{ id: string; p: string }>(
        `SELECT id, ${column} AS p FROM photos WHERE ${column} LIKE $1 || '/%'`,
        [oldDir],
      );
      // Only rows whose file really did move: one still at its old path (a move that failed
      // for it) keeps working where it is.
      const ids: string[] = [];
      for (const row of stale.rows) {
        if (!existsSync(row.p) && existsSync(path.join(newDir, row.p.slice(oldDir.length + 1)))) ids.push(row.id);
      }
      if (ids.length === 0) continue;
      const res = await client.query(
        `UPDATE photos SET ${column} = $2 || substring(${column} from length($1) + 1) WHERE id = ANY($3::uuid[])`,
        [oldDir, newDir, ids],
      );
      rowsUpdated += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  if (filesMoved > 0 || rowsUpdated > 0) {
    log.info({ filesMoved, rowsUpdated }, "Moved derivatives to the app data folder");
  }
}

// rename when both folders share a filesystem, copy + delete when they don't (EXDEV).
function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    copyFileSync(from, to);
    rmSync(from, { force: true });
  }
}
