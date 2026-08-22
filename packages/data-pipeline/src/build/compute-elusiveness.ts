// Phase 4 (lifer-spec.md §7): the elusiveness axis — "how hard is it to detect where it
// lives" — computed from GBIF observation density with a minimum-sample threshold, so an
// unbirded area doesn't read as "rare" (the Black-capped Chickadee problem the spec calls
// out by name).
//
// The spec's own wording is "grid cells with >= N observations." A real equal-area grid
// would need a new pipeline (custom bounding-box queries per cell, ~2,600 cells for 5deg
// resolution) and a meaningfully longer GBIF pass sharing rate-limit budget with the
// overnight enrichment run — approved instead: reuse the country-level GADM occurrence
// data already fetched by build-region-species.ts's fetchSpeciesCountsForRegion, one call
// per country (~258 calls, same cost already paid for regions). Weaker for huge countries
// with wildly varying habitat within one border (Russia, Brazil, Canada) than a true grid
// would be — accepted for the same reason Phase 1's range+IUCN shortcut was: the spec
// already flags this whole axis as an approximation without eBird's checklist effort data.
//
// Detectability is NOT computed as a species' share of a country's TOTAL bird record count
// — with hundreds of species splitting one total, almost every species' share is tiny, so
// (1 - share) would pile up near 1.0 for nearly everyone regardless of real commonness
// (Mallard would come out "rare" this way). Instead each species is ranked against every
// OTHER species actually recorded in that same country — a real relative-detectability
// signal, immune to how many species happen to share the country's total.
// elusiveness(species) = weighted average of that percentile rank across every qualifying
// country (every country, not scoped to any particular viewer — this computes a
// GLOBAL, fixed tier shared across the whole app), weighted by the country's total record count so
// well-sampled countries (more reliable rankings) count more than thin ones.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fetchAllCountries } from "../fetch/fetch-region-boundary.js";
import {
  fetchSpeciesCountsForRegion,
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  RECENT_YEARS_WINDOW,
} from "./build-region-species.js";
import { AVES_CLASS_KEY } from "../fetch/fetch-gbif-backbone.js";
import { BUILD_DIR } from "../raw-cache.js";

// This crawl is a multi-hour, 258-country×3-taxon-group network pass, but re-tuning
// apply-rarity-phase4.ts's WEIGHTS/boost constants doesn't change the crawl's own output —
// only how it gets folded into the composite. Caching the raw crawl result to disk means a
// weight-tuning iteration can re-run applyElusiveness() against the SAME real data in
// seconds instead of re-crawling GBIF from scratch every time. See
// reapply-elusiveness-from-cache.ts.
const CRAWL_CACHE_PATH = path.join(BUILD_DIR, "elusiveness-crawl-cache.json");

export function saveCrawlCache(result: ElusivenessResult): void {
  mkdirSync(BUILD_DIR, { recursive: true });
  writeFileSync(
    CRAWL_CACHE_PATH,
    JSON.stringify({
      byGbifKey: [...result.byGbifKey.entries()],
      endemicCountryIso3ByGbifKey: [...result.endemicCountryIso3ByGbifKey.entries()],
    }),
  );
}

export function loadCrawlCache(): ElusivenessResult | null {
  if (!existsSync(CRAWL_CACHE_PATH)) return null;
  const raw = JSON.parse(readFileSync(CRAWL_CACHE_PATH, "utf-8")) as {
    byGbifKey: Array<[number, number]>;
    endemicCountryIso3ByGbifKey: Array<[number, string]>;
  };
  return {
    byGbifKey: new Map(raw.byGbifKey),
    countriesUsed: 0,
    countriesDropped: 0,
    endemicCountryIso3ByGbifKey: new Map(raw.endemicCountryIso3ByGbifKey),
  };
}

// Below this many total records (for whichever taxa are included in one call), a country's
// per-species ratio is too noisy to trust (a handful of museum specimens could make a
// species look "everywhere" or "nowhere").
const MIN_COUNTRY_RECORDS = 5000;

