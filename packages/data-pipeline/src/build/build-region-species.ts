// Builds region_species rows for BC from GBIF occurrence data (lifer-spec.md §6, §7 MVP shortcut).
// Uses GBIF's occurrence/search faceting (facet=speciesKey, limit=0) to get a per-species
// record count in one call instead of paging through millions of individual occurrence records.
// A minimum-record threshold filters out one-off vagrants/museum specimens per spec's
// open question §10.1 — this is exactly the "too noisy?" question the spec flags as needing
// a real-data spike, so MIN_RECORDS is deliberately visible and easy to tune once we see counts.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BUILD_DIR } from "../raw-cache.js";
import { fetchWithRetry } from "../fetch-with-retry.js";
import { fetchAllCountries } from "../fetch/fetch-region-boundary.js";
import { pointInRing, minRingDistance, exteriorRingsFromGeometry, ringBoundingBox, type Point, type BoundingBox } from "../geometry.js";

const GBIF_OCCURRENCE_API = "https://api.gbif.org/v1/occurrence/search";
// Aves' one class key, kept as the default so every existing call site (apps/api's lazy
// region-occurrence computation, compute-elusiveness.ts) keeps working unchanged. Phase 8's
// other taxa pass their own: Mammalia has one class key too; fish has ~46 order keys (see
// fetch-fish-orders.ts) — `taxonKey` matches a taxon AND every rank of descendant, and
// repeating it ORs (verified against GBIF's own counts), which is what makes a
// single query work for either shape.
export const AVES_CLASS_KEY = 212;
// Raised from 3 (never tuned against real data before now) — a burst within the recency
// window above is still possible, so this is a second, complementary guard, not a
// replacement for the year-range fix.
export const MIN_RECORDS = 10;

// Fish (and anything else with much lower citizen-science reporting volume than birds)
// need their own, far more permissive bar. For Red Sea fish, birds' MIN_RECORDS=10 + 15-year
// window together threw away ~73% of real species (1,351 real GBIF species down to 372),
// because a genuinely-present reef fish realistically gets far fewer diver/observer reports
// than a bird ever would, not because it's rare. Fish therefore keep only the basisOfRecord
// real-observation filter (still guards against the eDNA-contamination class of problem, e.g.
// the Bonobo-in-BC case below — that's a data-quality issue independent of record count) — no
// minimum record count, no recency window, so a species documented even once stays on the
// list. This recovers 1,351 species for the Red Sea, right in the literature's cited range.
export const FISH_MIN_RECORDS = 1;
export const FISH_YEARS_WINDOW: number | null = null;

function taxonKeyParams(taxonKeys: number[]): string {
  return taxonKeys.map((k) => `taxonKey=${k}`).join("&");
}

// Excludes eDNA/bulk-sample records (basisOfRecord=MATERIAL_SAMPLE, MATERIAL_CITATION,
// FOSSIL_SPECIMEN). A Bonobo showing up in a British Columbia checklist was traced to a
// single eDNA metabarcoding dataset (12S environmental-DNA sampling for an endangered fish
// survey); reference-database misassignment/contamination in bulk molecular sampling can
// attribute a read to a biologically impossible species, and GBIF has no per-record
// confidence score to filter on instead. Restricting to real observation/specimen bases
// (repeating basisOfRecord ORs, same mechanic as taxonKey) drops that kind of record to zero
// while leaving genuine cattle/goat/sheep observations untouched (84 real Bos taurus records
// in Canada survive the filter).
export const REAL_BASIS_OF_RECORD = ["HUMAN_OBSERVATION", "OBSERVATION", "PRESERVED_SPECIMEN", "MACHINE_OBSERVATION", "LIVING_SPECIMEN"];

