// One-off backfill for species that are already marked enriched_at but ended up with zero
// gallery photos. This happens for two reasons: (1) they were bulk-enriched before the
// iNaturalist gallery fix landed, back when the bulk pass deliberately skipped the slow
// Wikipedia-only gallery path entirely; (2) they were bulk-enriched with the fix in place, but
// iNaturalist genuinely had zero photos AND the Wikipedia fallback also came up empty. This
// script can't tell those two cases apart without trying again, so it just retries every
// zero-gallery species through the current (fixed) fetchAnyGallery path — for case (2) it'll
// harmlessly find zero again. Neither the main enrich-all-species.ts pass (only ever looks at
// enriched_at IS NULL) nor backfill-reference-derivatives.ts (only re-caches photos already on
// record) covers this gap — the only other path that does is the lazy per-view backfill in
// species/routes.ts, which only fires one species at a time as someone happens to open that
// page. Not good enough for "Canada fully usable offline" — hence this proactive pass.
import { pool } from "../db.js";
import { fetchAnyGallery, persistGalleryPromotingMainIfMissing } from "../species/lazyEnrich.js";
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
    reference_photo: string | null;
  }>(
    `SELECT s.id, s.scientific_name, s.wikipedia_title, s.reference_photo FROM species s
     WHERE s.enriched_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM species_reference_photos p WHERE p.species_id = s.id)
     ORDER BY s.scientific_name`,
  );

  // Canada first, same priority as the rest of this enrichment effort.
  const canadaRows = res.rows.filter((r) => canadaIds.has(r.id));
  const restRows = res.rows.filter((r) => !canadaIds.has(r.id));
  const ordered = [...canadaRows, ...restRows];
  console.log(`[backfill-galleries] ${ordered.length} species with zero gallery photos (${canadaRows.length} Canada)`);

  let done = 0;
  let filled = 0;
  await mapWithConcurrency(ordered, CONCURRENCY, async (row) => {
    try {
      const gallery = await fetchAnyGallery(row);
      if (gallery.length > 0) {
        await persistGalleryPromotingMainIfMissing(row.id, gallery, !!row.reference_photo);
        filled++;
      }
    } catch (err) {
      console.error(`[backfill-galleries] FAILED ${row.scientific_name}:`, err);
    }
    done++;
    if (done % 50 === 0) console.log(`[backfill-galleries] ${done}/${ordered.length} (${filled} filled)`);
  });

  console.log(`[backfill-galleries] done. ${done} processed, ${filled} got a gallery.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
