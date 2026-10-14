// Builds the desktop app's "catalog seed", the database snapshot every fresh install restores on
// first launch (see apps/desktop/src-tauri/src/embedded_db.rs's restore_catalog_seed_if_needed),
// published as the `catalog-latest` GitHub Release asset. Only reference/catalog data, nothing
// per-user or per-install.
//
// pg_dump reads copies of the catalog tables in a scratch schema, without local file paths or
// Other Taxa rows (pipeline/catalogSeedExport.ts), so the source database is never modified.
//
// Embedding tables are not in the pg_dump (as float text they blow past NSIS's installer limit).
// They're written as compact float16 binaries (format in
// packages/core/src/species/galleryEmbeddingsFormat.ts) that installs fetch after downloading the CLIP model.
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
import { createHash } from "node:crypto";
import { createGzip } from "node:zlib";
import { createReadStream, createWriteStream, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  encodeGalleryEmbeddingRecord,
  encodeGalleryEmbeddingsHeader,
} from "@lifer/core/species/galleryEmbeddingsFormat.js";
import { encodeSpeciesVectorHeader, encodeSpeciesVectorRecord } from "@lifer/core/species/speciesVectorFormat.js";
import { ID_MODEL_VERSION } from "@lifer/shared/src/idModel.js";
import { pool } from "../db.js";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { assertPhotosPublishable } from "../pipeline/photoLicensePolicy.js";
import {
  CATALOG_TABLES,
  createSeedExportSchema,
  dropSeedExportSchema,
  dumpSeedSchema,
} from "../pipeline/catalogSeedExport.js";

// Installers bundle the seed, and NSIS can't exceed 2GB (the installer is about 350 MB). Catch a
// regression here, not in CI.
const MAX_SEED_BYTES = 400 * 1024 * 1024;
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
      const page = await pool.query<{
        reference_photo_id: string;
        species_id: string;
        photo_url: string;
        embedding: number[];
      }>(
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
  const res = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table} WHERE model_version = $1`, [
    currentVersion,
  ]);
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
      for (const r of page.rows)
        yield encodeSpeciesVectorRecord({ speciesId: r.species_id, embedding: r.embedding }, dimension);
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
  await assertPhotosPublishable(pool);

  try {
    await createSeedExportSchema(pool);
    const otherTaxa = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM species WHERE is_other_taxa`);
    if (Number(otherTaxa.rows[0].n) > 0)
      console.log(`[build-catalog-seed] leaving out ${otherTaxa.rows[0].n} Other Taxa species and their rows`);
    console.log(`[build-catalog-seed] dumping ${CATALOG_TABLES.length} tables with local paths stripped...`);
    await dumpSeedSchema(databaseUrl, outputPath, (m) => console.log(`[build-catalog-seed] ${m}`));
    const seedBytes = statSync(outputPath).size;
    console.log(`[build-catalog-seed] wrote ${outputPath} (${(seedBytes / 1024 / 1024).toFixed(1)} MB)`);
    if (seedBytes > MAX_SEED_BYTES) {
      throw new Error(
        `Seed is ${(seedBytes / 1024 / 1024).toFixed(0)} MB, over the ${MAX_SEED_BYTES / 1024 / 1024} MB limit. Did a large table get added to CATALOG_TABLES?`,
      );
    }

    const outputDir = path.dirname(outputPath);
    const gallery = await writeGalleryEmbeddings(outputDir);
    // The text version must match textEmbedding.ts TEXT_MODEL_VERSION. Both overridable via env
    // for a mid-bump database.
    const imageModelVersion = process.env.EMBEDDING_MODEL_VERSION ?? EMBEDDING_MODEL_VERSION;
    const textModelVersion = process.env.TEXT_MODEL_VERSION ?? "clip-vit-l14-text-v2";
    const speciesImage = await writeSpeciesVectorAsset(
      outputDir,
      "species_reference_embeddings",
      "lifer-species-image-embeddings",
      imageModelVersion,
      GALLERY_EMBEDDING_DIMENSION,
    );
    const speciesText = await writeSpeciesVectorAsset(
      outputDir,
      "species_text_embeddings",
      "lifer-species-text-embeddings",
      textModelVersion,
      GALLERY_EMBEDDING_DIMENSION,
    );
    // The species identification model's vectors (id_model_* tables, filled by
    // packages/data-pipeline/python/compute_id_model_vectors.py). Same formats.
    const idGallery = await writeGalleryEmbeddings(
      outputDir,
      "id_model_gallery_embeddings",
      "lifer-id-gallery-embeddings",
      ID_MODEL_VERSION,
    );
    const idSpeciesImage = await writeSpeciesVectorAsset(
      outputDir,
      "id_model_reference_embeddings",
      "lifer-id-species-image-embeddings",
      ID_MODEL_VERSION,
      GALLERY_EMBEDDING_DIMENSION,
    );
    const idSpeciesText = await writeSpeciesVectorAsset(
      outputDir,
      "id_model_text_embeddings",
      "lifer-id-species-text-embeddings",
      ID_MODEL_VERSION,
      GALLERY_EMBEDDING_DIMENSION,
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
    await dropSeedExportSchema(pool);
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
