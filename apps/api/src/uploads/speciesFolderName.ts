// The human-browsable folder a species' originals live in. commonName has no DB-level
// uniqueness constraint, so two species can genuinely share one (regional/taxonomic overlap
// in source data) — when that happens, EVERY species sharing that common name gets suffixed
// with its scientific name, not just whichever one collided second, so the resulting folder
// name is the same no matter which species is uploaded/rescanned first. Without this, two
// species' photos (and, worse, a future library reimport reading them back) could silently
// land in — or be read from — the same folder.
import { pool } from "../db.js";

function sanitizeForFilesystem(name: string): string {
  // Slashes would create unintended subfolders; the rest are characters Windows/macOS/Linux
  // either forbid outright or that just make a folder name awkward to look at/type.
  return name.replace(/[/\\:*?"<>|]/g, "").trim();
}

export async function resolveSpeciesFolderName(commonName: string | null, scientificName: string): Promise<string> {
  const base = sanitizeForFilesystem(commonName ?? scientificName);
  if (!commonName) return base;
  const collision = await pool.query(`SELECT 1 FROM species WHERE common_name = $1 AND scientific_name != $2 LIMIT 1`, [
    commonName,
    scientificName,
  ]);
  if (collision.rows.length === 0) return base;
  return `${base} (${scientificName})`;
}
