// Source: Natural Earth (naturalearthdata.com), via the maintainer's GitHub GeoJSON mirror.
// License: public domain. Not GADM: its license is non-commercial, so its codes are fine as
// GBIF lookup keys but its geometry can't be shipped.

import { readFileSync } from "node:fs";
import { fetchCached } from "../raw-cache.js";

const ADMIN0_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_0_countries.geojson";
const ADMIN1_URL =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_admin_1_states_provinces.geojson";

export interface GeoJsonFeature {
  type: "Feature";
  properties: Record<string, unknown>;
  geometry: unknown;
}

interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}

// Memoized in-process: drill-down sweeps call this thousands of times and the file is ~40MB.
let admin0Cache: Promise<GeoJsonFeatureCollection> | null = null;
let admin1Cache: Promise<GeoJsonFeatureCollection> | null = null;

async function loadAdmin0(): Promise<GeoJsonFeatureCollection> {
  if (!admin0Cache) {
    admin0Cache = fetchCached("natural-earth", "ne_10m_admin_0_countries.geojson", ADMIN0_URL).then(
      (path) => JSON.parse(readFileSync(path, "utf-8")) as GeoJsonFeatureCollection,
    );
  }
  return admin0Cache;
}

async function loadAdmin1(): Promise<GeoJsonFeatureCollection> {
  if (!admin1Cache) {
    admin1Cache = fetchCached("natural-earth", "ne_10m_admin_1_states_provinces.geojson", ADMIN1_URL).then(
      (path) => JSON.parse(readFileSync(path, "utf-8")) as GeoJsonFeatureCollection,
    );
  }
  return admin1Cache;
}

export interface CountryEntry {
  iso3: string; // Natural Earth's ADM0_A3, used as the GADM lookup key for GBIF queries too
  // ISO 3166-1 alpha-2 (ISO_A2), for GBIF's `country` filter, which covers territorial waters
  // that the gadmGid land polygon misses (see build-region-species.ts's gbifRegionParam).
  iso2: string | null;
  name: string;
  continent: string;
  feature: GeoJsonFeature;
  // Natural Earth's SOV_A3 ("US1", "FR1", ...), shared by every entry of one sovereign state,
  // so the UI can group a country with its territories (e.g. USA with Puerto Rico) even though
  // each territory sits under its own geographic continent.
  sovereigntyGroup: string | null;
  // True when this entry is a territory of another country. Lets the picker list only primary
  // countries per continent and move territories into "Other Territories".
  isSovereignDependency: boolean;
}

// "-99" is Natural Earth's no-code sentinel and is truthy, so it needs an explicit check.
// Compound values like Taiwan's "CN-TW" fail the two-letter shape check, which lets the
// ISO_A2_EH fallback supply the real code.
function normalizeIso2(value: string | undefined): string | null {
  if (!value || value === "-99" || !/^[A-Z]{2}$/.test(value)) return null;
  return value;
}

// Whether a country-level feature is a territory of another state. NAME is sometimes
// abbreviated ("Dominican Rep.") while SOVEREIGNT is always full, so Natural Earth's TYPE field
// decides where it can. Only TYPE="Country" mixes primary states with dependencies, and there
// the NAME/SOVEREIGNT comparison is reliable.
export function isSovereignDependencyFromType(properties: { TYPE?: string; SOVEREIGNT?: string; NAME?: string }): boolean {
  switch (properties.TYPE) {
    case "Sovereign country":
      return false; // NE's label for a primary state, never a territory, regardless of NAME/SOVEREIGNT.
    case "Dependency":
      return true;
    case "Lease":
      return true; // e.g. USNB Guantanamo Bay (leased from Cuba), Baikonur (leased from Kazakhstan)
    case "Sovereignty":
      return false; // The SOVEREIGN holder's own entry (e.g. Cuba, Kazakhstan), not the leased dependent territory.
    default:
      // "Country" (mixes primary states and real dependencies), "Disputed", "Indeterminate": no
      // single TYPE value settles it, fall back to the NAME/SOVEREIGNT comparison.
      return properties.SOVEREIGNT !== properties.NAME;
  }
}

