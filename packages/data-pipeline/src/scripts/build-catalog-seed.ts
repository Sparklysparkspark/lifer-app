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
// species_reference_gallery_embeddings is NOT in the pg_dump: as tab-separated float text it
// made the seed 1.2GB, over NSIS's installer limit. It's written separately as a compact float16
// binary (lifer-gallery-embeddings-<modelVersion>.bin.gz, format in
// packages/shared/src/galleryEmbeddingsFormat.ts) that installs fetch after downloading the CLIP
// model, which is the only time the vectors are usable.
//
// Also writes a companion `catalog-manifest.json` so an installed app
// (species/catalogSeedUpdate.ts) can check for a newer catalog before downloading the much
// larger seed itself. `version` is an epoch-ms timestamp, not a content hash — pg_dump's output
// isn't byte-stable run to run even for identical data, so a hash would falsely read as always
// changed.
//
// Usage: DATABASE_URL=postgres://... npx tsx packages/data-pipeline/src/scripts/build-catalog-seed.ts <outputPath.sql.gz>
// After running, publish all three files to the catalog-latest release (or run the
// catalog-seed.yml workflow, which does this for you):
//   gh release upload catalog-latest <outputPath> <dir>/lifer-gallery-embeddings-*.bin.gz <dir>/catalog-manifest.json --clobber
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
import { pool } from "../db.js";

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

