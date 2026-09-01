// Lets an ALREADY-INSTALLED app pick up a freshly-republished catalog seed (updated
// occurrence_count/rarity tiers/endemic labels/etc from the maintainer's own backfill and
// recompute passes) — the gap flagged and researched earlier this session: embedded_db.rs's
// restore_catalog_seed_if_needed only ever fires for a brand-new, empty database, so every
// future catalog-latest republish previously never reached an install past its very first
// launch. This is the merge path for everyone else.
//
// Deliberately NOT a re-run of embedded_db.rs's own restore (a plain INSERT dump replay, which
// assumes empty tables and would violate primary-key conflicts here) — this UPSERTs by primary
// key instead, and — critically — never touches each install's own local file-path columns
// (species.reference_display_path/reference_thumb_path, species_reference_photos.display_path/
// thumb_path). Those are absolute paths into THIS install's own cache directory; the seed
// always carries them as NULL (see build-catalog-seed.ts's own stripping step), so blindly
// overwriting them would silently disconnect every already-downloaded reference photo on every
// existing install. Everything else in the seed (occurrence stats, rarity tiers, endemic
// labels, the remote reference_photo URL/credit/license, descriptions) is genuinely portable
// catalog metadata and gets refreshed.
//
// Pure `pg` driver, no psql subprocess: the packaged desktop app never bundles a psql binary
// (only the Rust/Tauri layer has direct access to the theseus-managed one, via
// postgresql_commands::psql — see embedded_db.rs), and the self-hosted Docker deployment can't
// be assumed to have one either. Parsing pg_dump's plain-text COPY format directly and issuing
// parameterized INSERT ... ON CONFLICT batches works identically in both deployment shapes with
// zero new external dependencies.
import { gunzipSync } from "node:zlib";
import type { Pool } from "pg";
import { CATALOG_MANIFEST_URL, CATALOG_SEED_URL } from "../config.js";

export interface CatalogManifest {
  version: number;
  publishedAt: string;
}

export async function fetchCatalogManifest(): Promise<CatalogManifest> {
  const res = await fetch(CATALOG_MANIFEST_URL);
  if (!res.ok) throw new Error(`Couldn't check for a catalog update: HTTP ${res.status}`);
  return (await res.json()) as CatalogManifest;
}

export async function checkCatalogUpdate(
  pool: Pool,
  userId: string,
): Promise<{ available: boolean; remoteVersion: number; localVersion: number | null }> {
  const manifest = await fetchCatalogManifest();
  const res = await pool.query<{ catalog_seed_version: string | null }>(
    `SELECT catalog_seed_version FROM users WHERE id = $1`,
    [userId],
  );
  const localVersion = res.rows[0]?.catalog_seed_version != null ? Number(res.rows[0].catalog_seed_version) : null;
  return { available: localVersion == null || manifest.version > localVersion, remoteVersion: manifest.version, localVersion };
}

// Table order matters: species before the tables that FK into it (species_traits,
// species_rarity, species_reference_photos, region_species), regions before region_species/
// sea_zone_species — same order build-catalog-seed.ts's own CATALOG_TABLES list already
// established (proven to replay correctly for the fresh-install case), reused here rather than
// re-derived.
const MERGE_TABLES: Array<{ table: string; pkColumns: string[]; excludeFromUpdate: string[] }> = [
  { table: "species", pkColumns: ["id"], excludeFromUpdate: ["reference_display_path", "reference_thumb_path"] },
  { table: "species_reference_photos", pkColumns: ["id"], excludeFromUpdate: ["display_path", "thumb_path"] },
  { table: "species_traits", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "species_rarity", pkColumns: ["species_id"], excludeFromUpdate: [] },
  { table: "regions", pkColumns: ["id"], excludeFromUpdate: [] },
  { table: "region_species", pkColumns: ["region_id", "species_id"], excludeFromUpdate: [] },
  { table: "sea_zones", pkColumns: ["id"], excludeFromUpdate: [] },
  { table: "sea_zone_species", pkColumns: ["sea_zone_id", "species_id"], excludeFromUpdate: [] },
];

