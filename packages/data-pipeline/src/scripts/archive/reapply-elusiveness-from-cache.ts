// Re-runs applyElusiveness() against the cached raw crawl (see compute-elusiveness.ts's
// saveCrawlCache) instead of re-crawling GBIF, for tuning the weights and boost constants in
// apply-rarity-phase4.ts and compute-rarity-phase1.ts. Errors out if no crawl has run.
import { loadCrawlCache } from "../../build/compute-elusiveness.js";
import { applyElusiveness } from "../../build/apply-rarity-phase4.js";

async function main() {
  const cached = loadCrawlCache();
  if (!cached) {
    throw new Error("No cached crawl result found: run compute-elusiveness.ts's main() at least once first.");
  }
  console.log(`[reapply] using cached crawl: ${cached.byGbifKey.size} species, ${cached.endemicCountryIso3ByGbifKey.size} endemic`);
  await applyElusiveness(cached.byGbifKey, cached.endemicCountryIso3ByGbifKey);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