async function writeGalleryEmbeddings(outputDir: string): Promise<null | { fileName: string; modelVersion: string; rowCount: number }> {
  const picked = await pickGalleryModelVersion();
  if (!picked) {
    console.warn("[build-catalog-seed] no gallery embeddings in this database, skipping that asset");
    return null;
  }
  const modelVersion: string = picked;
  const where = `ge.model_version = $1 AND NOT s.is_other_taxa`;
  const from = `species_reference_gallery_embeddings ge
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

  const fileName = `lifer-gallery-embeddings-${modelVersion}.bin.gz`;
  await pipeline(Readable.from(records()), createGzip(), createWriteStream(path.join(outputDir, fileName)));
  console.log(`[build-catalog-seed] wrote ${fileName} (${rowCount} rows)`);
  return { fileName, modelVersion, rowCount };
}

// Same story as the gallery vectors above, for the two other embedding tables that turned out to
// be just as large: species_reference_embeddings (per-species image vector) and
// species_text_embeddings (per-species zero-shot text vector) are one 768-float row per species
// (132k+ species), which as pg_dump text alone made the seed 800MB even with gallery embeddings
// already removed. Both are only usable once the CLIP model (image + text halves) is downloaded,
// same as gallery vectors, so they move out the same way.
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
  // species_reference_embeddings and species_text_embeddings used to be dumped here (one row
  // per species, 132k+ rows each) but that alone made the seed 800MB; they're written as their
  // own compact binary assets by writeSpeciesVectorAsset below, same reasoning as gallery
  // embeddings.
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

// Other Taxa species (Settings > Species & Import's any-taxa search, species.is_other_taxa) are
// deliberately personal: one install's own "I found this specific insect, it's not in the base
// checklist" addition, written into the same shared species/region_species tables every OTHER
// catalog table lives in — see species/routes.ts's own POST /species/other-taxa. pg_dump --table
// dumps a table's ENTIRE contents with no row-level filter available, so without this, any Other
// Taxa species added on whatever machine last ran this script rides along in the NEXT published
// catalog seed and ends up in every fresh install's database — confirmed live: a bumble bee added
// once, on a test/dev machine, while checking the Other Taxa feature, showed up in a completely
// unrelated, freshly-wiped Docker install's Canada checklist after that install picked up the
// seed. Offline PACKS were never the vector (build-region-pack.ts filters by taxon_class, and an
// Other Taxa species' taxon_class is never one of the 18 built-in classes a pack is built for) —
// only the catalog seed's unfiltered whole-table dump was.
//
// Listed children-before-parent (safe DELETE order); reinsertion in main() below walks this
// list in reverse (safe INSERT order, parent before children). Every entry here is a table this
// script's own CATALOG_TABLES list already dumps and that carries a species_id (or, for
// `species` itself, `id`) referencing species.is_other_taxa.
const OTHER_TAXA_TABLES: Array<{ table: string; speciesIdColumn: string }> = [
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

  // pg_dump opens its own connection, so it can't see an uncommitted UPDATE sitting in some
  // other session's open transaction — a --snapshot-synchronized dump turned out not to see it
  // either in practice. Instead: save every row's real path values, COMMIT the columns to NULL
  // so pg_dump's own fresh connection genuinely reads NULL, dump, then restore the real values
  // by primary key. This machine's dev DB has no concurrent writers during a manual export run,
  // so the brief real window where these columns are NULL is safe — and restoring afterward
  // means this script never leaves the source database actually changed.
  const backups: { table: string; idColumn: string; rows: Record<string, unknown>[] }[] = [];
  // Same "back up the rows, temporarily remove what shouldn't be in the dump, restore
  // afterward" shape as the path-column backup below — pg_dump --table has no row-level filter,
  // so the only way to keep Other Taxa species out of the dump without a hand-written COPY
  // parser is to make them briefly not exist in the source tables while pg_dump runs. Ordered
  // children-first so the delete pass never trips a foreign-key violation; restored in reverse
  // (parents first) so the reinsert pass doesn't either. This machine's dev DB has no concurrent
  // writers during a manual export run (same assumption the path-column step already makes), so
  // the brief real window where these rows are gone is safe, and the source database ends up
  // completely unchanged once this script finishes.
  const otherTaxaBackups: Array<{ table: string; rows: Record<string, unknown>[] }> = [];
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
    // Streamed straight into gzip+file rather than buffered via execFileSync — the dump grew
    // past execFileSync's 1GB maxBuffer once species_reference_gallery_embeddings (per-gallery-
    // photo embeddings) joined this seed, killing pg_dump with SIGPIPE the moment its stdout
    // pipe filled and nothing was reading it. Streaming has no such ceiling and never holds the
    // whole dump in memory at once.
    const pgDump = spawn(pgDumpBin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    pgDump.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    // Registered BEFORE awaiting the pipeline below, not after — pg_dump's "close" can fire as
    // soon as its stdout end triggers the pipeline's own completion, so attaching this listener
    // only once the pipeline await already resolved risked missing an event that already fired.
    // A missed "close" left this Promise unresolved forever; with nothing else keeping the
    // event loop alive, node exited quietly mid-await — the dump file was already complete and
    // valid, but the script never reached its own success log or wrote catalog-manifest.json.
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
    // Must match apps/api/src/config.ts EMBEDDING_MODEL_VERSION / textEmbedding.ts
    // TEXT_MODEL_VERSION. Overridable via env in case this ever runs against a database mid
    // model-version bump.
    const imageModelVersion = process.env.EMBEDDING_MODEL_VERSION ?? "clip-vit-l14-quantized-v1";
    const textModelVersion = process.env.TEXT_MODEL_VERSION ?? "clip-vit-l14-text-v1";
    const speciesImage = await writeSpeciesVectorAsset(
      outputDir, "species_reference_embeddings", "lifer-species-image-embeddings", imageModelVersion, GALLERY_EMBEDDING_DIMENSION,
    );
    const speciesText = await writeSpeciesVectorAsset(
      outputDir, "species_text_embeddings", "lifer-species-text-embeddings", textModelVersion, GALLERY_EMBEDDING_DIMENSION,
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
    };
    const manifestPath = path.join(outputDir, "catalog-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
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
    // Reverse of the delete order above — species (the parent every other table here
    // references) goes back in first, then everything that points at it.
    // Generated columns (species.genus) can't be inserted into; that used to make this restore
    // throw on the first row, permanently losing every Other Taxa row it had just deleted.
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