interface ParsedCopyBlock {
  columns: string[];
  rows: (string | null)[][];
}

// pg_dump's plain-text COPY format: tab-separated fields, `\N` for NULL, and `\\`/`\t`/`\n`/`\r`
// backslash-escapes within a field (the only four COPY TO TEXT ever emits) — decoded in that
// order so a literal backslash isn't double-unescaped into any of the others.
function unescapeCopyField(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => {
    if (ch === "t") return "\t";
    if (ch === "n") return "\n";
    if (ch === "r") return "\r";
    return ch; // covers "\\" -> "\\"; anything else pg_dump never actually emits
  });
}

function parseCopyBlock(sql: string, table: string): ParsedCopyBlock | null {
  const headerMatch = sql.match(new RegExp(`^COPY (?:public\\.)?${table} \\(([^)]+)\\) FROM stdin;\\n`, "m"));
  if (!headerMatch) return null;
  const columns = headerMatch[1].split(",").map((c) => c.trim());
  const startIdx = headerMatch.index! + headerMatch[0].length;
  const endIdx = sql.indexOf("\n\\.\n", startIdx);
  if (endIdx === -1) throw new Error(`Malformed COPY block for ${table}: no terminator found`);
  const body = sql.slice(startIdx, endIdx);
  if (!body) return { columns, rows: [] };
  const rows = body.split("\n").map((line) =>
    line.split("\t").map((field) => (field === "\\N" ? null : unescapeCopyField(field))),
  );
  return { columns, rows };
}

// Downloads + decompresses the seed, parses each catalog table's COPY block, and UPSERTs every
// row by primary key — refreshing every column except each table's own excluded local-path
// columns. Batches of 500 rows per INSERT keep each statement's parameter count (columns × 500)
// well under Postgres's ~65535 bind-parameter limit even for the widest table (species_traits,
// ~25 columns).
const BATCH_SIZE = 500;

export async function applyCatalogUpdate(pool: Pool, userId: string): Promise<{ merged: Record<string, number> }> {
  const manifest = await fetchCatalogManifest();
  const res = await fetch(CATALOG_SEED_URL);
  if (!res.ok) throw new Error(`Couldn't download the catalog update: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  const sql = gunzipSync(gz).toString("utf8");

  const merged: Record<string, number> = {};
  for (const { table, pkColumns, excludeFromUpdate } of MERGE_TABLES) {
    const parsed = parseCopyBlock(sql, table);
    if (!parsed || parsed.rows.length === 0) {
      merged[table] = 0;
      continue;
    }
    const { columns, rows } = parsed;
    const updateColumns = columns.filter((c) => !pkColumns.includes(c) && !excludeFromUpdate.includes(c));
    const conflictTarget = pkColumns.join(", ");
    const setClause =
      updateColumns.length > 0
        ? `DO UPDATE SET ${updateColumns.map((c) => `${c} = EXCLUDED.${c}`).join(", ")}`
        : "DO NOTHING";

    let count = 0;
    for (let i = 0; i < rows.length; i += BATCH_SIZE) {
      const batch = rows.slice(i, i + BATCH_SIZE);
      const values: unknown[] = [];
      const rowPlaceholders = batch.map((row, rowIdx) => {
        const placeholders = row.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`);
        values.push(...row);
        return `(${placeholders.join(", ")})`;
      });
      await pool.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${rowPlaceholders.join(", ")}
         ON CONFLICT (${conflictTarget}) ${setClause}`,
        values,
      );
      count += batch.length;
    }
    merged[table] = count;
  }

  await pool.query(`UPDATE users SET catalog_seed_version = $1 WHERE id = $2`, [manifest.version, userId]);
  return { merged };
}