// Natural Earth's admin-0 layer includes uninhabited administrative artifacts (e.g. an
// indeterminate glacier field). Indeterminate TYPE alone isn't enough, since populated
// disputed territories share it, so only indeterminate AND uninhabited entries are dropped.
function isUninhabitedDisputedArtifact(properties: { TYPE?: string; POP_EST?: number }): boolean {
  return properties.TYPE === "Indeterminate" && (properties.POP_EST ?? 0) === 0;
}

// Buffer zones, disputed slivers and similar entries that no checklist should list as a
// destination. Dropping them loses no occurrence data: GBIF records carry the reporter's
// country code, not a Natural Earth polygon lookup, so their sightings already sit under a
// real country. Each entry's real country (not nearest by centroid, which picks wrong):
//   - Cyprus U.N. Buffer Zone, N. Cyprus, Dhekelia: Cyprus.
//   - Bir Tawil: Egypt.
//   - Siachen Glacier: India (current administration).
//   - Southern Patagonian Ice Field: Chile.
//   - Spratly Is.: Brunei, the nearest claimant.
//   - Scarborough Reef: the Philippines.
//   - Somaliland: Somalia.
const FOLD_INTO_REAL_COUNTRY = new Set([
  "Cyprus U.N. Buffer Zone",
  "N. Cyprus",
  "Dhekelia",
  "Bir Tawil",
  "Siachen Glacier",
  "Southern Patagonian Ice Field",
  "Spratly Is.",
  "Scarborough Reef",
  "Somaliland",
]);

export async function fetchAllCountries(): Promise<CountryEntry[]> {
  const data = await loadAdmin0();
  return data.features
    .filter((f) => f.properties.ADM0_A3 && f.properties.NAME)
    .filter((f) => !isUninhabitedDisputedArtifact(f.properties as { TYPE?: string; POP_EST?: number }))
    .filter((f) => !FOLD_INTO_REAL_COUNTRY.has(f.properties.NAME as string))
    .map((f) => ({
      iso3: f.properties.ADM0_A3 as string,
      // ISO_A2 is "-99" for several ordinary countries with overseas territories (France among
      // them); ISO_A2_EH carries the real code in those cases.
      iso2: normalizeIso2(f.properties.ISO_A2 as string) ?? normalizeIso2(f.properties.ISO_A2_EH as string) ?? null,
      name: f.properties.NAME as string,
      continent: (f.properties.CONTINENT as string) ?? "Other",
      feature: f,
      sovereigntyGroup: (f.properties.SOV_A3 as string) ?? null,
      isSovereignDependency: isSovereignDependencyFromType(f.properties as { TYPE?: string; SOVEREIGNT?: string; NAME?: string }),
    }));
}

export interface ProvinceEntry {
  iso3166_2: string | null; // not every province has one in the source data
  name: string;
  feature: GeoJsonFeature;
  isOverseasTerritory: boolean;
  // Natural Earth's admin-1 "type" ("State", "Region", "Oblast", ...), stored on
  // regions.subdivision_type (migration 064) so the UI can say "States"/"Regions". Null if missing.
  type: string | null;
}

// Natural Earth's admin-1 `type` wording varies by country. A narrow allowlist, not
// `includes("Territory")`, which would catch domestic units like India's "Union Territory".
// Extend as other countries' equivalents are found.
const OVERSEAS_TERRITORY_TYPES = new Set(["Overseas département", "Overseas Territory", "Dependency", "Island Area"]);

/** All provinces/states for one country (Natural Earth's `adm0_a3` property), for lazy drill-down. */
export async function fetchProvincesForCountry(iso3: string): Promise<ProvinceEntry[]> {
  const data = await loadAdmin1();
  return data.features
    .filter((f) => f.properties.adm0_a3 === iso3 && f.properties.name)
    .map((f) => ({
      iso3166_2: (f.properties.iso_3166_2 as string) ?? null,
      name: f.properties.name as string,
      feature: f,
      isOverseasTerritory: OVERSEAS_TERRITORY_TYPES.has(f.properties.type as string),
      type: (f.properties.type as string) ?? null,
    }));
}
