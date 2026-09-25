// Libraries used to keep their photos in a "Lifer Photos" subfolder of the chosen folder; now the
// chosen folder is the library itself (see config.ts's ORIGINALS_DIR). Someone who flattens an
// existing library, by moving everything in "Lifer Photos" up a level or by pointing Docker's
// /data at the "Lifer Photos" folder itself, leaves the database pointing at
// ".../Lifer Photos/Birds/..." while the files are now at ".../Birds/...". This runs at startup
// and rewrites those stored paths, but only for files actually found at the new location, so a
// half-finished move keeps working for whatever hasn't moved yet. Idempotent: once rewritten,
// nothing matches the old prefix.
import { existsSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { DATA_DIR, LEGACY_ORIGINALS_DIR, ORIGINALS_DIR } from "../config.js";

export async function adoptFlatLibraryLayout(): Promise<void> {
  if (ORIGINALS_DIR !== DATA_DIR) return; // still on the "Lifer Photos" layout
  const oldPrefix = LEGACY_ORIGINALS_DIR;
  const moved = (oldPath: string) => DATA_DIR + oldPath.slice(oldPrefix.length);

  const stale = await pool.query<{ id: string; ref: string }>(
    `SELECT id, ref FROM originals WHERE managed = true AND ref_type = 'path' AND ref LIKE $1 || '/%'`,
    [oldPrefix],
  );
  const originalIds = stale.rows.filter((r) => !existsSync(r.ref) && existsSync(moved(r.ref))).map((r) => r.id);

  // Trip and scan folders that lived inside "Lifer Photos" moved along with it.
  const folderRows = async (table: "trips" | "scan_roots", column: "source_folder" | "path") => {
    const res = await pool.query<{ id: string; p: string }>(
      `SELECT id, ${column} AS p FROM ${table} WHERE ${column} = $1 OR ${column} LIKE $1 || '/%'`,
      [oldPrefix],
    );
    return res.rows.filter((r) => !existsSync(r.p) && existsSync(moved(r.p))).map((r) => r.id);
  };
  const tripIds = await folderRows("trips", "source_folder");
  const scanRootIds = await folderRows("scan_roots", "path");
  if (originalIds.length + tripIds.length + scanRootIds.length === 0) return;

  const swap = (column: string) => `${column} = $2 || substring(${column} from length($1) + 1)`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE originals SET ${swap("ref")} WHERE id = ANY($3::uuid[])`, [oldPrefix, DATA_DIR, originalIds]);
    await client.query(`UPDATE trips SET ${swap("source_folder")} WHERE id = ANY($3::uuid[])`, [oldPrefix, DATA_DIR, tripIds]);
    await client.query(`UPDATE scan_roots SET ${swap("path")} WHERE id = ANY($3::uuid[])`, [oldPrefix, DATA_DIR, scanRootIds]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[library] Couldn't update photo locations after the library was flattened:", err);
    return;
  } finally {
    client.release();
  }
  const left = stale.rows.length - originalIds.length;
  console.log(
    `[library] The library no longer uses a "${path.basename(oldPrefix)}" subfolder: updated ${originalIds.length} photo location(s)` +
      (tripIds.length ? `, ${tripIds.length} trip folder(s)` : "") +
      (scanRootIds.length ? `, ${scanRootIds.length} scan folder(s)` : "") +
      (left ? `. ${left} file(s) weren't found at the new location and were left as they were.` : "."),
  );
}