export interface TaxonGroup {
  taxonKeys: number[];
  minRecords: number;
  yearsWindow: number | null;
  // Fish default to the land polygon, not GBIF's broader `country` field — a country's fish
  // are its native land/freshwater species by default, with sea zones layered in separately
  // (see regions/routes.ts). The global elusiveness/
  // endemic signal is kept consistent with that same definition, rather than silently
  // ranking fish against a broader marine-inclusive per-country pool the checklist itself
  // no longer shows.
  landOnly?: boolean;
  // Which GBIF basisOfRecord values count as a "record" for THIS axis (see
  // build-region-species.ts's CASUAL_OBSERVATION_BASIS_OF_RECORD — defaults to the broader
  // REAL_BASIS_OF_RECORD there when omitted).
  basisOfRecord?: string[];
}

export interface ElusivenessResult {
  byGbifKey: Map<number, number>;
  countriesUsed: number;
  countriesDropped: number;
  // A species is "endemic" if it clears its taxon group's own real-
  // presence threshold in EXACTLY ONE of the 258 countries crawled here — this reuses data
  // already fetched for elusiveness, no extra GBIF calls. Deliberately checked against
  // every country regardless of whether that country's TOTAL record volume cleared
  // MIN_COUNTRY_RECORDS above (a thin-data country can still be the one true home of a real
  // endemic; excluding it would silently mislabel real endemics as non-endemic just because
  // their home country is under-sampled overall).
  endemicCountryIso3ByGbifKey: Map<number, string>;
}

// A combined crawl across every requested taxon GROUP at once — cheaper
// than one 258-country pass per taxon, and the only way to add mammals/fish without risking
// double-boosting birds' already-correct scores (applyElusiveness's nocturnal/density
// boosts are not idempotent). Critically, each group is fetched and RANKED SEPARATELY within
// a country — mixing birds/mammals/fish into one combined facet-and-rank, as this used to
// do, meant a fish's raw percentile reflected its rank against bird record VOLUME too (fish
// naturally have far fewer GBIF records per country than birds, so they'd all cluster near
// "elusiveness 1.0" regardless of real commonness — the same cross-taxon-tiering bug already
// fixed once for the composite score in apply-rarity-phase4.ts, just one layer upstream of
// it). Each group also carries its own minRecords/yearsWindow — fish need far more
// permissive values than birds (see FISH_MIN_RECORDS's comment).
export async function computeElusiveness(
  taxonGroups: TaxonGroup[] = [{ taxonKeys: [AVES_CLASS_KEY], minRecords: MIN_RECORDS, yearsWindow: RECENT_YEARS_WINDOW }],
  onProgress?: (done: number, total: number) => void,
): Promise<ElusivenessResult> {
  const countries = await fetchAllCountries();
  const weightedSum = new Map<number, number>();
  const weightSum = new Map<number, number>();
  const countriesByGbifKey = new Map<number, Set<string>>();
  let countriesUsed = 0;
  let countriesDropped = 0;

  for (let i = 0; i < countries.length; i++) {
    const country = countries[i];
    let countryTotal = 0;
    let countryHasEnoughSpecies = false;

    for (const group of taxonGroups) {
      const counts = await fetchSpeciesCountsForRegion(
        country.iso3,
        group.taxonKeys,
        group.yearsWindow,
        group.landOnly ?? false,
        group.basisOfRecord,
      );
      const total = counts.reduce((sum, c) => sum + c.recordCount, 0);
      countryTotal += total;
      if (counts.length >= 2) countryHasEnoughSpecies = true;

      for (const c of counts) {
        if (c.recordCount < group.minRecords) continue;
        if (!countriesByGbifKey.has(c.gbifKey)) countriesByGbifKey.set(c.gbifKey, new Set());
        countriesByGbifKey.get(c.gbifKey)!.add(country.iso3);
      }

      if (total >= MIN_COUNTRY_RECORDS && counts.length >= 2) {
        const sorted = [...counts].sort((a, b) => b.recordCount - a.recordCount);
        const n = sorted.length;
        sorted.forEach((c, rank) => {
          // rank 0 = the most-recorded species IN THIS GROUP for this country ->
          // elusiveness 0 (easiest to find here); the least-recorded -> elusiveness 1.
          const percentile = rank / (n - 1);
          weightedSum.set(c.gbifKey, (weightedSum.get(c.gbifKey) ?? 0) + percentile * total);
          weightSum.set(c.gbifKey, (weightSum.get(c.gbifKey) ?? 0) + total);
        });
      }
    }

    if (countryTotal < MIN_COUNTRY_RECORDS || !countryHasEnoughSpecies) {
      countriesDropped++;
    } else {
      countriesUsed++;
    }

    onProgress?.(i + 1, countries.length);
  }

  const byGbifKey = new Map<number, number>();
  for (const [gbifKey, sum] of weightedSum) {
    byGbifKey.set(gbifKey, sum / weightSum.get(gbifKey)!);
  }

  const endemicCountryIso3ByGbifKey = new Map<number, string>();
  for (const [gbifKey, iso3s] of countriesByGbifKey) {
    if (iso3s.size === 1) endemicCountryIso3ByGbifKey.set(gbifKey, [...iso3s][0]);
  }

  return { byGbifKey, countriesUsed, countriesDropped, endemicCountryIso3ByGbifKey };
}