// A real, disclosed problem specific to the ELUSIVENESS crawl: Black Bear, Coyote, and
// American Bison were all scoring far harder to detect than they should. REAL_BASIS_OF_RECORD
// above is deliberately broad because it answers "is this species really
// present here at all" for checklist-building, where a museum specimen or camera-trap capture
// IS legitimate evidence of presence. But that same breadth pollutes elusiveness, which is
// trying to answer a different question — "how easy is this for an ordinary photographer to
// encounter" — since camera-trap research programs and museum collection effort are driven by
// conservation/research interest, not by how visible a species is to a casual observer.
// Mammals in particular get heavily camera-trapped and specimen-collected precisely BECAUSE
// they're hard to see any other way, which perversely made genuinely elusive species look
// well-documented. Restricted to the two bases that represent an actual person casually
// reporting a sighting (eBird-style checklists included).
export const CASUAL_OBSERVATION_BASIS_OF_RECORD = ["HUMAN_OBSERVATION", "OBSERVATION"];

function basisOfRecordParamsFor(basisOfRecord: string[]): string {
  return basisOfRecord.map((b) => `basisOfRecord=${b}`).join("&");
}

// Every caller EXCEPT the elusiveness-relevant fetchSpeciesCountsForRegion/Zone above still
// wants the broad "is this species really present" definition — checklist building,
// seasonality, and the vagrancy/captive-only checks below all care whether a species occurs
// here at all, not how easy it is to casually spot.
const basisOfRecordParams = basisOfRecordParamsFor(REAL_BASIS_OF_RECORD);

// Country-level regions store a bare ISO3 code ("EGY"); province-level regions store a
// dotted GADM gid ("CAN.2_1", no ISO-alpha-2 equivalent exists for a sub-national unit).
// For the country case, GBIF's own `country` field (ISO-alpha-2) is used INSTEAD of
// `gadmGid`, because this matters a lot: GADM's land administrative polygon for
// a country barely covers its territorial waters, so marine/coastal species get
// systematically undercounted through gadmGid (Egypt: gadmGid=EGY's fish facet has 964
// distinct species vs country=EG's 1,707 — a 77% gap, and 1,707 is what actually matches
// real Red Sea species estimates). Provinces keep using gadmGid — a real, disclosed gap at
// the sub-national level with no cheap fix (no ISO-alpha-2-equivalent code for provinces).
let iso3ToIso2Promise: Promise<Map<string, string>> | null = null;
function iso3ToIso2Map(): Promise<Map<string, string>> {
  if (!iso3ToIso2Promise) {
    iso3ToIso2Promise = fetchAllCountries().then(
      // Natural Earth's ISO_A2 isn't always a real ISO 3166-1 alpha-2 code: "-99" is its
      // sentinel for "no code" (disputed territories/dependencies), and disputed cases like
      // Taiwan get a non-standard compound value ("CN-TW") instead — both cases get
      // rejected with a 400 by GBIF's `country` param, which only accepts a real 2-letter code. A
      // strict regex catches both failure shapes without hand-listing every disputed case.
      (countries) => new Map(countries.filter((c) => c.iso2 && /^[A-Z]{2}$/.test(c.iso2)).map((c) => [c.iso3, c.iso2!])),
    );
  }
  return iso3ToIso2Promise;
}

