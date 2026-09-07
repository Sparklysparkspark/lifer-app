// Source: Natural Earth (naturalearthdata.com), via the maintainer's own GitHub GeoJSON
// mirror. License: public domain, any use. Deliberately NOT GADM, even though GADM is what
// build-region-species.ts already uses for GBIF occurrence-query codes — checked GADM's
// actual license by hand: non-commercial only. Using their code as a lookup key against
// GBIF's own API is fine; shipping their polygon *geometry* in a map would not be. Verified
// both files below are real and fetchable before writing this.

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

// Memoized in-process: fetchProvincesForCountry is called once per region during a full
// drill-down sweep (thousands of calls in a single run — see compute-all-regions.ts /
// recompute-all-regions.ts), and this file is ~40MB — re-reading and re-JSON.parsing it from
// disk on every single call was turning an otherwise-instant local lookup into several minutes
// of redundant I/O and parsing over the course of one sweep.
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
  // ISO 3166-1 alpha-2 (Natural Earth's ISO_A2) — used for GBIF's `country` occurrence
  // filter, a DIFFERENT and broader signal than `gadmGid` (see build-region-species.ts's
  // gbifRegionParam: GADM's land administrative polygon for a country barely covers
  // territorial waters, so marine/coastal species get systematically undercounted through
  // gadmGid — confirmed for Egypt: country=EG's fish facet has 1,707 distinct species
  // vs gadmGid=EGY's 964, a 77% gap, matching real Red Sea estimates far better).
  iso2: string | null;
  name: string;
  continent: string;
  feature: GeoJsonFeature;
  // Natural Earth's SOV_A3 ("US1", "FR1", ...) — a sovereignty-GROUP code shared by every
  // entry belonging to the same sovereign state, including its own metropolitan/mainland entry.
  // Different from `iso3` (ADM0_A3): e.g. Puerto Rico's own iso3 is "PRI", but its SOV_A3 is
  // "US1", the SAME code the United States of America's own entry carries — that shared code
  // is what lets the UI group "United States of America" with "Puerto Rico"/"U.S. Virgin Is."/
  // "U.S. Minor Outlying Is." as one sovereignty's territories, even though Natural Earth
  // already (correctly) places each one under its own true geographic continent rather than
  // nesting them under the metropolitan country the way admin-1 provinces are nested.
  sovereigntyGroup: string | null;
  // True when this entry is a dependency/territory of ANOTHER country, not the primary
  // sovereign state itself — Natural Earth's SOVEREIGNT property equals NAME for the primary
  // (France/SOVEREIGNT=France) and differs for its own territories (New Caledonia/SOVEREIGNT=
  // France). Lets the picker keep its main continent pill list to just the ~195 primary
  // countries, moving territories into a separate "Other Territories" catch-all instead of
  // cluttering it (e.g. North America otherwise lists ~15 tiny UK/French/US/Dutch territories
  // alongside real countries).
  isSovereignDependency: boolean;
}

// "-99" is a non-empty, truthy STRING — `a || b` never falls through to `b` for it, so the
// sentinel needs an explicit check, not falsy-coercion (a first pass at this fix got bitten by
// exactly that and silently kept returning "-99" for France). A real ISO 3166-1 alpha-2 code is
// always exactly two letters — Taiwan's own ISO_A2 comes back as "CN-TW" (Natural Earth's
// politically-hedged compound value for a contested territory, not the "-99" sentinel), which
// passed the truthy/sentinel checks and silently broke `country=CN-TW` GBIF queries the same
// way "-99" broke France's, before this shape check existed. Confirmed live: Taiwan's own
// ISO_A2_EH correctly holds "TW" and is exactly this fallback's job to reach.
function normalizeIso2(value: string | undefined): string | null {
  if (!value || value === "-99" || !/^[A-Z]{2}$/.test(value)) return null;
  return value;
}

