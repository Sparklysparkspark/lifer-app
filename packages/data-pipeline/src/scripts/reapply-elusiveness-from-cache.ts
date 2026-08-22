// Re-runs applyElusiveness() against the cached raw crawl result (see compute-elusiveness.ts's
// saveCrawlCache) instead of re-crawling GBIF — for iterating on WEIGHTS/boost constants in
// apply-rarity-phase4.ts and compute-rarity-phase1.ts without paying the multi-hour,
// 258-country×3-taxon-group network cost every time. Errors out if no crawl has ever run.
import { loadCrawlCache } from "../build/compute-elusiveness.js";
import { applyElusiveness } from "../build/apply-rarity-phase4.js";

async function main() {
  const cached = loadCrawlCache();
  if (!cached) {
    throw new Error("No cached crawl result found — run compute-elusiveness.ts's main() at least once first.");
  }
  console.log(`[reapply] using cached crawl: ${cached.byGbifKey.size} species, ${cached.endemicCountryIso3ByGbifKey.size} endemic`);
  await applyElusiveness(cached.byGbifKey, cached.endemicCountryIso3ByGbifKey);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
