// Re-enriches every species marked enriched_at but with no reference_photo. A real bug (fixed
// alongside this script) meant fetchINaturalistTaxon/findReclassifiedTaxon/
// fetchINaturalistSubspecies used a plain `fetch()` with no retry-on-429 — a single transient
// rate-limit hit during the initial enrichment permanently read as "no photo exists" (enriched_at
// still got set), for a species that may have had a perfectly good iNaturalist photo the whole
// time. Confirmed concretely for Phasianus versicolor (Green Pheasant) — a species-rank exact
// iNaturalist match with a real default photo — which nonetheless ended up with reference_photo
// NULL. persistEnrichment's COALESCE-against-existing-NULL semantics mean this is safe to
// re-run broadly: a species that genuinely has no photo anywhere just gets marked again with
// no change, no different from before.
import { pool } from "../db.js";
import { enrichSpecies, persistEnrichment } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 4;

async function main() {
  const res = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE enriched_at IS NOT NULL AND reference_photo IS NULL
     ORDER BY scientific_name`,
  );
  console.log(`[recheck-null-photo] ${res.rows.length} enriched-but-photoless species to recheck`);

  let done = 0;
  let recovered = 0;
  let failed = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (row) => {
    try {
      const enrichment = await enrichSpecies({ id: row.id, scientific_name: row.scientific_name });
      if (enrichment.referencePhoto) recovered++;
      await persistEnrichment(row.id, enrichment);
    } catch (err) {
      failed++;
      console.error(`[recheck-null-photo] FAILED ${row.scientific_name}:`, err);
    }
    done++;
    if (done % 250 === 0) {
      console.log(`[recheck-null-photo] ${done}/${res.rows.length} (${recovered} recovered a photo, ${failed} failed)`);
    }
  });

  console.log(`[recheck-null-photo] done. ${done} processed, ${recovered} recovered a photo, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
