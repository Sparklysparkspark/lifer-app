// One-off backfill applying the improved description/habitat pipeline (iNaturalist's own
// wikipedia_summary field, a longer 4-sentence truncation, and Habitat/Range section
// extraction) to species that were already enriched under the older, thinner pipeline.
// Deliberately does NOT touch photos/gallery — those are unaffected by this change and
// re-downloading them here would be pure waste (see fetchINaturalistWikipediaSummary's own
// comment). Writes description/habitat unconditionally (not via persistEnrichment's COALESCE)
// since the goal is to upgrade what's already there, not preserve it.
import { pool } from "../db.js";
import { fetchINaturalistTaxon, fetchINaturalistWikipediaSummary, fetchWikipediaBlurb } from "../species/lazyEnrich.js";
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
    wikipedia_title: string | null;
  }>(`SELECT id, scientific_name, wikipedia_title FROM species WHERE enriched_at IS NOT NULL ORDER BY scientific_name`);

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
      let habitatDescription: string | null = null;

      const taxon = await fetchINaturalistTaxon(row.scientific_name);
      if (taxon) {
        const inatSummary = await fetchINaturalistWikipediaSummary(taxon.id);
        if (inatSummary) {
          description = inatSummary.summary;
          descriptionCredit = "Wikipedia contributors (CC BY-SA), via iNaturalist";
          descriptionSourceUrl = inatSummary.wikipediaUrl;
        }
      }

      if (row.wikipedia_title) {
        const blurb = await fetchWikipediaBlurb(row.wikipedia_title);
        if (blurb) {
          habitatDescription = blurb.habitatDescription;
          descriptionSourceUrl = blurb.descriptionSourceUrl;
          if (!description) {
            description = blurb.description;
            descriptionCredit = blurb.descriptionCredit;
          }
        }
      }

      if (description || habitatDescription) {
        await pool.query(
          `UPDATE species SET
             description = COALESCE($1, description),
             description_credit = COALESCE($2, description_credit),
             description_source_url = COALESCE($3, description_source_url),
             habitat_description = COALESCE($4, habitat_description)
           WHERE id = $5`,
          [description, descriptionCredit, descriptionSourceUrl, habitatDescription, row.id],
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
