// One-off backfill applying the improved description pipeline (iNaturalist's own
// wikipedia_summary field, a longer 4-sentence truncation) to species that were already
// enriched under the older, thinner pipeline. iNaturalist-only — no direct Wikipedia fallback
// (see lazyEnrich.ts's top comment for why), so this no longer backfills habitat_description
// (iNaturalist's summary is intro-only and never carries habitat/range text; that field stays
// null for these species rather than paying for it with a direct Wikipedia call). Deliberately
// does NOT touch photos/gallery — those are unaffected by this change and re-downloading them
// here would be pure waste. Writes description unconditionally (not via persistEnrichment's
// COALESCE) since the goal is to upgrade what's already there, not preserve it.
import { pool } from "../db.js";
import { fetchINaturalistTaxon, fetchINaturalistWikipediaSummary } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 4;

async function main() {
  const canadaRes = await pool.query<{ species_id: string }>(
    `SELECT rs.species_id FROM region_species rs
     JOIN regions r ON r.id = rs.region_id WHERE r.name = 'Canada'`,
  );
  const canadaIds = new Set(canadaRes.rows.map((r) => r.species_id));

  const res = await pool.query<{
    id: string;
    scientific_name: string;
  }>(`SELECT id, scientific_name FROM species WHERE enriched_at IS NOT NULL ORDER BY scientific_name`);

  const canadaRows = res.rows.filter((r) => canadaIds.has(r.id));
  const restRows = res.rows.filter((r) => !canadaIds.has(r.id));
  const ordered = [...canadaRows, ...restRows];
  console.log(`[backfill-description] ${ordered.length} already-enriched species to upgrade (${canadaRows.length} Canada)`);

  let done = 0;
  let updated = 0;
  await mapWithConcurrency(ordered, CONCURRENCY, async (row) => {
    try {
      let description: string | null = null;
      let descriptionCredit: string | null = null;
      let descriptionSourceUrl: string | null = null;

      const taxon = await fetchINaturalistTaxon(row.scientific_name);
      if (taxon) {
        const inatSummary = await fetchINaturalistWikipediaSummary(taxon.id);
        if (inatSummary) {
          description = inatSummary.summary;
          descriptionCredit = "Wikipedia contributors (CC BY-SA), via iNaturalist";
          descriptionSourceUrl = inatSummary.wikipediaUrl;
        }
      }

      if (description) {
        await pool.query(
          `UPDATE species SET
             description = $1,
             description_credit = $2,
             description_source_url = $3
           WHERE id = $4`,
          [description, descriptionCredit, descriptionSourceUrl, row.id],
        );
        updated++;
      }
    } catch (err) {
      console.error(`[backfill-description] FAILED ${row.scientific_name}:`, err);
    }
    done++;
    if (done % 25 === 0) console.log(`[backfill-description] ${done}/${ordered.length} (${updated} updated)`);
  });

  console.log(`[backfill-description] done. ${done} processed, ${updated} updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
