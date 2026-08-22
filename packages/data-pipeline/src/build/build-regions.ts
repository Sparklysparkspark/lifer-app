// Seeds the region hierarchy worldwide: World -> Continent -> Country. All local/fast — no
// GBIF calls, just filtering the already-cached Natural Earth admin-0 file (258 countries,
// grouped by its own CONTINENT property). Province/state level (admin-1, ~4600 features
// worldwide) is deliberately NOT seeded here — those are created lazily, one country at a
// time, only when a user actually drills into that country (apps/api's regions/routes.ts
// POST /regions/:id/drill-down) — seeding all 4600 upfront when most will never be opened
// would repeat the exact mistake this whole redesign fixed for species enrichment.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchAllCountries } from "../fetch/fetch-region-boundary.js";

export interface RegionSeed {
  name: string;
  parentName: string | null;
  // GADM code, used only as a GBIF occurrence-query key — never redistributed as data.
  // Empty for World/continents, which have no useful GADM-level GBIF filter.
  externalCodes: string[];
  // eBird's own region code, for the Illustrated Checklist deep link — a different code
  // space than externalCodes. Only reliably known for a handful of countries so far
  // (verified by hand, not guessed); null elsewhere rather than assumed.
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown | null;
}

// Countries eBird's region-code convention is confirmed for, from earlier hands-on checks —
// not derived automatically, since eBird's codes don't always match ISO/GADM cleanly.
const KNOWN_EBIRD_COUNTRY_CODES: Record<string, string> = {
  CAN: "CA",
};

export async function buildRegions(): Promise<RegionSeed[]> {
  const countries = await fetchAllCountries();
  const continents = [...new Set(countries.map((c) => c.continent))];

  const regions: RegionSeed[] = [{ name: "World", parentName: null, externalCodes: [], ebirdRegionCode: null, boundaryGeoJson: null }];

  for (const continent of continents) {
    regions.push({ name: continent, parentName: "World", externalCodes: [], ebirdRegionCode: null, boundaryGeoJson: null });
  }

  for (const country of countries) {
    regions.push({
      name: country.name,
      parentName: country.continent,
      externalCodes: [country.iso3],
      ebirdRegionCode: KNOWN_EBIRD_COUNTRY_CODES[country.iso3] ?? null,
      boundaryGeoJson: country.feature,
    });
  }

  return regions;
}

async function main() {
  const regions = await buildRegions();
  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "regions.json");
  writeFileSync(dest, JSON.stringify(regions, null, 2));
  console.log(`[regions] wrote ${regions.length} region(s) (world + continents + countries) to ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
