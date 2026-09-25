// Reference photos are cached as <app data>/reference-display/<species id>.webp (and
// reference-thumb), and species ids come from the catalog, so they're the same on every
// install. A fresh database (a wiped one, or a reinstall over the same app data) came back with
// no paths recorded, so hundreds of cached photos sat unused while cards fetched them from the
// internet again, or showed nothing offline.
//
// Only runs when no species has a cached photo recorded at all, i.e. the database is fresh. On
// an install in use, a file without a row can be one left on purpose: a catalog update that
// replaces a species' photo clears the old path but not the old file (catalogSeedUpdate.ts).
import { readdirSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { APP_DATA_DIR } from "../config.js";

const UUID_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.webp$/i;

function idsIn(dir: string): Set<string> {
  try {
    return new Set(readdirSync(dir).flatMap((f) => UUID_FILE.exec(f)?.[1].toLowerCase() ?? []));
  } catch {
    return new Set();
  }
}

export async function relinkCachedReferenceFiles(pool: Pool): Promise<number> {
  const anyRecorded = await pool.query(`SELECT 1 FROM species WHERE reference_display_path IS NOT NULL LIMIT 1`);
  if (anyRecorded.rowCount) return 0;
  const displayDir = path.join(APP_DATA_DIR, "reference-display");
  const thumbDir = path.join(APP_DATA_DIR, "reference-thumb");
  const thumbs = idsIn(thumbDir);
  // Both files or neither, so a card and the species page never disagree.
  const ids = [...idsIn(displayDir)].filter((id) => thumbs.has(id));
  if (ids.length === 0) return 0;
  const res = await pool.query(
    `UPDATE species SET reference_display_path = $2 || '/' || id || '.webp', reference_thumb_path = $3 || '/' || id || '.webp'
      WHERE id = ANY($1::uuid[]) AND reference_display_path IS NULL AND reference_thumb_path IS NULL`,
    [ids, displayDir, thumbDir],
  );
  return res.rowCount ?? 0;
}
