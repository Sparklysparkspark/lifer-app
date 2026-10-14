// The catalog seed's pg_dump reads copies of the catalog tables in a scratch schema, made with
// local file paths and per-install rows already left out. The source tables are never modified,
// so a crash or kill mid-build leaves nothing to restore: the next build drops the old schema.
import { HUMAN_SCIENTIFIC_NAME } from "@lifer/core/species/neverListed.js";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import type { Pool, PoolClient } from "pg";
import { resolvePgDump } from "./pgDump.js";

export const SEED_SCHEMA = "seed_export";

export const CATALOG_TABLES = [
  "species",
  "species_reference_photos",
  // species_reference_embeddings and species_text_embeddings ship as binary vector assets instead
  // (build-catalog-seed.ts).
  "species_traits",
  "species_rarity",
  // Current GBIF/iNaturalist/eBird names for catalog species (scripts/reconcile-species-names.ts),
  // so installs match a renamed species too (keyword tags on import, species/matchByKeywords.ts).
  "species_synonyms",
  // Duplicate species folded into one (migration 113); installs apply them on update.
  "species_merges",
  // Species split into several (migration 118); installs re-file photos under them by place.
  "species_splits",
  "regions",
  "region_species",
  "sea_zones",
  "sea_zone_species",
  // Non-photo reference images to delete from installs (migration 106).
  "reference_photo_blocklist",
];

// Shipped as NULL. Paths point at the build machine (installs fill them in from region packs or
// a live fetch); photo_checked_at is the pipeline's own bookkeeping (on an install it records that
// install's own attempts, apps/api/src/species/withheldPhotos.ts); per-listing tier explanations
// are ~50 MB and ship in the region packs that show them.
export const STRIPPED_COLUMNS: Record<string, string[]> = {
  species: ["reference_display_path", "reference_thumb_path", "photo_checked_at"],
  species_reference_photos: ["display_path", "thumb_path"],
  region_species: ["tier_explain"],
};

// Other Taxa species (species.is_other_taxa) are personal, per-install additions stored in the
// shared catalog tables, so they and their rows never ship. The column linking each table to them.
export const OTHER_TAXA_COLUMN: Record<string, string> = {
  species: "id",
  species_reference_photos: "species_id",
  species_traits: "species_id",
  species_rarity: "species_id",
  species_merges: "new_species_id",
  species_splits: "parent_species_id",
  region_species: "species_id",
  sea_zone_species: "species_id",
};

