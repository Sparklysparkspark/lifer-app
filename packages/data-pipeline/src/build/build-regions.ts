// Seeds the region hierarchy worldwide: World -> Continent -> Country, from the cached Natural
// Earth admin-0 file (grouped by its CONTINENT property), with no GBIF calls. Provinces
// (admin-1) are created lazily when a user drills into a country (apps/api's regions/routes.ts
// POST /regions/:id/drill-down), since most will never be opened.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchAllCountries } from "../fetch/fetch-region-boundary.js";

export interface RegionSeed {
  name: string;
  parentName: string | null;
  // GADM code, used only as a GBIF occurrence-query key, never redistributed as data.
  // Empty for World/continents.
  externalCodes: string[];
  // eBird's region code, for the Illustrated Checklist deep link (a different code space than
  // externalCodes). Only set for countries where it's been verified; null elsewhere.
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown | null;
  // Natural Earth's SOV_A3 sovereignty-group code, shared by a country and its territories (see
  // CountryEntry in fetch-region-boundary.ts). Null for World/continents.
  sovereigntyGroup: string | null;
  isSovereignDependency: boolean;
}

// Countries whose eBird region code has been checked by hand, since eBird's codes don't always
// match ISO/GADM.
const KNOWN_EBIRD_COUNTRY_CODES: Record<string, string> = {
  CAN: "CA",
};

export async function buildRegions(): Promise<RegionSeed[]> {
  const countries = await fetchAllCountries();
  const continents = [...new Set(countries.map((c) => c.continent))];

  const regions: RegionSeed[] = [
    {
      name: "World",
      parentName: null,
      externalCodes: [],
      ebirdRegionCode: null,
      boundaryGeoJson: null,
      sovereigntyGroup: null,
      isSovereignDependency: false,
    },
  ];

  for (const continent of continents) {
    regions.push({
      name: continent,
      parentName: "World",
      externalCodes: [],
      ebirdRegionCode: null,
      boundaryGeoJson: null,
      sovereigntyGroup: null,
      isSovereignDependency: false,
    });
  }

  for (const country of countries) {
    regions.push({
      name: country.name,
      parentName: country.continent,
      externalCodes: [country.iso3],
      ebirdRegionCode: KNOWN_EBIRD_COUNTRY_CODES[country.iso3] ?? null,
      boundaryGeoJson: country.feature,
      sovereigntyGroup: country.sovereigntyGroup,
      isSovereignDependency: country.isSovereignDependency,
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
