// Marks species.photo_withheld for listed species that have no photo because none of their
// iNaturalist photos may be published (see pipeline/photoWithheldBackfill.ts). Reads the cached
// iNaturalist responses first; only species with none are looked up, at lazyEnrich's pace.
//
// Usage: npm run backfill-photo-withheld -w data-pipeline -- [--dry-run] [--no-network]
//   --dry-run     print the counts, change nothing
//   --no-network  decide from cached responses only
import { pool } from "@lifer/core/db.js";
import {
  fetchFirstTaxonPhoto,
  fetchINaturalistTaxon,
  PersistentRateLimitError,
} from "@lifer/core/species/lazyEnrich.js";
import { backfillPhotoWithheld } from "../pipeline/photoWithheldBackfill.js";

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const network = !process.argv.includes("--no-network");
  const result = await backfillPhotoWithheld(pool, {
    dryRun,
    network,
    log: (m) => console.log(`[backfill-photo-withheld] ${m}`),
    // Both go through fetchWithRetry, which caches the search and the taxon record.
    lookup: async (species) => {
      try {
        const taxon = await fetchINaturalistTaxon(species.scientific_name);
        const id = taxon?.id ?? species.inat_taxon_id;
        if (id) await fetchFirstTaxonPhoto(id);
        return { rateLimited: false };
      } catch (err) {
        if (err instanceof PersistentRateLimitError) return { rateLimited: true };
        console.error(`[backfill-photo-withheld] lookup failed for ${species.scientific_name}:`, err);
        return { rateLimited: false };
      }
    },
  });
  console.log(
    `[backfill-photo-withheld] ${dryRun ? "dry run: " : ""}${result.candidates} candidates; ` +
      `${result.withheld} have only unpublishable photos (${result.marked} marked), ` +
      `${result.publishable} have a publishable photo (re-enrich them), ${result.none} have no photo on iNaturalist, ` +
      `${result.unknown} still unknown; ${result.lookedUp} looked up` +
      (result.stoppedByRateLimit ? "; stopped early by rate limiting" : ""),
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
