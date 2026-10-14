// Computes an embedding for every enriched species' reference photo into
// species_reference_embeddings, the "not yet photographed" side of species auto-suggest (see
// packages/core/src/species/embeddings.ts's suggestSpecies). Shipped to users in the catalog seed.
//
// Also embeds every gallery photo into species_reference_gallery_embeddings (migration 101), so
// matching takes the best score across several poses, not just the one main photo.
//
// Only embeds rows that are missing or have a stale model_version, so it's safe to rerun.
//
//   --region=<name>   scopes both passes to one region's checklist (same country-name convention
//                     as build-region-pack.ts). Inserts are per-row upserts, so a scoped and an
//                     unscoped pass can run concurrently.
//   --grayscale-only  recomputes the current vectors of photos whose file is grayscale, instead of
//                     filling in missing ones.
//   --dry-run         counts what would be computed, computes nothing.
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";
import { computeEmbedding } from "@lifer/core/species/embeddings.js";
import { pool } from "../db.js";
import { closeClip, isGrayscaleImage, prepareClip } from "../lib/clipEmbedding.js";

interface Job {
  kind: "reference" | "gallery";
  id: string;
  speciesId: string;
  scientificName: string;
  path: string;
}

async function findJobs(regionId: string | null, grayscaleOnly: boolean): Promise<Job[]> {
  const params: string[] = [EMBEDDING_MODEL_VERSION];
  let regionFilter = "";
  let galleryRegionFilter = "";
  if (regionId) {
    params.push(regionId);
    regionFilter = `AND s.id IN (SELECT species_id FROM region_species WHERE region_id = $2)`;
    galleryRegionFilter = `AND p.species_id IN (SELECT species_id FROM region_species WHERE region_id = $2)`;
  }
  // Missing vectors normally; with --grayscale-only, the ones already there.
  const has = grayscaleOnly ? "IS NOT NULL" : "IS NULL";
  const refs = await pool.query<{ id: string; scientific_name: string; path: string }>(
    `SELECT s.id, s.scientific_name, s.reference_display_path AS path
     FROM species s
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $1
     WHERE s.reference_display_path IS NOT NULL AND sre.species_id ${has} ${regionFilter}
     ORDER BY s.scientific_name`,
    params,
  );
  const gallery = await pool.query<{ id: string; species_id: string; scientific_name: string; path: string }>(
    `SELECT p.id, p.species_id, s.scientific_name, p.display_path AS path
     FROM species_reference_photos p
     JOIN species s ON s.id = p.species_id
     LEFT JOIN species_reference_gallery_embeddings ge ON ge.reference_photo_id = p.id AND ge.model_version = $1
     WHERE p.display_path IS NOT NULL AND ge.reference_photo_id ${has} ${galleryRegionFilter}
     ORDER BY s.scientific_name`,
    params,
  );
  const jobs: Job[] = [
    ...refs.rows.map((r) => ({
      kind: "reference" as const,
      id: r.id,
      speciesId: r.id,
      scientificName: r.scientific_name,
      path: r.path,
    })),
    ...gallery.rows.map((r) => ({
      kind: "gallery" as const,
      id: r.id,
      speciesId: r.species_id,
      scientificName: r.scientific_name,
      path: r.path,
    })),
  ];
  if (!grayscaleOnly) return jobs;
  const gray: Job[] = [];
  for (const job of jobs) {
    if (!existsSync(job.path)) continue;
    try {
      if (await isGrayscaleImage(job.path)) gray.push(job);
    } catch (err) {
      console.error(`[backfill-reference-embeddings] couldn't read ${job.path}: ${(err as Error).message}`);
    }
  }
  return gray;
}

async function store(job: Job, embedding: number[]): Promise<void> {
  if (job.kind === "reference") {
    await pool.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version)
       VALUES ($1, $2, $3)
       ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [job.id, embedding, EMBEDDING_MODEL_VERSION],
    );
  } else {
    await pool.query(
      `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (reference_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
      [job.id, job.speciesId, embedding, EMBEDDING_MODEL_VERSION],
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      region: { type: "string" },
      "grayscale-only": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const grayscaleOnly = values["grayscale-only"]!;

  let regionId: string | null = null;
  if (values.region) {
    const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [values.region]);
    if (!regionRes.rows[0]) throw new Error(`No region named "${values.region}"`);
    regionId = regionRes.rows[0].id;
    console.log(`[backfill-reference-embeddings] scoped to region "${values.region}"`);
  }

  const jobs = await findJobs(regionId, grayscaleOnly);
  const refs = jobs.filter((j) => j.kind === "reference").length;
  console.log(
    `[backfill-reference-embeddings] ${jobs.length} photos ${grayscaleOnly ? "are grayscale" : "need an embedding"}` +
      ` (${refs} reference, ${jobs.length - refs} gallery; model ${EMBEDDING_MODEL_VERSION})`,
  );
  if (values["dry-run"] || jobs.length === 0) return;

  await prepareClip();
  let done = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      await store(job, await computeEmbedding(await readFile(job.path)));
      done++;
    } catch (err) {
      failed++;
      console.error(
        `[backfill-reference-embeddings] FAILED ${job.kind} photo of ${job.scientificName}:`,
        (err as Error).message,
      );
    }
    if ((done + failed) % 200 === 0) console.log(`[backfill-reference-embeddings] ${done + failed}/${jobs.length}`);
  }
  console.log(`[backfill-reference-embeddings] done: ${done} embedded, ${failed} failed`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeClip();
    await pool.end();
  });