/** Every country in the world, grouped by continent — local file filtering, no network calls beyond the initial cache fetch. */
// Whether a country-level Natural Earth feature is a dependency/territory of another sovereign
// state, rather than the primary state itself. Previously just `SOVEREIGNT !== NAME` — broken
// for any country whose abbreviated NAME field differs from SOVEREIGNT's always-full form (e.g.
// NAME="Dominican Rep." vs SOVEREIGNT="Dominican Republic": same country, different strings),
// which wrongly flagged 19 real sovereign countries (Dominican Republic, Tanzania, Serbia,
// Bahamas, ...) as territories. Natural Earth's own TYPE field is the authoritative signal for
// the unambiguous cases; only TYPE="Country" genuinely mixes primary states (France, the
// Netherlands, Denmark, ...) with their own dependencies (Sint Maarten, Curaçao, Greenland, ...)
// under the same type, where the NAME/SOVEREIGNT comparison is reliable since none of those
// primary "Country" entries have an abbreviated NAME.
export function isSovereignDependencyFromType(properties: { TYPE?: string; SOVEREIGNT?: string; NAME?: string }): boolean {
  switch (properties.TYPE) {
    case "Sovereign country":
      return false; // NE's own label for a primary state — never a territory, regardless of NAME/SOVEREIGNT text.
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

// Natural Earth's admin-0 layer includes a handful of uninhabited, disputed administrative
// artifacts alongside real countries — e.g. "Southern Patagonian Ice Field" (TYPE:
// "Indeterminate", POP_EST: 0, no real ISO code), a glacier field between Chile and Argentina
// that's still under survey, not a place anyone lives or a country either government actually
// claims as a distinct state. TYPE="Indeterminate" alone isn't enough to exclude (a genuinely
// populated disputed territory like Western Sahara also carries an ambiguous TYPE), so this only
// filters the narrower case: indeterminate AND uninhabited.
function isUninhabitedDisputedArtifact(properties: { TYPE?: string; POP_EST?: number }): boolean {
  return properties.TYPE === "Indeterminate" && (properties.POP_EST ?? 0) === 0;
}

// A second class of admin-0 entry that isn't a real, independently browsable "country" for this
// app's purposes: a UN buffer zone / disputed sliver / uninhabited ice field that Natural Earth
// still models as its own polygon, but that no wildlife-photography checklist should ever list
// as a destination in its own right — nobody browses "Bir Tawil" or "Cyprus U.N. Buffer Zone" as
// a place to go find species. Excluding these here (rather than deleting their leftover `regions`
// rows once and leaving the underlying fetch behavior unfixed) means they never come back as
// orphan uncomputed "countries" again. This does NOT lose any real occurrence data: GBIF's own
// records carry a country code assigned by whoever reported the sighting (eBird/iNat's own
// political-reality country field), not a lookup against Natural Earth's polygon — a bird seen
// in the buffer zone is already filed under Cyprus (or wherever) in GBIF's own data, so folding
// these into their real neighbor here doesn't change what GBIF actually returns for that country.
//
// Real-world justification per entry (not a generic "nearest by centroid" rule — tried that,
// and it picked Djibouti for Somaliland and Tajikistan for Siachen Glacier, neither of which
// has any actual claim; genuinely wrong shapes for that math, not just close calls):
//   - Cyprus U.N. Buffer Zone, N. Cyprus, Dhekelia: all three sit on the one island of Cyprus,
//     already covered end to end by the real "Cyprus" entry — folded there, not into whichever
//     side of the Green Line is nearest.
//   - Bir Tawil: an unclaimed desert wedge between Egypt and Sudan (an artifact of the two
//     countries' non-matching border claims, not disputed BY either government) — folded into
//     Egypt, the nearer of the two real neighbors.
//   - Siachen Glacier: disputed between India and Pakistan, currently under Indian
//     administration — folded into India.
//   - Southern Patagonian Ice Field: disputed between Chile and Argentina — folded into Chile,
//     the nearer of the two.
//   - Spratly Is.: disputed among several South China Sea claimants — folded into Brunei, the
//     nearest real claimant.
//   - Scarborough Reef: disputed between the Philippines and China — folded into the
//     Philippines, the nearer real claimant.
//   - Somaliland: not disputed between two neighbors — Somalia is the one government that
//     claims it as its own territory — folded into Somalia.
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
      // ISO_A2 is "-99" (Natural Earth's own sentinel for "complex sovereignty," same class of
      // case as Taiwan's compound code elsewhere in this codebase) for several ordinary
      // countries with overseas territories — France among them, confirmed live: this silently
      // broke France's `country=FR` GBIF query, quietly falling back to the narrower
      // gadmGid=FRA land-polygon query instead (the exact under-counting problem gadmGid's own
      // comment above describes for Egypt) for as long as this code has existed. ISO_A2_EH
      // ("de facto" extended field) carries the real code in every such case and is only
      // missing where ISO_A2 would have been meaningful anyway, so it's a strict improvement,
      // never a regression, as the fallback.
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
  // Natural Earth's raw admin-1 "type" ("State", "Region", "Province", "Oblast", ...) — stored
  // per-child on regions.subdivision_type (migration 064) so the UI can say "States"/"Regions"
  // instead of always "Provinces". Null when the source feature has no type at all.
  type: string | null;
}

// Natural Earth's admin1 `type` field distinguishes this per-country in different wording (no
// single universal enum) — confirmed live for France ("Overseas département" vs "Metropolitan
// département"). Deliberately a narrow allowlist, not a blind `type.includes("Territory")`:
// that would misfire on e.g. India's ordinary "Union Territory" or Malaysia's "Federal
// Territory", which are normal domestic administrative units, not overseas dependencies in the
// sense meant here. First pass — extend as other countries' equivalents are found.
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
