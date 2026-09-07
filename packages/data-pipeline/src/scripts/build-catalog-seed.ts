// Builds the desktop app's "catalog seed" — the one-time database snapshot every fresh install
// restores on first launch (see apps/desktop/src-tauri/src/embedded_db.rs's
// restore_catalog_seed_if_needed), published as the `catalog-latest` GitHub Release asset.
//
// Only pure reference/catalog data belongs here, nothing per-user or per-install: species,
// species_reference_photos, species_traits, species_rarity, regions, region_species,
// sea_zones, sea_zone_species.
//
// NULLS OUT every local filesystem path column before dumping (reference_display_path/
// thumb_path on both species and species_reference_photos) — those are absolute paths on
// whatever machine ran enrichment, and baking them in verbatim leaves every real install with
// unreachable file paths. Portable metadata (name, description, credit, license, remote
// photo_url) stays; a fresh install ends up with those path columns NULL, same as a
// not-yet-enriched species — species/routes.ts's lazy-enrichment path already fills them in
// from a downloaded region pack or a live fetch.
//
// Also writes a companion `catalog-manifest.json` ({version, publishedAt}) so an installed app
// (species/catalogSeedUpdate.ts) can check for a newer catalog before downloading the much
// larger seed itself. `version` is an epoch-ms timestamp, not a content hash — pg_dump's output
// isn't byte-stable run to run even for identical data, so a hash would falsely read as always
// changed.
//
// Usage: DATABASE_URL=postgres://... npx tsx packages/data-pipeline/src/scripts/build-catalog-seed.ts <outputPath.sql.gz>
// After running, publish both files to the catalog-latest release:
//   gh release upload catalog-latest <outputPath> <dir>/catalog-manifest.json --clobber
import { execFileSync } from "node:child_process";
import { createGzip } from "node:zlib";
import { createWriteStream, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pool } from "../db.js";

const CATALOG_TABLES = [
  "species",
  "species_reference_photos",
  "species_traits",
  "species_rarity",
  "regions",
  "region_species",
  "sea_zones",
  "sea_zone_species",
];

const PATH_COLUMNS: Record<string, string[]> = {
  species: ["reference_display_path", "reference_thumb_path"],
  species_reference_photos: ["display_path", "thumb_path"],
};

async function main() {
  const outputPath = process.argv[2];
  if (!outputPath) {
    console.error("Usage: build-catalog-seed.ts <outputPath.sql.gz>");
    process.exit(1);
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("Set DATABASE_URL to the database to export from.");
    process.exit(1);
  }

  // pg_dump opens its own connection, so it can't see an uncommitted UPDATE sitting in some
  // other session's open transaction — a --snapshot-synchronized dump turned out not to see it
  // either in practice. Instead: save every row's real path values, COMMIT the columns to NULL
  // so pg_dump's own fresh connection genuinely reads NULL, dump, then restore the real values
  // by primary key. This machine's dev DB has no concurrent writers during a manual export run,
  // so the brief real window where these columns are NULL is safe — and restoring afterward
  // means this script never leaves the source database actually changed.
  const backups: { table: string; idColumn: string; rows: Record<string, unknown>[] }[] = [];
  try {
    for (const [table, columns] of Object.entries(PATH_COLUMNS)) {
      const idColumn = "id";
      const res = await pool.query(`SELECT ${idColumn}, ${columns.join(", ")} FROM ${table}`);
      backups.push({ table, idColumn, rows: res.rows });
      const sets = columns.map((c) => `${c} = NULL`).join(", ");
      await pool.query(`UPDATE ${table} SET ${sets}`);
    }

    console.log(`[build-catalog-seed] dumping ${CATALOG_TABLES.length} tables with local paths stripped...`);
    // --disable-triggers: regions has a circular self-reference (parent region), so a plain
    // --data-only dump can't replay its rows in FK-safe order — matches the already-published
    // seed, which uses the same flag for the same reason.
    const args = [
      databaseUrl,
      "--data-only",
      "--disable-triggers",
      ...CATALOG_TABLES.flatMap((t) => ["--table", t]),
    ];

    // No system-wide pg_dump on a machine that only has the embedded Postgres theseus manages
    // (see embedded_db.rs) — point PG_DUMP_BIN at its bundled binary in that case, e.g.
    // ~/.theseus/postgresql/<version>/bin/pg_dump, matching the target restore's own version.
    const pgDumpBin = process.env.PG_DUMP_BIN ?? "pg_dump";
    const dumpBuffer = execFileSync(pgDumpBin, args, { maxBuffer: 1024 * 1024 * 1024 });

    await pipeline(Readable.from(dumpBuffer), createGzip(), createWriteStream(outputPath));
    console.log(`[build-catalog-seed] wrote ${outputPath}`);

    const version = Date.now();
    const manifestPath = path.join(path.dirname(outputPath), "catalog-manifest.json");
    writeFileSync(manifestPath, JSON.stringify({ version, publishedAt: new Date(version).toISOString() }, null, 2));
    console.log(`[build-catalog-seed] wrote ${manifestPath} (version ${version})`);
  } finally {
    for (const { table, idColumn, rows } of backups) {
      const columns = PATH_COLUMNS[table];
      for (const row of rows) {
        const sets = columns.map((c, i) => `${c} = $${i + 2}`).join(", ");
        await pool.query(`UPDATE ${table} SET ${sets} WHERE ${idColumn} = $1`, [
          row[idColumn],
          ...columns.map((c) => row[c]),
        ]);
      }
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
