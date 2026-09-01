// One-time (then incremental) pass: computes an embedding for every enriched species' own
// reference photo and stores it in species_reference_embeddings — the "species the user hasn't
// photographed yet" side of species auto-suggest (see embeddings.ts in this same package, and
// apps/api/src/species/embeddings.ts's suggestSpecies, which reads this table). Shipped to
// users as part of the existing catalog seed download (CATALOG_SEED_URL), not a new mechanism —
// this script just populates the source-of-truth table that seed gets built from.
//
// Only re-embeds a species when it has no row yet, or its stored model_version is stale — safe
// to re-run any time (e.g. after enriching a new batch of species, or after bumping
// EMBEDDING_MODEL_VERSION).
import { pool } from "../db.js";
import { computeEmbedding, EMBEDDING_MODEL_VERSION } from "../embeddings.js";
import { readFile } from "node:fs/promises";

async function main() {
  const res = await pool.query<{ id: string; scientific_name: string; reference_display_path: string | null }>(
    `SELECT s.id, s.scientific_name, s.reference_display_path
     FROM species s
     LEFT JOIN species_reference_embeddings sre ON sre.species_id = s.id AND sre.model_version = $1
     WHERE s.reference_display_path IS NOT NULL AND sre.species_id IS NULL
     ORDER BY s.scientific_name`,
    [EMBEDDING_MODEL_VERSION],
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
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