// landOnly forces the land administrative polygon (gadmGid) even for a country-level code
// that could use the broader `country` field, because a country's
// DEFAULT fish list should be its native land/freshwater species (Egypt's Nile fish, not
// Red Sea reef fish it doesn't actually border on land) — `country` was the right fix for
// undercounting marine species, but that's now handled properly via sea zones' own real
// polygons (see fetch-marine-zones.ts), so fish's default query no longer needs or wants the
// broader field. Birds/mammals are unaffected (still default to `country` — see
// gbifRegionParam's own default and the caller in regions/routes.ts).
async function gbifRegionParam(externalCode: string, landOnly = false): Promise<string> {
  // A province with no real GADM gid on hand (see compute-all-regions.ts's drill-down —
  // Natural Earth only gives an ISO 3166-2 code like "TH-70", which GBIF's gadmGid param
  // doesn't recognize at all, silently matching zero records) stores its own boundary as a
  // WKT polygon directly in external_codes instead of a code. Recognized here before either
  // lookup path below, so every caller (fetchSpeciesCountsForRegion, fetchMonthlySeasonality,
  // etc.) gets correct results with no change needed on their end.
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
// A real case that illustrates why this window is needed: Anhinga shows 143 all-time GBIF
// records in Canada, but 133 of them are from the single year 2000 — one vagrant individual
// generating a burst of observer reports, not a real population. This is exactly the
// citizen-science effort-bias problem spec §10.1 flags ("without eBird's effort data this is
// weaker than ideal"), and a raw MIN_RECORDS threshold can't catch it (143 clears any
// reasonable bar). The real fix — counting DISTINCT YEARS per species — needs a per-year
// facet loop (like fetchMonthlySeasonality's per-month one) that's too expensive to run live
// for every region view (100+ years of history × every country). Restricting to a recent
// window is the cheap version of the same idea: it doesn't fix a fresh one-time mega-vagrant
// event within the window, but it stops old bursts from inflating a region's checklist
// forever, at zero extra request cost (same single query, one more param).
export const RECENT_YEARS_WINDOW = 15;

export async function fetchSpeciesCountsForRegion(
  externalCode: string,
  taxonKeys: number[] = [AVES_CLASS_KEY],
  yearsWindow: number | null = RECENT_YEARS_WINDOW,
  landOnly = false,
  basisOfRecord: string[] = REAL_BASIS_OF_RECORD,
): Promise<RegionSpeciesCount[]> {
  return fetchSpeciesCountsForRegionParam(await gbifRegionParam(externalCode, landOnly), taxonKeys, yearsWindow, basisOfRecord);
}

// Sea zones (see fetch-marine-zones.ts) query by the zone's own real polygon shape via
// GBIF's `geometry` WKT param, instead of a country/gadmGid code — same faceting mechanism,
// just a different way of telling GBIF "where." basisOfRecord filter still applies (the
// eDNA-contamination problem is independent of location); yearsWindow defaults to null
// (no filter) since every current caller is fish-only (see FISH_YEARS_WINDOW).
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

// A species' nomenclatural type specimen (Holotype, Lectotype, etc. — the physical specimen
// a name was originally described from) can sit in a museum anywhere, often nowhere near the
// species' actual modern range: e.g. Acipenser carbonarius (the Adriatic Sturgeon) showed up
// in Canada's checklist purely because its 1850 holotype was collected in Lake Superior —
// the SAME specimen's own identificationRemarks field already notes it's since been
// reidentified as Acipenser fulvescens (Lake Sturgeon, a real Canadian species), but the
// occurrence record itself still carries the original 175-year-old species-level tag. Fish
// have no MIN_RECORDS/year-window guard against this (see FISH_MIN_RECORDS's own comment on
// why), so a single type specimen alone is enough to add a species that was never actually
// found where its type happened to be collected.
//
// GBIF's occurrence search `typeStatus` filter matches the exact verbatim string a dataset
// used ("Holotype" here — confirmed by hand; `typeStatus=HOLOTYPE`, the vocabulary's own
// canonical spelling, matched zero records for this exact case) rather than normalizing to
// its controlled vocabulary, so filtering server-side by value is unreliable across
// datasets. This instead samples actual records (same pattern as looksCaptiveOnly's locality
// check below) and reads the field directly.
const MIN_TYPE_SPECIMEN_SAMPLES_TO_JUDGE = 1;

export function looksTypeSpecimenOnly(records: OccurrenceLocalitySample[]): boolean {
  if (records.length < MIN_TYPE_SPECIMEN_SAMPLES_TO_JUDGE) return false;
  return records.every((r) => !!r.typeStatus);
}

// Recurrence rescue: the recent-window MIN_RECORDS threshold treats a
// genuinely-present-but-rarely-recorded resident (Northern Goshawk in BC: 8 records in 15
// years, 411 all-time, spread over 102 different years) exactly like a one-off vagrant burst
// (Anhinga in Canada: 143 records, but 133 from a single year — one excited flurry of
// reports, not a population). The real distinguishing signal, checked against both of those
// cases plus Whooping Crane (present in Saskatchewan, absent from Nova Scotia): does this
// species turn up across several DIFFERENT years, with no single year dominating its
// all-time total? That's recurring presence; a single-year spike, however large, isn't.
// Was 3 — exactly RECURRENCE_MIN_DISTINCT_YEARS, i.e. the loosest possible pass ("one record
// in each of 3 different years") carried no real evidence beyond the distinct-years check
// itself. That let sporadic escaped-game-bird sightings slip onto checklists where they don't
// belong: Chukar (Alectoris chukar, genuinely established/countable in BC and the western US)
// and Swan Goose (Anser cygnoides) both showed up in New Brunswick off exactly 3 all-time
// records, one per year, from perfectly ordinary-looking locality text (a residential street,
// a train station) — neither eBird's own review nor iNaturalist's "captive" flag catches this
// class of case (checked both against the real GBIF/iNaturalist records: no establishmentMeans
// data, and iNaturalist's captive flag is false since the bird genuinely wasn't in a cage when
// spotted, it just isn't part of a real local population). Raising the floor to noticeably more
// than the distinct-years minimum requires more than "once per qualifying year" before treating
// scattered sightings as a real population — Northern Goshawk's 411 all-time records clear this
// by two orders of magnitude, unaffected.
export const RECURRENCE_ALLTIME_FLOOR = 8;
export const RECURRENCE_MIN_DISTINCT_YEARS = 3;
export const RECURRENCE_MAX_YEAR_CONCENTRATION = 0.5;

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
  const data = (await res.json()) as { facets: Array<{ field: string; counts: Array<{ name: string; count: number }> }> };
  const facet = data.facets.find((f) => f.field === "YEAR");
  return (facet?.counts ?? []).map((c) => ({ year: Number(c.name), count: c.count }));
}

