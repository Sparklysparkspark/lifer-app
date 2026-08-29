// One-time backfill for a fix in image.ts: generateDerivatives used to write user photo
// thumb/display caches under DATA_DIR (the user's own chosen "Storage location") instead of
// APP_DATA_DIR (the app's private cache dir) — unlike generateReferenceDerivatives, which
// already got this right (see that function's own comment). Anyone who collected photos before
// this fix has files sitting under the OLD DATA_DIR/display and DATA_DIR/thumb with DB rows
// pointing at them; this moves both onto the correct APP_DATA_DIR location. Run once at
// startup (see index.ts) rather than as a manual script — DATA_DIR and APP_DATA_DIR are the
// same directory for a self-hosted server deployment (APP_DATA_DIR defaults to DATA_DIR — see
// config.ts), so this is a genuine no-op there; it only ever does real work for a desktop
// install where the two differ. Idempotent: only touches files/rows that still need moving.
import { existsSync, mkdirSync, readdirSync, renameSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { DATA_DIR, APP_DATA_DIR } from "../config.js";

export async function migrateDerivativesLocation(): Promise<void> {
  if (DATA_DIR === APP_DATA_DIR) return; // server deployment — nothing to move

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
        if (!entry.isFile()) continue;
        const to = path.join(newDir, entry.name);
        if (existsSync(to)) continue; // already moved by a previous run
        renameSync(path.join(oldDir, entry.name), to);
        filesMoved++;
      }
    } catch (err) {
      console.error(`[migrateDerivativesLocation] couldn't scan ${oldDir}, skipping:`, err);
    }
  }
  if (filesMoved === 0) return;

  const client = await pool.connect();
  let rowsUpdated = 0;
  try {
    await client.query("BEGIN");
    for (const [sub, column] of [
      ["display", "display_path"],
      ["thumb", "thumb_path"],
    ] as const) {
      const res = await client.query(
        `UPDATE photos SET ${column} = $2 || substring(${column} from length($1) + 1) WHERE ${column} LIKE $1 || '/%'`,
        [path.join(DATA_DIR, sub), path.join(APP_DATA_DIR, sub)],
      );
      rowsUpdated += res.rowCount ?? 0;
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  console.log(`[migrateDerivativesLocation] moved ${filesMoved} file(s), updated ${rowsUpdated} photos row(s)`);
}
