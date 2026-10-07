// Builds region_species rows from GBIF occurrence data. Uses GBIF's facet=speciesKey (limit=0)
// to get per-species record counts in one call instead of paging through every record.
// MIN_RECORDS filters out one-off vagrants and museum specimens.

import { fetchWithRetry } from "../lib/fetchWithRetry.js";
import { fetchAllCountries } from "./regionBoundary.js";
import {
  pointInRing,
  minRingDistance,
  exteriorRingsFromGeometry,
  ringBoundingBox,
  type Point,
  type BoundingBox,
} from "../lib/geometry.js";

const GBIF_OCCURRENCE_API = "https://api.gbif.org/v1/occurrence/search";
// Aves' class key, the default taxon. Other taxa pass their own keys: `taxonKey` matches a taxon
// and all its descendants, and repeating it ORs, so one query works for a class or many orders.
export const AVES_CLASS_KEY = 212;
// Complements the recency window: a burst within the window can still slip through.
export const MIN_RECORDS = 10;

// Fish get far fewer citizen-science reports than birds, so the bird threshold and recency
// window would drop most real species. Fish keep only the basisOfRecord filter.
export const FISH_MIN_RECORDS = 1;
export const FISH_YEARS_WINDOW: number | null = null;

function taxonKeyParams(taxonKeys: number[]): string {
  return taxonKeys.map((k) => `taxonKey=${k}`).join("&");
}

// Excludes eDNA/bulk-sample and fossil records. Molecular sampling can misassign reads to
// impossible species, and GBIF has no per-record confidence to filter on. Repeating
// basisOfRecord ORs, like taxonKey.
export const REAL_BASIS_OF_RECORD = [
  "HUMAN_OBSERVATION",
  "OBSERVATION",
  "PRESERVED_SPECIMEN",
  "MACHINE_OBSERVATION",
  "LIVING_SPECIMEN",
];

// Sea zones also count records cited from published literature (GBIF's MATERIAL_CITATION).
// Marine fish are mostly known from fisheries surveys and papers rather than casual sightings, so
// without them a well-studied sea like the Black Sea loses common residents (tub gurnard, spiny
// dogfish) for want of direct records. Land checklists keep REAL_BASIS_OF_RECORD. Tissue and eDNA
// samples (MATERIAL_SAMPLE) stay out: DNA-based identifications are more often wrong.
export const SEA_ZONE_BASIS_OF_RECORD = [...REAL_BASIS_OF_RECORD, "MATERIAL_CITATION"];

// Elusiveness uses a narrower basis than REAL_BASIS_OF_RECORD: camera-trap and specimen effort
// follows research interest, not visibility, and makes hard-to-see species look well
// documented. Only casual human sightings count here.
export const CASUAL_OBSERVATION_BASIS_OF_RECORD = ["HUMAN_OBSERVATION", "OBSERVATION"];

function basisOfRecordParamsFor(basisOfRecord: string[]): string {
  return basisOfRecord.map((b) => `basisOfRecord=${b}`).join("&");
}

// Checklists, seasonality and the vagrancy/captive checks want the broad presence definition.
const basisOfRecordParams = basisOfRecordParamsFor(REAL_BASIS_OF_RECORD);

// Countries store an ISO3 code ("EGY"), provinces a GADM gid ("CAN.2_1"). Countries query via
// GBIF's `country` (ISO2) instead of gadmGid, because GADM's land polygon misses territorial
// waters and badly undercounts coastal and marine species. Provinces have no such fix.
let iso3ToIso2Promise: Promise<Map<string, string>> | null = null;
function iso3ToIso2Map(): Promise<Map<string, string>> {
  if (!iso3ToIso2Promise) {
    iso3ToIso2Promise = fetchAllCountries().then(
      // Natural Earth's ISO_A2 can be "-99" or a compound like "CN-TW", which GBIF rejects, so
      // only real 2-letter codes pass. Sovereign dependencies are excluded because they inherit
      // their sovereign's ISO2, which would pull the whole sovereign country's data; they fall
      // through to gadmGid instead.
      (countries) =>
        new Map(
          countries
            .filter((c) => c.iso2 && /^[A-Z]{2}$/.test(c.iso2) && !c.isSovereignDependency)
            .map((c) => [c.iso3, c.iso2!]),
        ),
    );
  }
  return iso3ToIso2Promise;
}

