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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { CATALOG_MANIFEST_URL, CATALOG_SEED_URL, BUNDLED_CATALOG_SEED_DIR } from "../config.js";

export interface CatalogManifest {
  version: number;
  publishedAt: string;
}

// Neither fetch() call here previously had a timeout — on a deployment whose outbound network
// can't reach GitHub at all (a restrictive NAS/firewall setup, confirmed as a real case), the
// request just hung forever with no error and no success, leaving the Settings "Updating..."
// button stuck indefinitely. AbortSignal.timeout() turns that into an actual thrown error the
// UI can show instead.
const MANIFEST_TIMEOUT_MS = 15_000;
const SEED_DOWNLOAD_TIMEOUT_MS = 120_000; // the seed itself can be tens of MB gzipped

export async function fetchCatalogManifest(): Promise<CatalogManifest> {
  let res: Response;
  try {
    res = await fetch(CATALOG_MANIFEST_URL, { signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Couldn't check for a catalog update: the request timed out — check this server's network access");
    }
    throw err;
  }
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

async function downloadCatalogSeedSql(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(CATALOG_SEED_URL, { signal: AbortSignal.timeout(SEED_DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error("Couldn't download the catalog update: the download timed out — check this server's network access");
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Couldn't download the catalog update: HTTP ${res.status}`);
  const gz = Buffer.from(await res.arrayBuffer());
  return gunzipSync(gz).toString("utf8");
}

// `regions` self-references (a province's parent_id points at its country, which points at its
// continent) — confirmed live: a fresh-database restore crashed with "insert or update on table
// regions violates foreign key constraint regions_parent_id_fkey" because the generic batched
// upsert below has no guarantee a parent row lands in an earlier batch than its children (pg_dump's
// COPY order reflects the source table's physical row order, not a topological one, and years of
// re-parenting/cleanup scripts on this table only made that less likely to hold by accident). The
// standard fix for a self-referencing table: insert every row with parent_id forced NULL first (no
// row can violate the FK when nothing points at anything yet), then a second pass sets every row's
// real parent_id once every id it could possibly reference already exists in the table.
const SELF_REFERENCING_PARENT_COLUMN: Record<string, string> = { regions: "parent_id" };

async function mergeCatalogTables(pool: Pool, sql: string): Promise<Record<string, number>> {
  const merged: Record<string, number> = {};
  for (const { table, pkColumns, excludeFromUpdate } of MERGE_TABLES) {
    const parsed = parseCopyBlock(sql, table);
    if (!parsed || parsed.rows.length === 0) {
      merged[table] = 0;
      continue;
    }
    const { columns, rows } = parsed;
    const selfRefColumn = SELF_REFERENCING_PARENT_COLUMN[table];
    const selfRefIdx = selfRefColumn ? columns.indexOf(selfRefColumn) : -1;
    const updateColumns = columns.filter(
      (c) => !pkColumns.includes(c) && !excludeFromUpdate.includes(c) && c !== selfRefColumn,
    );
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
        // The self-referencing column's own real value is deliberately NOT sent here (see this
        // function's own comment above) — every other column still gets its real value on this
        // pass; only the parent pointer is deferred to the second pass below.
        const effectiveRow = selfRefIdx === -1 ? row : row.map((v, idx) => (idx === selfRefIdx ? null : v));
        const placeholders = effectiveRow.map((_, colIdx) => `$${rowIdx * columns.length + colIdx + 1}`);
        values.push(...effectiveRow);
        return `(${placeholders.join(", ")})`;
      });
      await pool.query(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${rowPlaceholders.join(", ")}
         ON CONFLICT (${conflictTarget}) ${setClause}`,
        values,
      );
      count += batch.length;
    }

    if (selfRefColumn && selfRefIdx !== -1) {
      const pkIdx = columns.indexOf(pkColumns[0]);
      const rowsWithParent = rows.filter((row) => row[selfRefIdx] != null);
      for (let i = 0; i < rowsWithParent.length; i += BATCH_SIZE) {
        const batch = rowsWithParent.slice(i, i + BATCH_SIZE);
        const values: unknown[] = [];
        const rowPlaceholders = batch.map((row, rowIdx) => {
          values.push(row[pkIdx], row[selfRefIdx]);
          return `($${rowIdx * 2 + 1}, $${rowIdx * 2 + 2})`;
        });
        await pool.query(
          `UPDATE ${table} AS t SET ${selfRefColumn} = v.parent_id::uuid
           FROM (VALUES ${rowPlaceholders.join(", ")}) AS v(id, parent_id)
           WHERE t.${pkColumns[0]} = v.id::uuid`,
          values,
        );
      }
    }

    merged[table] = count;
  }
  return merged;
}

export async function applyCatalogUpdate(pool: Pool, userId: string): Promise<{ merged: Record<string, number> }> {
  const manifest = await fetchCatalogManifest();
  const sql = await downloadCatalogSeedSql();
  const merged = await mergeCatalogTables(pool, sql);
  await pool.query(`UPDATE users SET catalog_seed_version = $1 WHERE id = $2`, [manifest.version, userId]);
  return { merged };
}

// Runs applyCatalogUpdate as a real background job with pollable status, the same shape
// offlinePacks/routes.ts's own downloadJob/runDownloadJob already uses for pack downloads —
// mirrored here because the catalog update had none of that: the whole download+merge used to
// run synchronously inside one HTTP request/response, so navigating away from Settings (which
// unmounts CatalogUpdateSection) lost all knowledge of whether it was still running or had
// finished, and the UI could sit on "Updating..." forever even after the update had actually
// completed (or failed) server-side. Module-level state, not per-request — deliberately a
// single account's worth of state at a time (SINGLE_USER_MODE's usual shape), same as
// downloadJob.
export interface CatalogUpdateJobState {
  running: boolean;
  merged: Record<string, number> | null;
  error: string | null;
  finishedAt: number | null;
}
export const catalogUpdateJob: CatalogUpdateJobState = { running: false, merged: null, error: null, finishedAt: null };

export function startCatalogUpdateJob(pool: Pool, userId: string): void {
  catalogUpdateJob.running = true;
  catalogUpdateJob.merged = null;
  catalogUpdateJob.error = null;
  catalogUpdateJob.finishedAt = null;
  applyCatalogUpdate(pool, userId)
    .then(({ merged }) => {
      catalogUpdateJob.merged = merged;
    })
    .catch((err) => {
      catalogUpdateJob.error = (err as Error).message;
    })
    .finally(() => {
      catalogUpdateJob.running = false;
      catalogUpdateJob.finishedAt = Date.now();
    });
}

function readBundledCatalogSeedSql(): string | null {
  const seedPath = path.join(BUNDLED_CATALOG_SEED_DIR, "lifer-catalog-seed.sql.gz");
  if (!existsSync(seedPath)) return null;
  return gunzipSync(readFileSync(seedPath)).toString("utf8");
}

// Fills a brand-new, empty catalog automatically on server startup — the desktop app has always
// done this itself (embedded_db.rs's restore_catalog_seed_if_needed, bundling a seed at build
// time and restoring it the moment species is found empty), but the Docker/self-hosted image had
// no equivalent: a fresh deployment left `regions`/`species` genuinely empty (blank Offline Packs
// map, empty checklists everywhere) until a user happened to know to click Settings > Update —
// which the README never actually told them to do. Runs the same merge path applyCatalogUpdate
// uses (UPSERT is safe to run against empty tables too — it's just a full seed in that case),
// but skips the per-user catalog_seed_version bookkeeping since there may be no user account yet.
//
// Prefers scripts/fetch-catalog-seed.js's bundled copy (baked into the Docker image at build
// time — see BUNDLED_CATALOG_SEED_DIR's own comment) so first launch works instantly, offline,
// exactly like the desktop app's own bundled restore — a live network fetch only happens as a
// fallback when that bundled file is missing (a local `docker build` run without network, or a
// non-Docker dev setup). Best-effort either way: logged and swallowed on failure so a failed
// auto-seed never blocks the server from starting — Settings > Update remains available as a
// manual retry.
export async function seedCatalogIfEmpty(pool: Pool): Promise<{ seeded: boolean; merged?: Record<string, number> }> {
  const res = await pool.query<{ count: string }>(`SELECT count(*) FROM species`);
  if (Number(res.rows[0].count) > 0) return { seeded: false };
  const sql = readBundledCatalogSeedSql() ?? (await downloadCatalogSeedSql());
  const merged = await mergeCatalogTables(pool, sql);
  return { seeded: true, merged };
}
