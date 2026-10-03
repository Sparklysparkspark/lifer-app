// Re-enriches every species marked enriched_at but with no reference_photo, since a transient
// rate limit during enrichment can leave a species photoless. Safe to re-run: persistEnrichment
// never overwrites existing data with NULL.
//
// Usage: npx tsx src/scripts/recheck-null-photo-species.ts [--countries=Canada,France]
import { pool } from "../db.js";
import { enrichSpecies, persistEnrichment } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 4;

// --countries= limits this to species on those countries' checklists; omit for the whole catalog.
async function main() {
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countries = countriesArg ? countriesArg.split("=")[1].split(",") : null;

  const res = countries
    ? await pool.query<{ id: string; scientific_name: string }>(
        `SELECT DISTINCT s.id, s.scientific_name
         FROM region_species rs
         JOIN regions r ON r.id = rs.region_id
         LEFT JOIN regions parent ON parent.id = r.parent_id
         JOIN species s ON s.id = rs.species_id
         WHERE (r.name = ANY($1) OR parent.name = ANY($1)) AND s.enriched_at IS NOT NULL AND s.reference_photo IS NULL
         ORDER BY s.scientific_name`,
        [countries],
      )
    : await pool.query<{ id: string; scientific_name: string }>(
        `SELECT id, scientific_name FROM species WHERE enriched_at IS NOT NULL AND reference_photo IS NULL
         ORDER BY scientific_name`,
      );
  console.log(`[recheck-null-photo] ${res.rows.length} enriched-but-photoless species to recheck${countries ? ` (scoped to ${countries.join(", ")})` : ""}`);

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