// landOnly forces gadmGid even for countries, so a country's default fish list is its land and
// freshwater species. Marine species come from sea zones' own polygons (fetch-iho-sea-areas.ts).
async function gbifRegionParam(externalCode: string, landOnly = false): Promise<string> {
  // A province with no GADM gid stores its boundary as WKT in external_codes instead, since
  // GBIF's gadmGid silently matches nothing for ISO 3166-2 codes like "TH-70".
  if (externalCode.startsWith("POLYGON(") || externalCode.startsWith("MULTIPOLYGON(")) {
    return `geometry=${encodeURIComponent(externalCode)}`;
  }
  if (!landOnly && !externalCode.includes(".")) {
    const iso2 = (await iso3ToIso2Map()).get(externalCode);
    if (iso2) return `country=${iso2}`;
  }
  return `gadmGid=${encodeURIComponent(externalCode)}`;
}

interface FacetResponse {
  facets: Array<{
    field: string;
    counts: Array<{ name: string; count: number }>;
  }>;
}

export interface RegionSpeciesCount {
  gbifKey: number;
  recordCount: number;
}

/** externalCode should be a GADM region GID, e.g. "CAN.2_1" (British Columbia). */
// A recent-years window stops old vagrant bursts from inflating a checklist forever, at no
// extra request cost. It won't catch a burst within the window.
export const RECENT_YEARS_WINDOW = 15;

export async function fetchSpeciesCountsForRegion(
  externalCode: string,
  taxonKeys: number[] = [AVES_CLASS_KEY],
  yearsWindow: number | null = RECENT_YEARS_WINDOW,
  landOnly = false,
  basisOfRecord: string[] = REAL_BASIS_OF_RECORD,
): Promise<RegionSpeciesCount[]> {
  return fetchSpeciesCountsForRegionParam(
    await gbifRegionParam(externalCode, landOnly),
    taxonKeys,
    yearsWindow,
    basisOfRecord,
  );
}

// Sea zones query by their own polygon via GBIF's `geometry` WKT param. yearsWindow defaults
// to null since current callers are fish-only (see FISH_YEARS_WINDOW).
export async function fetchSpeciesCountsForZone(
  wkt: string,
  taxonKeys: number[],
  yearsWindow: number | null = null,
  basisOfRecord: string[] = REAL_BASIS_OF_RECORD,
): Promise<RegionSpeciesCount[]> {
  return fetchSpeciesCountsForRegionParam(`geometry=${encodeURIComponent(wkt)}`, taxonKeys, yearsWindow, basisOfRecord);
}

async function fetchSpeciesCountsForRegionParam(
  regionParam: string,
  taxonKeys: number[],
  yearsWindow: number | null,
  basisOfRecord: string[] = REAL_BASIS_OF_RECORD,
): Promise<RegionSpeciesCount[]> {
  const results: RegionSpeciesCount[] = [];
  let offset = 0;
  const pageSize = 5000;
  const currentYear = new Date().getFullYear();
  const yearParam = yearsWindow != null ? `&year=${currentYear - yearsWindow},${currentYear}` : "";
  const basisOfRecordParams = basisOfRecordParamsFor(basisOfRecord);

  for (;;) {
    const url =
      `${GBIF_OCCURRENCE_API}?${regionParam}${yearParam}` +
      `&${taxonKeyParams(taxonKeys)}&${basisOfRecordParams}&occurrenceStatus=PRESENT&facet=speciesKey` +
      `&facetLimit=${pageSize}&facetOffset=${offset}&limit=0`;
    const res = await fetchWithRetry(url, {});
    if (!res.ok) {
      throw new Error(`[gbif-occ] fetch failed: ${res.status} ${res.statusText} (${url})`);
    }
    const data = (await res.json()) as FacetResponse;
    const facet = data.facets.find((f) => f.field === "SPECIES_KEY");
    if (!facet || facet.counts.length === 0) break;

    for (const c of facet.counts) {
      results.push({ gbifKey: Number(c.name), recordCount: c.count });
    }
    if (facet.counts.length < pageSize) break;
    offset += pageSize;
  }

  return results;
}

// A type specimen (holotype etc.) can sit far from the species' modern range, and fish have no
// record-count guard, so one type specimen alone could add a species. GBIF's `typeStatus`
// filter matches verbatim dataset strings rather than its vocabulary, so this samples records
// and reads the field directly instead of filtering server-side.
const MIN_TYPE_SPECIMEN_SAMPLES_TO_JUDGE = 1;

export function looksTypeSpecimenOnly(records: OccurrenceLocalitySample[]): boolean {
  if (records.length < MIN_TYPE_SPECIMEN_SAMPLES_TO_JUDGE) return false;
  return records.every((r) => !!r.typeStatus);
}