export function passesRecurrenceCheck(yearCounts: Array<{ year: number; count: number }>): boolean {
  const total = yearCounts.reduce((sum, c) => sum + c.count, 0);
  if (total === 0) return false;
  const distinctYears = yearCounts.length;
  const maxShare = Math.max(...yearCounts.map((c) => c.count)) / total;
  return distinctYears >= RECURRENCE_MIN_DISTINCT_YEARS && maxShare <= RECURRENCE_MAX_YEAR_CONCENTRATION;
}

// Swinhoe's Pheasant, a Taiwan endemic, was found "present" in Canada, revealing that the
// recurrence check above can't tell a genuine sparse wild resident from a
// species whose only records are captive specimens at zoos/wildlife centres, spread across
// different years and different institutions (looks exactly like real recurring presence by
// year-spread alone — Swinhoe's Pheasant's 5 Canadian records span 1962-2017 across Calgary
// Zoo, Hancock Wildlife Centre, and two other named facilities, no single year dominant).
// GBIF's `locality` field reliably names the institution for these ("Calgary; Calgary Zoo"),
// so a small text match against common captive-facility keywords is a real, checkable
// signal — this only runs against the small set of species ALREADY being specially
// considered by the recurrence rescue, not the whole checklist, so the added cost is bounded.
const CAPTIVE_LOCALITY_PATTERN =
  /\b(zoo|aviary|wildlife (centre|center)|animal sanctuary|aquarium|botanical garden|arboretum|menagerie|game farm|conservatory)\b/i;

export interface OccurrenceLocalitySample {
  locality: string | null;
  typeStatus: string | null;
  // [longitude, latitude], same order geometry.ts's Point/WKT helpers use — null when GBIF
  // has no coordinate for this particular record (common for older museum-specimen data).
  point: [number, number] | null;
}

