// One-off backfill for species already marked enriched_at with no main photo found, to
// retry them through the iNaturalist-taxon-change-aware lookup. Some species (e.g. Bison
// bison, reclassified as Bos bison) have real photos filed under a current name that an
// exact-name search alone won't find without checking iNaturalist's own taxon_changes
// history. Not every retry will find something — some of these are genuinely obscure with
// no photo anywhere — but every one gets a fair second try under the fixed lookup.
import { pool } from "../db.js";
import { enrichSpecies, persistEnrichment } from "../species/lazyEnrich.js";
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
    commons_image: string | null;
  }>(
    `SELECT id, scientific_name, wikipedia_title, commons_image FROM species
     WHERE enriched_at IS NOT NULL AND reference_photo IS NULL ORDER BY scientific_name`,
  );

  const canadaRows = res.rows.filter((r) => canadaIds.has(r.id));
  const restRows = res.rows.filter((r) => !canadaIds.has(r.id));
  const ordered = [...canadaRows, ...restRows];
  console.log(`[backfill-reclassified] ${ordered.length} species with no photo to retry (${canadaRows.length} Canada)`);

  let done = 0;
  let recovered = 0;
  await mapWithConcurrency(ordered, CONCURRENCY, async (row) => {
    try {
      const enrichment = await enrichSpecies(row);
      if (enrichment.referencePhoto) {
        await persistEnrichment(row.id, enrichment);
        recovered++;
      }
    } catch (err) {
      console.error(`[backfill-reclassified] FAILED ${row.scientific_name}:`, err);
    }
    done++;
    if (done % 25 === 0) console.log(`[backfill-reclassified] ${done}/${ordered.length} (${recovered} recovered)`);
  });

  console.log(`[backfill-reclassified] done. ${done} processed, ${recovered} recovered a photo.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