// Recurrence rescue: a species that turns up across several different years, with no single
// year dominating, is a real resident rather than a vagrant burst. The all-time floor sits
// above the distinct-years minimum so sporadic escapee sightings don't pass. Thresholds lean
// towards inclusion: a false "not here" can't be second-guessed by the user, a false "here" can.
export const RECURRENCE_ALLTIME_FLOOR = 6;
export const RECURRENCE_MIN_DISTINCT_YEARS = 2;
export const RECURRENCE_MAX_YEAR_CONCENTRATION = 0.65;

// Pattern alone has no sense of magnitude, so a species also needs a total above a fraction
// of its region's median species total (same taxon class). A fixed count wouldn't work:
// under-recorded regions have far fewer records for real residents.
export const RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN = 0.03;

// Low-detectability residents (nocturnal, irruptive) record far fewer observations than common
// species. A species seen across many distinct years with low concentration has already shown
// it recurs, so it bypasses the volume floor. Set well above RECURRENCE_MIN_DISTINCT_YEARS so a
// short one-off invasion can't reach it.
export const RECURRENCE_STRONG_PATTERN_MIN_YEARS = 10;

export function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export async function fetchYearCountsForSpecies(
  externalCode: string,
  gbifKey: number,
  landOnly = false,
): Promise<Array<{ year: number; count: number }>> {
  const regionParam = await gbifRegionParam(externalCode, landOnly);
  const url =
    `${GBIF_OCCURRENCE_API}?${regionParam}&speciesKey=${gbifKey}&${basisOfRecordParams}` +
    `&occurrenceStatus=PRESENT&facet=year&facetLimit=200&limit=0`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) {
    throw new Error(`[gbif-occ] fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const data = (await res.json()) as {
    facets: Array<{ field: string; counts: Array<{ name: string; count: number }> }>;
  };
  const facet = data.facets.find((f) => f.field === "YEAR");
  return (facet?.counts ?? []).map((c) => ({ year: Number(c.name), count: c.count }));
}

// minTotalRecords defaults to 0 (pattern-only check) when no region baseline is available.
export function passesRecurrenceCheck(
  yearCounts: Array<{ year: number; count: number }>,
  minTotalRecords = 0,
): boolean {
  const total = yearCounts.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return false;
  const distinctYears = yearCounts.length;
  const maxShare = Math.max(...yearCounts.map((c) => c.count)) / total;
  if (maxShare > RECURRENCE_MAX_YEAR_CONCENTRATION) return false;
  if (distinctYears >= RECURRENCE_STRONG_PATTERN_MIN_YEARS) return true;
  return total >= minTotalRecords && distinctYears >= RECURRENCE_MIN_DISTINCT_YEARS;
}

// The recurrence check can't tell a sparse wild resident from a species known only from
// zoos and wildlife centres across different years. GBIF's `locality` usually names the
// institution, so a keyword match is a usable signal. It only runs on species already under
// recurrence consideration, so the cost is bounded.
const CAPTIVE_LOCALITY_PATTERN =
  /\b(zoo|aviary|wildlife (centre|center)|animal sanctuary|aquarium|botanical garden|arboretum|menagerie|game farm|conservatory)\b/i;

export interface OccurrenceLocalitySample {
  locality: string | null;
  typeStatus: string | null;
  // [longitude, latitude], same order as geometry.ts. Null when GBIF has no coordinate.
  point: [number, number] | null;
}

async function fetchRecordSampleForParam(
  regionParam: string,
  gbifKey: number,
  basisOfRecord: string[] = REAL_BASIS_OF_RECORD,
): Promise<OccurrenceLocalitySample[]> {
  const url = `${GBIF_OCCURRENCE_API}?${regionParam}&speciesKey=${gbifKey}&${basisOfRecordParamsFor(basisOfRecord)}&occurrenceStatus=PRESENT&limit=20`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) {
    throw new Error(`[gbif-occ] fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const data = (await res.json()) as {
    results: Array<{ locality?: string; typeStatus?: string; decimalLongitude?: number; decimalLatitude?: number }>;
  };
  return data.results.map((r) => ({
    locality: r.locality ?? null,
    typeStatus: r.typeStatus ?? null,
    point: r.decimalLongitude != null && r.decimalLatitude != null ? [r.decimalLongitude, r.decimalLatitude] : null,
  }));
}

export async function fetchRecordSampleForSpecies(
  externalCode: string,
  gbifKey: number,
  landOnly = false,
): Promise<OccurrenceLocalitySample[]> {
  return fetchRecordSampleForParam(await gbifRegionParam(externalCode, landOnly), gbifKey);
}

export async function fetchRecordSampleForZone(wkt: string, gbifKey: number): Promise<OccurrenceLocalitySample[]> {
  return fetchRecordSampleForParam(`geometry=${encodeURIComponent(wkt)}`, gbifKey, SEA_ZONE_BASIS_OF_RECORD);
}

// Only judges when enough records have a locality string; most iNaturalist records have none.
// Catches zoo and museum records, not free-roaming escapees, which have no textual signal.
const MIN_LOCALITY_SAMPLES_TO_JUDGE = 3;
// A plain majority is enough: captive records often lack a matched keyword, and a wild species
// almost never has even one record naming a zoo as its locality.
const CAPTIVE_SHARE_THRESHOLD = 0.5;

export function looksCaptiveOnly(records: OccurrenceLocalitySample[]): boolean {
  const withLocality = records.filter((r) => r.locality);
  if (withLocality.length < MIN_LOCALITY_SAMPLES_TO_JUDGE) return false;
  const captiveCount = withLocality.filter((r) => CAPTIVE_LOCALITY_PATTERN.test(r.locality!)).length;
  return captiveCount / withLocality.length >= CAPTIVE_SHARE_THRESHOLD;
}

// A well-documented species with only a handful of local records and nearly all its records
// elsewhere is likely a misidentification. Type-specimen and captive checks don't catch this.
export const GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS = 5;
// A species with few records anywhere is just under-documented, not suspicious.
const GEOGRAPHIC_OUTLIER_MIN_GLOBAL_RECORDS = 50;
// The local share must be tiny: a real edge-of-range population can be a small fraction.
const GEOGRAPHIC_OUTLIER_MAX_LOCAL_SHARE = 0.02;

export function looksLikeGeographicOutlier(localRecordCount: number, globalRecordCount: number): boolean {
  if (localRecordCount > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS) return false;
  if (globalRecordCount < GEOGRAPHIC_OUTLIER_MIN_GLOBAL_RECORDS) return false;
  return localRecordCount / globalRecordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_SHARE;
}

/** Global occurrence count for a species, used only by looksLikeGeographicOutlier on the
 *  already-small set of low-count candidates. */
export async function fetchGlobalOccurrenceCount(gbifKey: number): Promise<number> {
  const url = `${GBIF_OCCURRENCE_API}?taxonKey=${gbifKey}&${basisOfRecordParams}&occurrenceStatus=PRESENT&limit=0`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) {
    throw new Error(`[gbif-occ] fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const data = (await res.json()) as { count: number };
  return data.count;
}

interface LandRing {
  bbox: BoundingBox;
  ring: Point[];
}

// Every country's landmass, loaded once per process. Each ring's bbox is precomputed as a cheap
// prefilter before the expensive ray-cast.
let allCountryLandRingsPromise: Promise<LandRing[]> | null = null;
function allCountryLandRings(): Promise<LandRing[]> {
  if (!allCountryLandRingsPromise) {
    allCountryLandRingsPromise = fetchAllCountries().then((countries) =>
      countries
        .flatMap((c) => exteriorRingsFromGeometry(c.feature.geometry as { type: string; coordinates: unknown }))
        .map((ring) => ({ bbox: ringBoundingBox(ring), ring })),
    );
  }
  return allCountryLandRingsPromise;
}

function isPointInBbox([x, y]: Point, bbox: BoundingBox): boolean {
  return x >= bbox.minLon && x <= bbox.maxLon && y >= bbox.minLat && y <= bbox.maxLat;
}

// Sea zone polygons are simplified and can extend inland, pulling in non-marine records. This
// checks whether a record's coordinate is on real land, independent of any zone's shape.
// Containment alone is too strict (coastal resorts sit on land), so it uses distance from the
// coastline: INLAND_BUFFER_DEGREES (~33km) is well beyond any coastal town's distance to shore.
const MIN_LAND_SAMPLES_TO_JUDGE = 2;
const INLAND_SHARE_THRESHOLD = 0.5;
const INLAND_BUFFER_DEGREES = 0.3;

async function pointIsDeepInland(point: Point): Promise<boolean> {
  const landRings = await allCountryLandRings();
  const candidateRings = landRings.filter((lr) => isPointInBbox(point, lr.bbox));
  return candidateRings.some(
    (lr) => pointInRing(point, lr.ring) && minRingDistance([[point]], [lr.ring]) >= INLAND_BUFFER_DEGREES,
  );
}

export async function looksLikeInlandRecords(records: OccurrenceLocalitySample[]): Promise<boolean> {
  const withPoint = records.filter((r) => r.point);
  if (withPoint.length < MIN_LAND_SAMPLES_TO_JUDGE) return false;
  let inlandCount = 0;
  for (const r of withPoint) {
    if (await pointIsDeepInland(r.point!)) inlandCount++;
  }
  return inlandCount / withPoint.length >= INLAND_SHARE_THRESHOLD;
}

/** For test/dev runs: a direct occurrence count for one species, cheaper than faceting over the whole region. */
export async function fetchOccurrenceCountForSpecies(gbifKey: number, externalCode: string): Promise<number> {
  const regionParam = await gbifRegionParam(externalCode);
  const url =
    `${GBIF_OCCURRENCE_API}?${regionParam}` +
    `&taxonKey=${gbifKey}&${basisOfRecordParams}&occurrenceStatus=PRESENT&limit=0`;
  const res = await fetchWithRetry(url, {});
  if (!res.ok) {
    throw new Error(`[gbif-occ] fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const data = (await res.json()) as { count: number };
  return data.count;
}

/**
 * Monthly seasonality per species for one region. GBIF only facets by month, not week, so this
 * uses 12 monthly bins: 12 per-species facet requests, one per month.
 */
export async function fetchMonthlySeasonality(
  externalCode: string,
  taxonKeys: number[] = [AVES_CLASS_KEY],
  yearsWindow: number | null = RECENT_YEARS_WINDOW,
  landOnly = false,
): Promise<Map<number, number[]>> {
  const bySpecies = new Map<number, number[]>();
  const currentYear = new Date().getFullYear();
  const yearParam = yearsWindow != null ? `&year=${currentYear - yearsWindow},${currentYear}` : "";
  const regionParam = await gbifRegionParam(externalCode, landOnly);

  for (let month = 1; month <= 12; month++) {
    let offset = 0;
    const pageSize = 5000;
    for (;;) {
      const url =
        `${GBIF_OCCURRENCE_API}?${regionParam}&month=${month}${yearParam}` +
        `&${taxonKeyParams(taxonKeys)}&${basisOfRecordParams}&occurrenceStatus=PRESENT&facet=speciesKey` +
        `&facetLimit=${pageSize}&facetOffset=${offset}&limit=0`;
      const res = await fetchWithRetry(url, {});
      if (!res.ok) {
        throw new Error(`[gbif-occ] seasonality fetch failed: ${res.status} ${res.statusText} (${url})`);
      }
      const data = (await res.json()) as FacetResponse;
      const facet = data.facets.find((f) => f.field === "SPECIES_KEY");
      if (!facet || facet.counts.length === 0) break;

      for (const c of facet.counts) {
        const gbifKey = Number(c.name);
        const arr = bySpecies.get(gbifKey) ?? new Array(12).fill(0);
        arr[month - 1] = c.count;
        bySpecies.set(gbifKey, arr);
      }
      if (facet.counts.length < pageSize) break;
      offset += pageSize;
    }
  }

  return bySpecies;
}

/**
 * Per-species record counts by year, for passesRecurrenceCheck. One facet=speciesKey call per
 * year in the window rather than one call per species, so the cost per region stays small and
 * fixed. Uses the same window as the checklist's recency filter.
 */
export async function fetchYearlyRecordCounts(
  externalCode: string,
  taxonKeys: number[],
  yearsWindow: number = RECENT_YEARS_WINDOW,
  landOnly = false,
): Promise<Map<number, Array<{ year: number; count: number }>>> {
  const bySpecies = new Map<number, Array<{ year: number; count: number }>>();
  const currentYear = new Date().getFullYear();
  const regionParam = await gbifRegionParam(externalCode, landOnly);

  for (let year = currentYear - yearsWindow; year <= currentYear; year++) {
    let offset = 0;
    const pageSize = 5000;
    for (;;) {
      const url =
        `${GBIF_OCCURRENCE_API}?${regionParam}&year=${year}` +
        `&${taxonKeyParams(taxonKeys)}&${basisOfRecordParams}&occurrenceStatus=PRESENT&facet=speciesKey` +
        `&facetLimit=${pageSize}&facetOffset=${offset}&limit=0`;
      const res = await fetchWithRetry(url, {});
      if (!res.ok) {
        throw new Error(`[gbif-occ] yearly-count fetch failed: ${res.status} ${res.statusText} (${url})`);
      }
      const data = (await res.json()) as FacetResponse;
      const facet = data.facets.find((f) => f.field === "SPECIES_KEY");
      if (!facet || facet.counts.length === 0) break;

      for (const c of facet.counts) {
        const gbifKey = Number(c.name);
        const arr = bySpecies.get(gbifKey) ?? [];
        arr.push({ year, count: c.count });
        bySpecies.set(gbifKey, arr);
      }
      if (facet.counts.length < pageSize) break;
      offset += pageSize;
    }
  }

  return bySpecies;
}
