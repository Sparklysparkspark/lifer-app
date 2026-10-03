// Builds the desktop app's "catalog seed", the database snapshot every fresh install restores on
// first launch (see apps/desktop/src-tauri/src/embedded_db.rs's restore_catalog_seed_if_needed),
// published as the `catalog-latest` GitHub Release asset. Only reference/catalog data, nothing
// per-user or per-install.
//
// Local filesystem path columns are nulled before dumping, since they point at the build
// machine; installs fill them in from region packs or a live fetch.
//
// Embedding tables are not in the pg_dump (as float text they blow past NSIS's installer limit).
// They're written as compact float16 binaries (format in
// packages/shared/src/galleryEmbeddingsFormat.ts) that installs fetch after downloading the CLIP model.
//
// Also writes `catalog-manifest.json` so an install (species/catalogSeedUpdate.ts) can check
// for a newer catalog first. `version` is an epoch-ms timestamp, since pg_dump output isn't
// byte-stable across runs.
//
// Usage: DATABASE_URL=postgres://... npx tsx packages/data-pipeline/src/scripts/build-catalog-seed.ts <outputPath.sql.gz>
// After running, publish the seed, every vector asset, then the manifest last, to the
// catalog-latest release (or run the catalog-seed.yml workflow, which does this for you):
//   gh release upload catalog-latest <outputPath> <dir>/*.bin.gz --clobber
//   gh release upload catalog-latest <dir>/catalog-manifest.json --clobber
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  encodeGalleryEmbeddingRecord,
  encodeGalleryEmbeddingsHeader,
} from "@lifer/shared/src/galleryEmbeddingsFormat.js";
import { encodeSpeciesVectorHeader, encodeSpeciesVectorRecord } from "@lifer/shared/src/speciesVectorFormat.js";
import { ID_MODEL_VERSION } from "@lifer/shared/src/idModel.js";
import { pool } from "../db.js";
import { EMBEDDING_MODEL_VERSION } from "../embeddings.js";

// Installers bundle the seed, and NSIS can't exceed 2GB. Catch a regression here, not in CI.
const MAX_SEED_BYTES = 200 * 1024 * 1024;
const GALLERY_EMBEDDING_DIMENSION = 768;
const GALLERY_PAGE_SIZE = 2000;

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

// Picks the model version most rows were computed with; rows from any other version are useless
// to installs running the current model, so they're skipped with a warning.
async function pickGalleryModelVersion(): Promise<string | null> {
  const res = await pool.query<{ model_version: string; n: string }>(
    `SELECT model_version, count(*) AS n FROM species_reference_gallery_embeddings GROUP BY 1 ORDER BY 2 DESC`,
  );
  if (res.rows.length === 0) return null;
  for (const r of res.rows.slice(1)) {
    console.warn(`[build-catalog-seed] skipping ${r.n} gallery embeddings from older model ${r.model_version}`);
  }
  return process.env.GALLERY_MODEL_VERSION ?? res.rows[0].model_version;
}