async function main() {
  // One combined crawl covering birds + mammals + fish — cheaper than
  // three separate 258-country passes, and the only way to add mammals/fish without risking
  // double-boosting birds' already-correct scores. Each taxon group is ranked separately
  // within a country (see computeElusiveness's own comment) and carries its own
  // minRecords/yearsWindow — fish get far more permissive values than birds/mammals.
  const { MAMMALIA_CLASS_KEY } = await import("../fetch/fetch-gbif-backbone.js");
  const { fetchFishTaxonKeys } = await import("../fetch/fetch-fish-orders.js");
  const fishKeys = await fetchFishTaxonKeys();
  // Birds and mammals were previously combined into ONE ranked group per country, which was
  // a real, serious bug: the American Black Bear, with 62,920 real global GBIF records, still
  // landed at elusiveness_score=0.7 ("hard to detect"), because bird record volumes dwarf
  // mammal volumes even for genuinely common mammals — every mammal was effectively being
  // measured on a bird-scale yardstick, the same cross-taxon-volume problem this file's own
  // comments already describe fixing for fish (fish got their own group specifically to
  // avoid this) while birds+mammals stayed combined regardless. Each taxon now ranks only
  // against its own taxon.
  const { CASUAL_OBSERVATION_BASIS_OF_RECORD } = await import("./build-region-species.js");
  // Mammals and fish restrict to CASUAL_OBSERVATION_BASIS_OF_RECORD (see its own comment —
  // museum specimens and camera-trap research records inflate apparent "documentation" for
  // species that are heavily studied precisely BECAUSE they're hard to see any other way,
  // e.g. Black Bear/Coyote/Bison all scoring harder than their real encounter difficulty).
  // Birds are left on the broader default — eBird-driven HUMAN_OBSERVATION volume already
  // dominates their real record count, so this wouldn't move their already-calibrated scores
  // enough to be worth risking against BIRD_ABSOLUTE_TIER_THRESHOLDS' existing calibration.
  const taxonGroups: TaxonGroup[] = [
    { taxonKeys: [AVES_CLASS_KEY], minRecords: MIN_RECORDS, yearsWindow: RECENT_YEARS_WINDOW },
    {
      taxonKeys: [MAMMALIA_CLASS_KEY],
      minRecords: MIN_RECORDS,
      yearsWindow: RECENT_YEARS_WINDOW,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
    },
    {
      taxonKeys: fishKeys,
      minRecords: FISH_MIN_RECORDS,
      yearsWindow: FISH_YEARS_WINDOW,
      landOnly: true,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
    },
  ];
  console.log(
    `[elusiveness] crawling ${taxonGroups.length} taxon groups (birds: ${taxonGroups[0].taxonKeys.length} keys, mammals: ${taxonGroups[1].taxonKeys.length} keys, fish: ${taxonGroups[2].taxonKeys.length} keys)`,
  );

  const result = await computeElusiveness(taxonGroups, (done, total) => {
    if (done % 20 === 0 || done === total) console.log(`[elusiveness] ${done}/${total} countries queried`);
  });
  console.log(
    `[elusiveness] done. ${result.countriesUsed} countries used, ${result.countriesDropped} dropped ` +
      `(< ${MIN_COUNTRY_RECORDS} records), ${result.byGbifKey.size} species scored, ` +
      `${result.endemicCountryIso3ByGbifKey.size} endemic to a single country.`,
  );
  saveCrawlCache(result);

  const { applyElusiveness } = await import("./apply-rarity-phase4.js");
  await applyElusiveness(result.byGbifKey, result.endemicCountryIso3ByGbifKey);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