// Checklist tables, whose rows for people never ship (the species row itself does, so a photo of
// one still has something to point at).
const CHECKLIST_TABLES = new Set(["region_species", "sea_zone_species"]);

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function dropSeedExportSchema(pool: Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${SEED_SCHEMA} CASCADE`);
}

/** Fills the scratch schema with what the seed ships. Generated columns are left out, as
 *  pg_dump leaves them out of COPY: installs compute them. */
export async function createSeedExportSchema(pool: Pool): Promise<void> {
  // One snapshot for every table, so a refresh writing meanwhile can't leave rows pointing at a
  // parent the copy missed (installs restore with triggers off, so nothing would catch it).
  const db = await pool.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await db.query(`DROP SCHEMA IF EXISTS ${SEED_SCHEMA} CASCADE`);
    await db.query(`CREATE SCHEMA ${SEED_SCHEMA}`);
    await copyCatalogTables(db);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    db.release();
  }
}

async function copyCatalogTables(db: PoolClient): Promise<void> {
  for (const table of CATALOG_TABLES) {
    const cols = await db.query<{ name: string; type: string }>(
      `SELECT attname AS name, format_type(atttypid, atttypmod) AS type FROM pg_attribute
       WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attgenerated = ''
       ORDER BY attnum`,
      [`public.${table}`],
    );
    const stripped = STRIPPED_COLUMNS[table] ?? [];
    for (const c of stripped)
      if (!cols.rows.some((r) => r.name === c))
        throw new Error(`${table}.${c} no longer exists; update STRIPPED_COLUMNS`);
    const select = cols.rows
      .map((c) => (stripped.includes(c.name) ? `NULL::${c.type} AS ${ident(c.name)}` : `t.${ident(c.name)}`))
      .join(", ");
    const link = OTHER_TAXA_COLUMN[table];
    const neverListed = CHECKLIST_TABLES.has(table) ? ` OR s.scientific_name = '${HUMAN_SCIENTIFIC_NAME}'` : "";
    const where = link
      ? `WHERE NOT EXISTS (SELECT 1 FROM public.species s WHERE s.id = t.${ident(link)} AND (s.is_other_taxa${neverListed}))`
      : "";
    await db.query(
      `CREATE TABLE ${SEED_SCHEMA}.${ident(table)} AS SELECT ${select} FROM public.${ident(table)} t ${where}`,
    );
  }
}

/** Renames the scratch schema to public in pg_dump's statements and comments, never inside COPY
 *  data, so the seed restores into public. */
export function seedSchemaToPublic(): Transform {
  let rest = Buffer.alloc(0);
  let inCopy = false;
  const line = (raw: Buffer): Buffer => {
    if (inCopy) {
      if (raw.length === 2 && raw[0] === 0x5c && raw[1] === 0x2e) inCopy = false; // "\."
      return raw;
    }
    const text = raw.toString("utf8");
    if (text.startsWith("COPY ") && text.endsWith(" FROM stdin;")) inCopy = true;
    return Buffer.from(
      text.replaceAll(`${SEED_SCHEMA}.`, "public.").replaceAll(`Schema: ${SEED_SCHEMA};`, "Schema: public;"),
      "utf8",
    );
  };
  return new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      const data = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      const out: Buffer[] = [];
      let start = 0;
      for (let nl = data.indexOf(0x0a); nl !== -1; nl = data.indexOf(0x0a, start)) {
        out.push(line(data.subarray(start, nl)), Buffer.from("\n"));
        start = nl + 1;
      }
      rest = Buffer.from(data.subarray(start));
      done(null, out.length ? Buffer.concat(out) : undefined);
    },
    flush(done: TransformCallback) {
      done(null, rest.length ? line(rest) : undefined);
    },
  });
}

/** pg_dumps the scratch schema, as public, to a gzipped file. pg_dump 18, matching the Postgres
 *  installs restore into: PG_DUMP_BIN, else a desktop build's, else the Docker container's behind
 *  databaseUrl, else PATH's (pgDump.ts). */
export async function dumpSeedSchema(databaseUrl: string, outputPath: string, log = console.log): Promise<void> {
  const pgDumpCommand = resolvePgDump(databaseUrl);
  log(`pg_dump: ${pgDumpCommand.command} ${pgDumpCommand.prefixArgs.join(" ")} (${pgDumpCommand.source})`);
  const args = [
    ...pgDumpCommand.prefixArgs,
    pgDumpCommand.databaseUrl,
    "--data-only",
    // Installs restore with FK triggers off: regions references itself (parent region), so the
    // rows can't be replayed in FK-safe order.
    "--disable-triggers",
    "--schema",
    SEED_SCHEMA,
  ];
  // Streamed: the dump exceeds execFileSync's maxBuffer.
  const pgDump = spawn(pgDumpCommand.command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  pgDump.stderr.on("data", (chunk) => (stderr += chunk.toString()));
  // Registered before awaiting the pipeline: pg_dump's "close" can fire before the await resolves,
  // and a missed event leaves this Promise pending while node exits silently.
  const pgDumpExit: Promise<number> = new Promise((resolve, reject) => {
    pgDump.on("error", reject);
    pgDump.on("close", (code) => resolve(code ?? 0));
  });
  await pipeline(pgDump.stdout, seedSchemaToPublic(), createGzip(), createWriteStream(outputPath));
  const exitCode = await pgDumpExit;
  if (exitCode !== 0) throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
}