async function writeGalleryEmbeddings(
  outputDir: string,
  table = "species_reference_gallery_embeddings",
  assetName = "lifer-gallery-embeddings",
  fixedModelVersion?: string,
): Promise<null | { fileName: string; modelVersion: string; rowCount: number }> {
  const picked = fixedModelVersion ? await pickModelVersion(table, fixedModelVersion) : await pickGalleryModelVersion();
  if (!picked) {
    console.warn(`[build-catalog-seed] no ${table} rows in this database, skipping that asset`);
    return null;
  }
  const modelVersion: string = picked;
  const where = `ge.model_version = $1 AND NOT s.is_other_taxa`;
  const from = `${table} ge
    JOIN species_reference_photos p ON p.id = ge.reference_photo_id
    JOIN species s ON s.id = ge.species_id`;
  const countRes = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${from} WHERE ${where}`, [modelVersion]);
  const rowCount = Number(countRes.rows[0].n);

  // Keyset-paged so the whole table is never in memory.
  async function* records(): AsyncGenerator<Buffer> {
    yield encodeGalleryEmbeddingsHeader({ dimension: GALLERY_EMBEDDING_DIMENSION, rowCount, modelVersion });
    let after: string = "00000000-0000-0000-0000-000000000000";
    let written = 0;
    while (true) {
      const page = await pool.query<{ reference_photo_id: string; species_id: string; photo_url: string; embedding: number[] }>(
        `SELECT ge.reference_photo_id, ge.species_id, p.photo_url, ge.embedding FROM ${from}
         WHERE ${where} AND ge.reference_photo_id > $2 ORDER BY ge.reference_photo_id LIMIT ${GALLERY_PAGE_SIZE}`,
        [modelVersion, after],
      );
      if (page.rows.length === 0) break;
      for (const r of page.rows) {
        yield encodeGalleryEmbeddingRecord(
          { speciesId: r.species_id, photoUrl: r.photo_url, embedding: r.embedding },
          GALLERY_EMBEDDING_DIMENSION,
        );
      }
      written += page.rows.length;
      after = page.rows[page.rows.length - 1].reference_photo_id;
    }
    if (written !== rowCount) throw new Error(`Gallery embeddings changed during export (${written} vs ${rowCount})`);
  }

  const fileName = `${assetName}-${modelVersion}.bin.gz`;
  await pipeline(Readable.from(records()), createGzip(), createWriteStream(path.join(outputDir, fileName)));
  console.log(`[build-catalog-seed] wrote ${fileName} (${rowCount} rows)`);
  return { fileName, modelVersion, rowCount };
}

// species_reference_embeddings and species_text_embeddings (one 768-float row per species) are
// also too large as pg_dump text and only usable with the CLIP model, so they ship the same way.
async function pickModelVersion(table: string, currentVersion: string): Promise<string | null> {
  const res = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE model_version = $1`, [currentVersion]);
  const n = Number(res.rows[0].n);
  if (n === 0) {
    console.warn(`[build-catalog-seed] no ${table} rows for current model ${currentVersion}, skipping that asset`);
    return null;
  }
  return currentVersion;
}

