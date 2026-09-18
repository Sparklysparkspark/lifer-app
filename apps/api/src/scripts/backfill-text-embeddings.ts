// One-time (then incremental) backfill for species_text_embeddings (migration 102) — the
// zero-shot text-prompt signal blended into rankSpeciesByEmbedding/rankSpeciesByEmbeddings (see
// embeddings.ts's TEXT_BLEND_WEIGHT). Species-scoped, not region-scoped: a species' name-based
// embedding is the same everywhere, so this only ever needs to run once per species regardless
// of how many regions/packs it ends up appearing in.
//
// Usage: npx tsx src/scripts/backfill-text-embeddings.ts [--limit=N]
import { pool } from "../db.js";
import { downloadTextModel, embedQueryText, isTextModelDownloaded, TEXT_MODEL_VERSION } from "../species/textEmbedding.js";

async function main() {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith("--limit="))?.split("=")[1];
  const limit = limitArg ? Number(limitArg) : null;

  if (!isTextModelDownloaded()) {
    console.log("[backfill-text-embeddings] downloading text model...");
    await downloadTextModel();
  }

  const res = await pool.query<{ id: string; common_name: string | null; scientific_name: string }>(
    `SELECT s.id, s.common_name, s.scientific_name
     FROM species s
     LEFT JOIN species_text_embeddings ste ON ste.species_id = s.id AND ste.model_version = $1
     WHERE ste.species_id IS NULL
     ORDER BY s.scientific_name
     ${limit ? "LIMIT $2" : ""}`,
    limit ? [TEXT_MODEL_VERSION, limit] : [TEXT_MODEL_VERSION],
  );
  console.log(`[backfill-text-embeddings] ${res.rows.length} species need a text embedding`);

  let done = 0;
  let failed = 0;
  for (const row of res.rows) {
    const name = row.common_name ?? row.scientific_name;
    try {
      const embedding = await embedQueryText(`a photo of a ${name}`);
      await pool.query(
        `INSERT INTO species_text_embeddings (species_id, embedding, model_version)
         VALUES ($1, $2, $3)
         ON CONFLICT (species_id) DO UPDATE SET embedding = EXCLUDED.embedding, model_version = EXCLUDED.model_version, computed_at = now()`,
        [row.id, embedding, TEXT_MODEL_VERSION],
      );
      done++;
    } catch (err) {
      failed++;
      console.error(`[backfill-text-embeddings] failed for ${name}:`, (err as Error).message);
    }
    if ((done + failed) % 100 === 0) console.log(`[backfill-text-embeddings] ${done + failed}/${res.rows.length}`);
  }
  console.log(`[backfill-text-embeddings] done: ${done} embedded, ${failed} failed`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
