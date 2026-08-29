// Scoped enrichment pass for the Finland + Canada region rollout: fetches iNaturalist
// enrichment (photo/blurb/gallery) for every species now present in either country's
// region_species rows that hasn't been enriched yet, rather than waiting for the lazy
// on-view path (species/routes.ts, lazyEnrich.ts) or the much larger enrich-all-species.ts
// sweep to reach them. Concurrency limited to stay polite to iNaturalist's public API.
import { pool } from "../db.js";
import { enrichSpecies, persistEnrichment } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 2;

async function speciesIdsForCountry(countryName: string): Promise<string[]> {
  const countryRes = await pool.query<{ id: string }>(
    `SELECT id FROM regions WHERE name = $1 AND parent_id IS NOT NULL`,
    [countryName],
  );
  const country = countryRes.rows[0];
  if (!country) {
    console.error(`[enrich-finland-canada] No country row found for "${countryName}"`);
    return [];
  }

  const provincesRes = await pool.query<{ id: string }>(
    `SELECT id FROM regions WHERE parent_id = $1`,
    [country.id],
  );
  const regionIds = [country.id, ...provincesRes.rows.map((r) => r.id)];

  const res = await pool.query<{ species_id: string }>(
    `SELECT DISTINCT species_id FROM region_species WHERE region_id = ANY($1)`,
    [regionIds],
  );
  return res.rows.map((r) => r.species_id);
}

async function main() {
  const finlandIds = await speciesIdsForCountry("Finland");
  const canadaIds = await speciesIdsForCountry("Canada");
  const allIds = Array.from(new Set([...finlandIds, ...canadaIds]));
  console.log(
    `[enrich-finland-canada] Finland: ${finlandIds.length} species, Canada: ${canadaIds.length} species, ${allIds.length} distinct total`,
  );

  const res = await pool.query<{ id: string; scientific_name: string }>(
    `SELECT id, scientific_name FROM species WHERE id = ANY($1) AND enriched_at IS NULL ORDER BY scientific_name`,
    [allIds],
  );
  const rows = res.rows;
  console.log(`[enrich-finland-canada] ${rows.length} species still need enrichment (concurrency=${CONCURRENCY})`);

  let done = 0;
  let failed = 0;
  await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
    try {
      const enrichment = await enrichSpecies({ id: row.id, scientific_name: row.scientific_name });
      await persistEnrichment(row.id, enrichment);
    } catch (err) {
      failed++;
      console.error(`[enrich-finland-canada] FAILED ${row.scientific_name}:`, err);
      await pool.query(`UPDATE species SET enriched_at = now() WHERE id = $1`, [row.id]);
    }
    done++;
    if (done % 50 === 0) {
      console.log(`[enrich-finland-canada] ${done}/${rows.length} (${failed} failed)`);
    }
  });

  console.log(`[enrich-finland-canada] done. ${done} processed, ${failed} failed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