async function writeSpeciesVectorAsset(
  outputDir: string,
  table: string,
  assetName: string,
  currentModelVersion: string,
  dimension: number,
): Promise<null | { fileName: string; modelVersion: string; rowCount: number }> {
  const picked = await pickModelVersion(table, currentModelVersion);
  if (!picked) return null;
  const modelVersion: string = picked;

  const countRes = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM ${table} e JOIN species s ON s.id = e.species_id WHERE e.model_version = $1 AND NOT s.is_other_taxa`,
    [modelVersion],
  );
  const rowCount = Number(countRes.rows[0].n);

  async function* records(): AsyncGenerator<Buffer> {
    yield encodeSpeciesVectorHeader({ dimension, rowCount, modelVersion });
    let after: string = "00000000-0000-0000-0000-000000000000";
    let written = 0;
    while (true) {
      const page = await pool.query<{ species_id: string; embedding: number[] }>(
        `SELECT e.species_id, e.embedding FROM ${table} e JOIN species s ON s.id = e.species_id
         WHERE e.model_version = $1 AND NOT s.is_other_taxa AND e.species_id > $2
         ORDER BY e.species_id LIMIT ${GALLERY_PAGE_SIZE}`,
        [modelVersion, after],
      );
      if (page.rows.length === 0) break;
      for (const r of page.rows) yield encodeSpeciesVectorRecord({ speciesId: r.species_id, embedding: r.embedding }, dimension);
      written += page.rows.length;
      after = page.rows[page.rows.length - 1].species_id;
    }
    if (written !== rowCount) throw new Error(`${table} changed during export (${written} vs ${rowCount})`);
  }

  const fileName = `${assetName}-${modelVersion}.bin.gz`;
  await pipeline(Readable.from(records()), createGzip(), createWriteStream(path.join(outputDir, fileName)));
  console.log(`[build-catalog-seed] wrote ${fileName} (${rowCount} rows)`);
  return { fileName, modelVersion, rowCount };
}

const CATALOG_TABLES = [
  "species",
  "species_reference_photos",
  // species_reference_embeddings and species_text_embeddings ship as binary assets instead
  // (writeSpeciesVectorAsset below).
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
  // Non-photo reference images to delete from installs (migration 106). Keyed by URL, not
  // species, so it isn't in OTHER_TAXA_TABLES.
  "reference_photo_blocklist",
];

const PATH_COLUMNS: Record<string, string[]> = {
  species: ["reference_display_path", "reference_thumb_path"],
  species_reference_photos: ["display_path", "thumb_path"],
};

// Other Taxa species (species.is_other_taxa) are personal, per-install additions stored in the
// shared catalog tables. pg_dump --table has no row filter, so without this they'd ship in the
// next seed to every install.
//
// Listed children before parent (safe DELETE order); main() reinserts in reverse. Each entry
// is a CATALOG_TABLES table carrying a species_id (or, for `species`, `id`).
const OTHER_TAXA_TABLES: Array<{ table: string; speciesIdColumn: string }> = [
  { table: "species_merges", speciesIdColumn: "new_species_id" },
  { table: "species_splits", speciesIdColumn: "parent_species_id" },
  { table: "id_model_gallery_embeddings", speciesIdColumn: "species_id" },
  { table: "id_model_reference_embeddings", speciesIdColumn: "species_id" },
  { table: "id_model_text_embeddings", speciesIdColumn: "species_id" },
  { table: "species_reference_gallery_embeddings", speciesIdColumn: "species_id" },
  { table: "species_reference_embeddings", speciesIdColumn: "species_id" },
  { table: "species_text_embeddings", speciesIdColumn: "species_id" },
  { table: "species_reference_photos", speciesIdColumn: "species_id" },
  { table: "species_traits", speciesIdColumn: "species_id" },
  { table: "species_rarity", speciesIdColumn: "species_id" },
  { table: "region_species", speciesIdColumn: "species_id" },
  { table: "sea_zone_species", speciesIdColumn: "species_id" },
  { table: "species", speciesIdColumn: "id" },
];

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

  // pg_dump uses its own connection and can't see an uncommitted UPDATE, so the path values are
  // backed up, committed as NULL, dumped, then restored by primary key. Assumes no concurrent
  // writers during a manual export.
  const backups: { table: string; idColumn: string; rows: Record<string, unknown>[] }[] = [];
  // Other Taxa rows are removed the same way: backed up, deleted children first, dumped, then
  // reinserted parents first, leaving the source database unchanged.
  const otherTaxaBackups: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
  let tierExplainStripped = false;
  const otherTaxaBackupPath = path.join(path.dirname(outputPath), `other-taxa-backup-${Date.now()}.json`);
  try {
    for (const { table, speciesIdColumn } of OTHER_TAXA_TABLES) {
      const whereOtherTaxa = `EXISTS (SELECT 1 FROM species s WHERE s.id = t.${speciesIdColumn} AND s.is_other_taxa)`;
      const res = await pool.query(`SELECT t.* FROM ${table} t WHERE ${whereOtherTaxa}`);
      otherTaxaBackups.push({ table, rows: res.rows });
    }
    // Written to disk BEFORE anything is deleted: the deletes commit immediately (pg_dump has to
    // see them), so if the restore below ever fails this file is the only copy of those rows.
    if (otherTaxaBackups.some((b) => b.rows.length > 0)) {
      writeFileSync(otherTaxaBackupPath, JSON.stringify(otherTaxaBackups));
      console.log(`[build-catalog-seed] backed up Other Taxa rows to ${otherTaxaBackupPath}`);
    }
    for (const { table, speciesIdColumn } of OTHER_TAXA_TABLES) {
      const whereOtherTaxa = `EXISTS (SELECT 1 FROM species s WHERE s.id = t.${speciesIdColumn} AND s.is_other_taxa)`;
      await pool.query(`DELETE FROM ${table} t WHERE ${whereOtherTaxa}`);
    }
    const otherTaxaSpeciesCount = otherTaxaBackups.find((b) => b.table === "species")?.rows.length ?? 0;
    if (otherTaxaSpeciesCount > 0) {
      console.log(`[build-catalog-seed] excluding ${otherTaxaSpeciesCount} Other Taxa species (and their dependent rows) from the dump`);
    }

    // Per-listing tier explanations are ~50 MB and only shown for downloaded regions, whose packs
    // carry them. Parked in a real table so a crash mid-dump can't lose them.
    // A run that crashed mid-dump left its backup behind: restore it before taking a new one.
    if ((await pool.query<{ t: string | null }>(`SELECT to_regclass('seed_tier_explain_backup') AS t`)).rows[0].t) {
      await pool.query(
        `UPDATE region_species rs SET tier_explain = b.tier_explain FROM seed_tier_explain_backup b
         WHERE b.region_id = rs.region_id AND b.species_id = rs.species_id`,
      );
      await pool.query(`DROP TABLE seed_tier_explain_backup`);
    }
    await pool.query(
      `CREATE TABLE seed_tier_explain_backup AS SELECT region_id, species_id, tier_explain FROM region_species WHERE tier_explain IS NOT NULL`,
    );
    await pool.query(`UPDATE region_species SET tier_explain = NULL WHERE tier_explain IS NOT NULL`);
    tierExplainStripped = true;

    for (const [table, columns] of Object.entries(PATH_COLUMNS)) {
      const idColumn = "id";
      const res = await pool.query(`SELECT ${idColumn}, ${columns.join(", ")} FROM ${table}`);
      backups.push({ table, idColumn, rows: res.rows });
      const sets = columns.map((c) => `${c} = NULL`).join(", ");
      await pool.query(`UPDATE ${table} SET ${sets}`);
    }

    console.log(`[build-catalog-seed] dumping ${CATALOG_TABLES.length} tables with local paths stripped...`);
    // --disable-triggers: regions references itself (parent region), so a --data-only dump can't
    // replay rows in FK-safe order.
    const args = [
      databaseUrl,
      "--data-only",
      "--disable-triggers",
      ...CATALOG_TABLES.flatMap((t) => ["--table", t]),
    ];

    // With only the embedded Postgres available (see embedded_db.rs), point PG_DUMP_BIN at its
    // bundled binary, e.g. ~/.theseus/postgresql/<version>/bin/pg_dump, matching the restore's version.
    const pgDumpBin = process.env.PG_DUMP_BIN ?? "pg_dump";
    // Streamed into gzip+file: the dump exceeds execFileSync's maxBuffer.
    const pgDump = spawn(pgDumpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    pgDump.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    // Registered before awaiting the pipeline: pg_dump's "close" can fire before the await resolves,
    // and a missed event leaves this Promise pending while node exits silently.
    const pgDumpExit: Promise<number> = new Promise((resolve, reject) => {
      pgDump.on("error", reject);
      pgDump.on("close", (code) => resolve(code ?? 0));
    });
    await pipeline(pgDump.stdout, createGzip(), createWriteStream(outputPath));
    const exitCode = await pgDumpExit;
    if (exitCode !== 0) throw new Error(`pg_dump exited with code ${exitCode}: ${stderr}`);
    const seedBytes = statSync(outputPath).size;
    console.log(`[build-catalog-seed] wrote ${outputPath} (${(seedBytes / 1024 / 1024).toFixed(1)} MB)`);
    if (seedBytes > MAX_SEED_BYTES) {
      throw new Error(`Seed is ${(seedBytes / 1024 / 1024).toFixed(0)} MB, over the ${MAX_SEED_BYTES / 1024 / 1024} MB limit. Did a large table get added to CATALOG_TABLES?`);
    }

    const outputDir = path.dirname(outputPath);
    const gallery = await writeGalleryEmbeddings(outputDir);
    // The text version must match textEmbedding.ts TEXT_MODEL_VERSION. Both overridable via env
    // for a mid-bump database.
    const imageModelVersion = process.env.EMBEDDING_MODEL_VERSION ?? EMBEDDING_MODEL_VERSION;
    const textModelVersion = process.env.TEXT_MODEL_VERSION ?? "clip-vit-l14-text-v1";
    const speciesImage = await writeSpeciesVectorAsset(
      outputDir, "species_reference_embeddings", "lifer-species-image-embeddings", imageModelVersion, GALLERY_EMBEDDING_DIMENSION,
    );
    const speciesText = await writeSpeciesVectorAsset(
      outputDir, "species_text_embeddings", "lifer-species-text-embeddings", textModelVersion, GALLERY_EMBEDDING_DIMENSION,
    );
    // The species identification model's vectors (id_model_* tables, filled by
    // packages/data-pipeline/python/compute_id_model_vectors.py). Same formats.
    const idGallery = await writeGalleryEmbeddings(outputDir, "id_model_gallery_embeddings", "lifer-id-gallery-embeddings", ID_MODEL_VERSION);
    const idSpeciesImage = await writeSpeciesVectorAsset(
      outputDir, "id_model_reference_embeddings", "lifer-id-species-image-embeddings", ID_MODEL_VERSION, GALLERY_EMBEDDING_DIMENSION,
    );
    const idSpeciesText = await writeSpeciesVectorAsset(
      outputDir, "id_model_text_embeddings", "lifer-id-species-text-embeddings", ID_MODEL_VERSION, GALLERY_EMBEDDING_DIMENSION,
    );

    async function describeAsset(a: { fileName: string; modelVersion: string; rowCount: number } | null) {
      if (!a) return null;
      return {
        url: a.fileName,
        sha256: await sha256File(path.join(outputDir, a.fileName)),
        bytes: statSync(path.join(outputDir, a.fileName)).size,
        modelVersion: a.modelVersion,
        rowCount: a.rowCount,
      };
    }

    // URLs are file names, resolved relative to the manifest's own URL by the app, so the same
    // manifest works from GitHub or a local test server.
    const version = Date.now();
    const manifest = {
      version,
      publishedAt: new Date(version).toISOString(),
      seed: { url: path.basename(outputPath), sha256: await sha256File(outputPath), bytes: seedBytes },
      galleryEmbeddings: await describeAsset(gallery),
      speciesImageEmbeddings: await describeAsset(speciesImage),
      speciesTextEmbeddings: await describeAsset(speciesText),
      idGalleryEmbeddings: await describeAsset(idGallery),
      idSpeciesImageEmbeddings: await describeAsset(idSpeciesImage),
      idSpeciesTextEmbeddings: await describeAsset(idSpeciesText),
    };
    const manifestPath = path.join(outputDir, "catalog-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    console.log(`[build-catalog-seed] wrote ${manifestPath} (version ${version})`);
  } finally {
    if (tierExplainStripped) {
      await pool.query(
        `UPDATE region_species rs SET tier_explain = b.tier_explain FROM seed_tier_explain_backup b
         WHERE b.region_id = rs.region_id AND b.species_id = rs.species_id`,
      );
      await pool.query(`DROP TABLE seed_tier_explain_backup`);
    }
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
    // Reverse of the delete order: species goes back first, then everything referencing it.
    // Generated columns (species.genus) are skipped, since they can't be inserted into.
    let restoreFailed = false;
    for (const { table, rows } of [...otherTaxaBackups].reverse()) {
      if (rows.length === 0) continue;
      try {
        const generated = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = $1 AND is_generated = 'ALWAYS'`,
          [table],
        );
        const skip = new Set(generated.rows.map((r) => r.column_name));
        for (const row of rows) {
          const columns = Object.keys(row).filter((c) => !skip.has(c));
          if (columns.length === 0) continue;
          const placeholders = columns.map((_, i) => `$${i + 1}`);
          await pool.query(`INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`, columns.map((c) => row[c]));
        }
      } catch (err) {
        restoreFailed = true;
        console.error(`[build-catalog-seed] FAILED to restore Other Taxa rows into ${table}. They are saved in ${otherTaxaBackupPath}.`, err);
      }
    }
    if (restoreFailed) {
      process.exitCode = 1;
    } else if (existsSync(otherTaxaBackupPath)) {
      rmSync(otherTaxaBackupPath);
    }
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
