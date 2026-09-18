// One-time (then incremental) pass: computes an embedding for every enriched species' own
// reference photo and stores it in species_reference_embeddings — the "species the user hasn't
// photographed yet" side of species auto-suggest (see embeddings.ts in this same package, and
// apps/api/src/species/embeddings.ts's suggestSpecies, which reads this table). Shipped to
// users as part of the existing catalog seed download (CATALOG_SEED_URL), not a new mechanism —
// this script just populates the source-of-truth table that seed gets built from.
//
// Also embeds every GALLERY photo, into species_reference_gallery_embeddings (migration 101) —
// matching against only the one main-photo embedding meant a real photo taken at a different
// angle/pose than that single reference image could legitimately score below the confidence
// cutoff even for an obvious match. An embedding is ~3KB regardless of source photo size, so
// storing one per gallery photo (several per species) costs almost nothing, and lets matching
// take the best score across all of them instead of just the one.
//
// Only re-embeds when there's no row yet, or its stored model_version is stale — safe to re-run
// any time (e.g. after enriching a new batch of species, or after bumping EMBEDDING_MODEL_VERSION).
//
// Optional --region=<name> scopes both passes to one region's own checklist (region_species),
// same country-name convention build-region-pack.ts uses. Lets a specific country's species get
// their gallery embeddings quickly (minutes, not the hours a full world run takes) without
// waiting on or interfering with a full unscoped run already in progress elsewhere: every insert
// here is a plain per-row upsert, so a scoped and an unscoped pass can run concurrently against
// the same database with no coordination needed.
import { pool } from "../db.js";
import { computeEmbedding, EMBEDDING_MODEL_VERSION } from "../embeddings.js";
import { readFile } from "node:fs/promises";

async function main() {
  const regionArg = process.argv.find((a) => a.startsWith("--region="))?.slice("--region=".length) ?? null;
  let regionFilter = "";
  let galleryRegionFilter = "";
  const params: string[] = [EMBEDDING_MODEL_VERSION];
  if (regionArg) {
    const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [regionArg]);
    if (!regionRes.rows[0]) {
      console.error(`No region named "${regionArg}"`);
      process.exit(1);
    }
    params.push(regionRes.rows[0].id);
    regionFilter = `AND s.id IN (SELECT species_id FROM region_species WHERE region_id = $2)`;
    galleryRegionFilter = `AND p.species_id IN (SELECT species_id FROM region_species WHERE region_id = $2)`;
    console.log(`[backfill-reference-embeddings] scoped to region "${regionArg}"`);
  }

  const res = await pool.query<{ id: string; scientific_name: string; reference_display_path: string | null }>(
    `SELECT s.id, s.scientific_name, s.reference_display_path
     FROM species s
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $1
     WHERE s.reference_display_path IS NOT NULL AND sre.species_id IS NULL ${regionFilter}
     ORDER BY s.scientific_name`,
    params,
  );
  console.log(`[backfill-reference-embeddings] ${res.rows.length} species need an embedding (model ${EMBEDDING_MODEL_VERSION})`);

  let done = 0;
  let failed = 0;
  for (const row of res.rows) {
    try {
      const buffer = await readFile(row.reference_display_path!);
      const embedding = await computeEmbedding(buffer);
      await pool.query(
        `INSERT INTO species_reference_embeddings (species_id, embedding, model_version)
         VALUES ($1, $2, $3)
         ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
        [row.id, embedding, EMBEDDING_MODEL_VERSION],
      );
      done++;
    } catch (err) {
      failed++;
      console.error(`[backfill-reference-embeddings] FAILED ${row.scientific_name}:`, (err as Error).message);
    }
    if ((done + failed) % 200 === 0) console.log(`[backfill-reference-embeddings] ${done + failed}/${res.rows.length}`);
  }
  console.log(`[backfill-reference-embeddings] done: ${done} embedded, ${failed} failed`);

  const galleryRes = await pool.query<{ id: string; species_id: string; scientific_name: string; display_path: string }>(
    `SELECT p.id, p.species_id, s.scientific_name, p.display_path
     FROM species_reference_photos p
     JOIN species s ON s.id = p.species_id
     LEFT JOIN species_reference_gallery_embeddings ge ON ge.reference_photo_id = p.id AND ge.model_version = $1
     WHERE p.display_path IS NOT NULL AND ge.reference_photo_id IS NULL ${galleryRegionFilter}
     ORDER BY s.scientific_name`,
    params,
  );
  console.log(`[backfill-reference-embeddings] ${galleryRes.rows.length} gallery photos need an embedding (model ${EMBEDDING_MODEL_VERSION})`);

  let galleryDone = 0;
  let galleryFailed = 0;
  for (const row of galleryRes.rows) {
    try {
      const buffer = await readFile(row.display_path);
      const embedding = await computeEmbedding(buffer);
      await pool.query(
        `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (reference_photo_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
        [row.id, row.species_id, embedding, EMBEDDING_MODEL_VERSION],
      );
      galleryDone++;
    } catch (err) {
      galleryFailed++;
      console.error(`[backfill-reference-embeddings] FAILED gallery photo of ${row.scientific_name}:`, (err as Error).message);
    }
    if ((galleryDone + galleryFailed) % 200 === 0) {
      console.log(`[backfill-reference-embeddings] gallery ${galleryDone + galleryFailed}/${galleryRes.rows.length}`);
    }
  }
  console.log(`[backfill-reference-embeddings] gallery done: ${galleryDone} embedded, ${galleryFailed} failed`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