async function fetchRecordSampleForParam(regionParam: string, gbifKey: number): Promise<OccurrenceLocalitySample[]> {
  const url = `${GBIF_OCCURRENCE_API}?${regionParam}&speciesKey=${gbifKey}&${basisOfRecordParams}&occurrenceStatus=PRESENT&limit=20`;
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

export async function fetchRecordSampleForSpecies(externalCode: string, gbifKey: number, landOnly = false): Promise<OccurrenceLocalitySample[]> {
  return fetchRecordSampleForParam(await gbifRegionParam(externalCode, landOnly), gbifKey);
}

export async function fetchRecordSampleForZone(wkt: string, gbifKey: number): Promise<OccurrenceLocalitySample[]> {
  return fetchRecordSampleForParam(`geometry=${encodeURIComponent(wkt)}`, gbifKey);
}

// Only rejects when there's actually enough evidence to judge — most iNaturalist-sourced
// records have no locality string at all (Budgerigar's real outdoor
// sightings mostly come back `locality: null`), so a sample with too few locality strings to
// judge is left alone rather than falsely excluded for lack of data. This deliberately only
// catches the zoo/museum-specimen failure mode (Swinhoe's Pheasant), not a genuine
// free-roaming escapee like Budgerigar, which has no equivalent textual signal — a known,
// separate, unfixed gap.
const MIN_LOCALITY_SAMPLES_TO_JUDGE = 3;
// A plain majority, not a supermajority — this needs to be this lenient:
// Swinhoe's Pheasant's 5 Canadian records only match the keyword pattern on 3 of them
// ("Hancock Wildlife Centre" x2, "Calgary Zoo"); the other 2 ("Peachland; 6328 Forest Hill
// Drive", "Crystal Gardens, Victoria") are almost certainly also private/former captive
// collections but don't happen to contain a matched keyword. A wild species essentially
// never has even ONE record naming a zoo/wildlife centre as its locality, so requiring only
// "more than half" is still a low-false-positive bar, not a loose one.
const CAPTIVE_SHARE_THRESHOLD = 0.5;

export function looksCaptiveOnly(records: OccurrenceLocalitySample[]): boolean {
  const withLocality = records.filter((r) => r.locality);
  if (withLocality.length < MIN_LOCALITY_SAMPLES_TO_JUDGE) return false;
  const captiveCount = withLocality.filter((r) => CAPTIVE_LOCALITY_PATTERN.test(r.locality!)).length;
  return captiveCount / withLocality.length >= CAPTIVE_SHARE_THRESHOLD;
}

// A species whose real range is entirely elsewhere can still slip a handful of records into
// an unrelated region/zone — confirmed on Amphiprion akindynos (Barrier Reef Anemonefish, a
// Great Barrier Reef/New Caledonia endemic): 2,622 real global records, ALL in
// Australia/New Caledonia, yet 3 showed up in the Northern and Central Red Sea sea zone,
// traced to a single low-reliability citizen-science submission (Questagame, gamified/
// self-identified) — almost certainly a misidentification of the real native Red Sea
// Anemonefish (Amphiprion bicinctus). Neither looksTypeSpecimenOnly nor looksCaptiveOnly
// catches this: no type-specimen flag, no zoo/museum locality keyword, just a plain wrong ID
// on an otherwise-ordinary-looking photo. The signal that DOES catch it is the imbalance
// itself — a real, well-documented species showing up almost nowhere near where the rest of
// its own record set lives is inherently suspicious, checkable with one extra global-count
// query, independent of what the local records' text says.
export const GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS = 5;
// Needs a real, well-documented global population to compare against — a species with only
// a handful of records anywhere isn't "suspiciously concentrated elsewhere," it's just
// generally under-documented, which is a different (and not inherently suspect) situation.
const GEOGRAPHIC_OUTLIER_MIN_GLOBAL_RECORDS = 50;
// The local records must be a tiny sliver of the global total, not just "fewer than
// elsewhere" — a genuinely-present vagrant/edge-of-range population can legitimately be a
// small fraction of a species' global count without being a misidentification.
const GEOGRAPHIC_OUTLIER_MAX_LOCAL_SHARE = 0.02;

export function looksLikeGeographicOutlier(localRecordCount: number, globalRecordCount: number): boolean {
  if (localRecordCount > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS) return false;
  if (globalRecordCount < GEOGRAPHIC_OUTLIER_MIN_GLOBAL_RECORDS) return false;
  return localRecordCount / globalRecordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_SHARE;
}

/** Global occurrence count for a species — no region/zone scoping — used only by
 *  looksLikeGeographicOutlier's comparison, and only for the already-small set of low local-
 *  count candidates the type-specimen/captive checks already sample, so the added cost is
 *  bounded the same way theirs is. */
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

// Every country's real landmass, loaded once (fetchAllCountries() is itself cached — see its
// own comment) and reused across every sea-zone candidate check in a process run, rather than
// re-fetched per species. Natural Earth's 10m-resolution coastlines carry thousands of points
// per ring, so each ring's own bbox is precomputed here too — a cheap rectangle check first,
// same "loose prefilter, then the real (expensive) check" shape this file already uses for
// zone adjacency (see bboxesNear's own comment), rather than running the full ray-cast against
// every one of ~250 countries' rings for every sampled point.
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

// A sea zone's own stored polygon is a simplified shape (Marine Ecoregions of the World data,
// not a precise coastline) — confirmed wrong on Aphanius sirhani (Azraq toothcarp, endemic to
// one desert oasis 150+ miles from the Mediterranean) and the Yarışlı Killifish (endemic to a
// single lake in Turkey): both showed up in the Levantine Sea / Egypt's nearby-water data
// because the zone's simplified boundary apparently extends inland far enough to swallow real,
// but entirely non-marine, records. This checks the thing that should NEVER be true for a
// genuine marine species regardless of which sea zone's polygon claims it: does the record's
// own coordinate resolve onto real land at all, independent of any particular zone's shape.
// General on purpose — reuses the same Natural Earth country polygons already loaded
// elsewhere in this pipeline, so it works for any sea zone anywhere, not just the ones a
// specific bad case happened to surface.
//
// Plain "is this point on land at all" is too aggressive, though — confirmed by hand: a real
// Red Sea reef-fish record geotagged at a Sharm El Sheikh dive resort (right at the shoreline,
// a completely normal way for a real marine observation to get coordinates) also resolves
// "on land," since the resort itself sits on the beach. The real distinguishing signal is
// DISTANCE from the coastline, not containment alone — Azraq is 150+ miles inland, a beach
// resort is a few hundred meters from the water at most. INLAND_BUFFER_DEGREES (~33km) is
// chosen well beyond any ordinary coastal town/resort's distance from the true shoreline.
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
 * Monthly seasonality per species for one region. The spec calls for a "52-week sparkline",
 * but GBIF's occurrence API only facets by month, with no week-of-year facet to get real
 * weekly granularity from, so this uses 12 monthly bins instead.
 * 12 requests total (one per month), each a full per-species facet over that month — far
 * cheaper than looping per-species, and reuses the exact faceting technique already proven
 * out in fetchSpeciesCountsForRegion above.
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
 * Per-species record counts broken down by year, for the "is this an established resident or
 * a one-off vagrant burst" check (passesRecurrenceCheck) — same batching trick as
 * fetchMonthlySeasonality just above: one facet=speciesKey call PER YEAR in the window, not one
 * live call PER SPECIES. Bounded to yearsWindow (defaults to RECENT_YEARS_WINDOW, the same
 * window a species already had to clear on record count to make the checklist at all — judging
 * recency-of-distribution against the same window used for recency-of-presence is more
 * consistent than the old per-species call's ALL-TIME lookback, not less correct: RECENT_YEARS_
 * WINDOW exists specifically so an old burst can't inflate a checklist forever, and the same
 * reasoning applies to whether a burst still reads as one within THAT window). This turns what
 * used to be one live GBIF call per already-included bird/mammal species — hundreds, for a
 * well-recorded region, and the actual cause of region computation taking a very long time
 * under GBIF's live rate limits — into a fixed, small number of calls per region regardless of
 * how many species are on the checklist.
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

async function main() {
  const regionsPath = path.join(BUILD_DIR, "regions.json");
  const regions = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(regionsPath, "utf-8")));

  const output: Record<string, RegionSpeciesCount[]> = {};
  for (const region of regions) {
    if ((region.externalCodes as string[]).length === 0) continue;
    for (const code of region.externalCodes as string[]) {
      console.log(`[region-species] querying GBIF for ${code}`);
      const counts = await fetchSpeciesCountsForRegion(code);
      const filtered = counts.filter((c) => c.recordCount >= MIN_RECORDS);
      output[region.name] = filtered;
      console.log(
        `[region-species] ${region.name}: ${filtered.length} species ` +
          `(${counts.length - filtered.length} dropped below ${MIN_RECORDS}-record threshold)`,
      );
    }
  }

  mkdirSync(BUILD_DIR, { recursive: true });
  const dest = path.join(BUILD_DIR, "region-species-bc.json");
  writeFileSync(dest, JSON.stringify(output, null, 2));
  console.log(`[region-species] wrote ${dest}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
