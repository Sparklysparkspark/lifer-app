// One-time backfill for a fix in image.ts: generateDerivatives used to write user photo
// thumb/display caches under DATA_DIR (the user's own chosen "Storage location") instead of
// APP_DATA_DIR (the app's private cache dir), unlike generateReferenceDerivatives, which
// already got this right (see that function's own comment). Anyone who collected photos before
// this fix has files sitting under the OLD DATA_DIR/display and DATA_DIR/thumb with DB rows
// pointing at them; this moves both onto the correct APP_DATA_DIR location. Run once at
// startup (see index.ts) rather than as a manual script. Applies to Docker too since
// APP_DATA_DIR became its own volume there (/app-data), which is a different filesystem from
// the /data bind mount, so a plain rename can fail with EXDEV and falls back to copy + delete.
//
// Idempotent, and the row rewrite doesn't depend on this run having moved anything: a previous
// run that moved files but stopped before rewriting rows left photos pointing at files that no
// longer exist (a blank species card). Any row still pointing into the old folder whose file is
// now only in the new one gets fixed on the next start.
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { DATA_DIR, APP_DATA_DIR } from "../config.js";

const DERIVATIVE_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\w+$/i;

export async function migrateDerivativesLocation(): Promise<void> {
  if (DATA_DIR === APP_DATA_DIR) return; // an explicit APP_DATA_DIR=DATA_DIR setup, nothing to move

  let filesMoved = 0;
  for (const sub of ["display", "thumb"] as const) {
    const oldDir = path.join(DATA_DIR, sub);
    const newDir = path.join(APP_DATA_DIR, sub);
    if (!existsSync(oldDir)) continue;
    // existsSync only checks that the path itself is stat-able — a folder can pass that check
    // and still fail to list (macOS TCC blocks scanning some folders' *contents*, e.g. Desktop,
    // independently of whether the folder itself is visible). This is a best-effort one-time
    // backfill, not something worth crashing the whole app's startup over: skip this subfolder
    // and leave those files where they are rather than letting the error propagate — they're
    // still found fine at their old path, just not moved to the newer, correct location yet.
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
      console.error(`[migrateDerivativesLocation] couldn't scan ${oldDir}, skipping:`, err);
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
    console.log(`[migrateDerivativesLocation] moved ${filesMoved} file(s), updated ${rowsUpdated} photos row(s)`);
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
