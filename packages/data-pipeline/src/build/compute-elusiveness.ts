// Phase 4: the elusiveness axis — "how hard is it to detect where it
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
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fetchAllCountries, type CountryEntry } from "../fetch/fetch-region-boundary.js";
import {
  fetchSpeciesCountsForRegion,
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  RECENT_YEARS_WINDOW,
  REAL_BASIS_OF_RECORD,
} from "./build-region-species.js";
import { AVES_CLASS_KEY } from "../fetch/fetch-gbif-backbone.js";
import { BUILD_DIR } from "../raw-cache.js";
import { exteriorRingsFromGeometry, minRingDistance, simplifyRingToMaxPoints, pointInAnyRing } from "../geometry.js";
import { pool } from "../db.js";

// The same per-country GBIF SQL Download zips compute-provinces-bulk.ts already downloads for
// the pack-building pipeline (species/lat/lon/class/year/basisofrecord/record_count, scoped by
// countrycode=). Reused here to skip a live GBIF facet call entirely for whichever countries
// are already cached (229/258 at last count) — this crawl only ever needs the SAME per-species
// record counts already sitting on disk, just aggregated slightly differently (by class name
// instead of by GBIF taxonKey — see COUNT_CLASSES_BY_GROUP below). The cached zip's own download
// was scoped by the broader `countrycode` field, not fish's narrower land-only `gadmGid` field —
// but every cached row has real coordinates, so fish additionally get a real point-in-polygon
// check against the country's own land shape (see countSpeciesFromLocalZip's `landRings` param)
// to reconstruct that same narrower scope locally instead of falling back to a live call.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GBIF_COUNTRY_CACHE_DIR = path.join(__dirname, "..", "..", "data", "gbif-country-cache");

// Mirrors compute-provinces-bulk.ts's own FISH_CLASSES/BIRD_MAMMAL_CLASSES constants — the
// cached zip's own `class` column is a GBIF class NAME (e.g. "Aves"), not a taxonKey, so a
// taxon group is matched against this cache by name instead of by its taxonKeys array.
const COUNT_CLASSES_BY_GROUP: Record<"birds" | "mammals" | "fish", Set<string>> = {
  birds: new Set(["Aves"]),
  mammals: new Set(["Mammalia"]),
  fish: new Set(["Myxini", "Petromyzonti", "Elasmobranchii", "Holocephali", "Coelacanthi", "Dipneusti", "Actinopterygii", "Teleostei", "Chondrostei", "Cladistii", "Holostei"]),
};

// Returns null (meaning "no cache, fall back to a live fetch") only when the zip itself doesn't
// exist — an existing zip that happens to have zero matching rows for this group correctly
// returns an empty (non-null) map instead of falling back, since a real "this country really
// has none of this taxon" answer and "we don't know" are different outcomes.
export interface LocalZipSpeciesCount {
  recordCount: number;
  // This country's own bounding-box diagonal (km) for JUST this species' records — lets the
  // core-country pick below use geographic CONCENTRATION rather than raw record count (see
  // computeVagrantCountries' own comment for why raw count alone is the wrong signal here).
  bboxDiagonalKm: number;
}

async function countSpeciesFromLocalZip(
  iso2: string,
  classes: Set<string>,
  minRecords: number,
  yearsWindow: number | null,
  basisOfRecord: string[],
  // Set only for fish (see FISH_CLASSES/landOnly's own comment on gbifRegionParam): the cached
  // zip's own download was scoped by the broader `countrycode` field, not the land-only
  // `gadmGid` field fish actually need — reusing it for fish without this would silently widen
  // their country presence to include coastal/marine incidental records the land-only scoping
  // exists specifically to exclude. Every cached row already has real, non-null coordinates
  // (guaranteed by the original download query), so a real point-in-polygon test against the
  // country's own land shape reconstructs the same distinction locally instead of needing a
  // live gadmGid-scoped GBIF call.
  landRings?: Point[][],
): Promise<Map<string, LocalZipSpeciesCount> | null> {
  const zipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  if (!existsSync(zipPath)) return null;

  const currentYear = new Date().getFullYear();
  const yearCutoff = yearsWindow != null ? currentYear - yearsWindow : null;
  const basisSet = new Set(basisOfRecord);
  const bySpecies = new Map<string, { recordCount: number; minLat: number; maxLat: number; minLon: number; maxLon: number }>();

  const unzipProc = spawn("unzip", ["-p", zipPath]);
  const rl = readline.createInterface({ input: unzipProc.stdout, crlfDelay: Infinity });
  let header: string[] | null = null;
  let colIndex: Record<string, number> = {};
  for await (const line of rl) {
    if (!line) continue;
    const cols = line.split("\t");
    if (!header) {
      header = cols;
      colIndex = Object.fromEntries(header.map((h, i) => [h, i]));
      continue;
    }
    const cls = cols[colIndex.class] ?? "";
    if (!classes.has(cls)) continue;
    const basisOfRecordValue = cols[colIndex.basisofrecord];
    if (!basisSet.has(basisOfRecordValue)) continue;
    if (yearCutoff != null) {
      const yearRaw = cols[colIndex.year];
      const year = yearRaw ? Number(yearRaw) : null;
      if (year == null || year < yearCutoff) continue;
    }
    const species = cols[colIndex.species];
    if (!species) continue;
    const recordCountRaw = cols[colIndex.record_count];
    const recordCount = recordCountRaw ? Number(recordCountRaw) : 1;
    const lat = Number(cols[colIndex.decimallatitude]);
    const lon = Number(cols[colIndex.decimallongitude]);
    if (landRings && !pointInAnyRing([lon, lat], landRings)) continue;

    let entry = bySpecies.get(species);
    if (!entry) {
      entry = { recordCount: 0, minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
      bySpecies.set(species, entry);
    }
    entry.recordCount += recordCount;
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      if (lat < entry.minLat) entry.minLat = lat;
      if (lat > entry.maxLat) entry.maxLat = lat;
      if (lon < entry.minLon) entry.minLon = lon;
      if (lon > entry.maxLon) entry.maxLon = lon;
    }
  }
  await new Promise((resolve) => unzipProc.on("close", resolve));

  const result = new Map<string, LocalZipSpeciesCount>();
  for (const [species, entry] of bySpecies) {
    if (entry.recordCount < minRecords) continue;
    const bboxDiagonalKm =
      Math.hypot((entry.maxLat - entry.minLat) * KM_PER_DEGREE, (entry.maxLon - entry.minLon) * KM_PER_DEGREE * Math.cos((entry.minLat * Math.PI) / 180)) ||
      0;
    result.set(species, { recordCount: entry.recordCount, bboxDiagonalKm });
  }
  return result;
}

// A country's real native range and a scattered escapee/introduced population (cage birds,
// aquarium releases, ...) look identical to a pure record-count/temporal-recurrence check —
// an established feral population can rack up sightings across many years just as a native
// one does. Real geography is the only signal that tells them apart: a species' TRUE range is
// never split across countries thousands of km apart with nothing in between.
//
// Deliberately NOT also requiring the candidate country to hold a small SHARE of total records
// (an earlier version of this check did, and it was wrong): a well-birded country's escapee
// population can genuinely out-record a real but remote wild population — confirmed live on
// Black-Cheeked Lovebird, wild only in Zambia (176 records, tightly clustered near its real
// range) but with MORE raw records from South African cage-bird escapees (387, scattered across
// nearly the whole country) than the real population itself. A share-based pre-filter would
// have excluded South Africa from ever being checked at all, since 387/(176+387) = 69% is far
// above any reasonable "small minority" threshold — exactly backwards, since that's the one
// that needed to be caught. Once coreScore has already identified the real core by CONCENTRATION
// (see its own comment), share size tells us nothing further; distance is the only signal that
// still discriminates a real secondary population from a scattered escapee one.
const VAGRANT_MIN_DISTANCE_KM = 500;
// This whole "one real core (by concentration), everything else past a distance threshold is
// suspect" model was built for and only makes sense on a genuinely narrow/restricted-range
// species — its original motivating case, Black-Cheeked Lovebird, is wild in exactly one
// country. Confirmed live that it actively produces garbage once applied indiscriminately to
// every species regardless of real range size: Mallard and Red Fox (both genuinely native across
// most of the Northern Hemisphere) ended up marked non-native in over a hundred real countries
// each, and cosmopolitan/long-distance migrants (Rock Pigeon, Barn Swallow, Osprey, Peregrine
// Falcon, many shorebirds) got 150-215 countries flagged — because SOME one country always
// scores highest on coreScore, even when the species has no single "core" at all and is just
// naturally spread across a huge real range. A species with real records in more than a small
// handful of countries is, by definition, not a narrow-endemic-with-escapees case — skip vagrant
// detection for it entirely rather than force a "one true home, everywhere else is fake" model
// onto a distribution that was never shaped like that to begin with.
const MAX_COUNTRIES_FOR_VAGRANT_CHECK = 15;
// A real second population (even a genuinely disjunct one, or just two countries whose nearest
// edges happen to be >500km apart) still has its own real concentration, not necessarily as
// tight as the core's but not radically worse either. Confirmed against the original motivating
// case, Black-Cheeked Lovebird: the real wild population (Zambia, concentration ≈0.435) scores
// noticeably higher than the scattered South African escapee population (≈0.279, about 64% of
// Zambia's) — this threshold sits between those two real numbers, catching the confirmed escapee
// case while giving the benefit of the doubt to a candidate whose own concentration is close to
// the core's, since that's what a second real population actually looks like.
const MAX_CANDIDATE_CONCENTRATION_RATIO = 0.7;
// Confirmed live: Great Gray Owl and Northern Hawk Owl, both genuinely native holarctic
// residents (breeding across the boreal forest in Canada AND across northern Eurasia), got
// their whole Canadian population flagged as an escapee/introduced population by the
// concentration check above. The root problem: coreScore (records per km of bbox spread)
// mechanically penalizes a real, CONTINUOUSLY occupied range just for living in a physically
// huge country — the exact same real population, at the exact same density, produces a much
// worse concentration score in Canada (bbox spread over thousands of km of real boreal
// forest) than the identical population would in a small, densely-birded country like
// Finland. That's a property of the country's SIZE, not of whether the population is real.
// A candidate whose own record spread already approaches its home country's own maximum
// possible extent has nowhere further to "concentrate" — it isn't underperforming a fair
// bar, the bar itself was never reachable for a country this large. Calibrated against real
// Natural Earth country geometry: this cleanly separates the confirmed-escapee case's own
// country (South Africa, ~3,650km own-diagonal) from the countries a real holarctic/wide-
// ranging resident needs this exemption for (Canada ~10,800km, Australia ~7,200km, China
// ~8,000km, Brazil ~6,600km) — small enough that South Africa, Kazakhstan (~4,800km), and
// Mongolia (~3,760km) still go through the normal check unexempted.
const CANDIDATE_LARGE_COUNTRY_EXEMPT_KM = 6000;

function ringsBboxDiagonalKm(rings: Point[][]): number | null {
  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLon = Infinity;
  let maxLon = -Infinity;
  for (const ring of rings) {
    for (const [lon, lat] of ring) {
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
    }
  }
  if (!Number.isFinite(minLat) || !Number.isFinite(minLon)) return null;
  const latSpanKm = (maxLat - minLat) * KM_PER_DEGREE;
  const lonSpanKm = (maxLon - minLon) * KM_PER_DEGREE;
  return Math.hypot(latSpanKm, lonSpanKm);
}
// Same simplification fetch-marine-zones.ts/geometry.ts's own WKT builder use — full Natural
// Earth ring resolution would make minRingDistance's pairwise point comparison (below) far
// more expensive than this proximity check needs to be accurate to within a few km.
const DISTANCE_CHECK_MAX_RING_POINTS = 80;
const KM_PER_DEGREE = 111;

function simplifiedRingsFor(feature: CountryEntry["feature"] | undefined): Point[][] {
  if (!feature?.geometry) return [];
  const geometry = feature.geometry as { type: string; coordinates: unknown };
  return exteriorRingsFromGeometry(geometry).map((ring) => simplifyRingToMaxPoints(ring, DISTANCE_CHECK_MAX_RING_POINTS));
}

type Point = [number, number];

// A well-birded country's escaped/introduced population can rack up MORE raw records than a
// real, remote wild population ever will — confirmed live on Black-Cheeked Lovebird: South
// Africa's 390 records span a 1,386km-wide scatter across the whole country (independent
// escapee sightings near many different cities), while Zambia's 180 records — its real,
// known wild range — cluster inside a 405km box. Raw count alone would pick South Africa as
// the "core" and get the whole endemic determination backwards. Records-per-km-of-spread
// (concentration) is what actually distinguishes a real population from scattered escapees, so
// the core pick below prefers concentration wherever bbox data is available (only ever true
// for a local-cache hit — see LocalZipSpeciesCount), falling back to raw count for a
// live-fetched country (no per-record coordinates to compute a spread from at all).
const MIN_CONCENTRATION_BBOX_KM = 10;

function coreScore(recordCount: number, bboxDiagonalKm: number | undefined): number {
  if (bboxDiagonalKm != null) return recordCount / Math.max(bboxDiagonalKm, MIN_CONCENTRATION_BBOX_KM);
  return recordCount;
}

// For a given species' per-country record counts, decide which countries (if any) are almost
// certainly an escapee/introduced population rather than real native range: geographically
// distant from whichever country is the real core (see coreScore's own comment for how that's
// picked — NOT simply whichever has the most raw records). Country pair distances are cached
// (`distanceCacheKm`) since the same pair recurs across many species.
export function computeVagrantCountries(
  countryCounts: Map<string, number>,
  bboxKmByIso3: Map<string, number> | undefined,
  ringsByIso3: Map<string, Point[][]>,
  distanceCacheKm: Map<string, number>,
): Set<string> {
  if (countryCounts.size <= 1 || countryCounts.size > MAX_COUNTRIES_FOR_VAGRANT_CHECK) return new Set();
  const [coreIso3] = [...countryCounts.entries()].sort(
    (a, b) => coreScore(b[1], bboxKmByIso3?.get(b[0])) - coreScore(a[1], bboxKmByIso3?.get(a[0])),
  )[0];
  // An empty rings array (missing/malformed geometry) makes minRingDistance return Infinity,
  // which must NOT be read as "definitely far away, therefore vagrant" — it means the distance
  // genuinely can't be measured, so the honest answer is "don't flag," not "flag by default."
  // Real Natural Earth country geometry always has real rings; this guard only ever matters for
  // a country somehow missing geometry data (or a test double standing in for one).
  const coreRings = ringsByIso3.get(coreIso3);
  if (!coreRings || coreRings.length === 0) return new Set();

  const vagrant = new Set<string>();
  for (const [iso3] of countryCounts) {
    if (iso3 === coreIso3) continue;
    const otherRings = ringsByIso3.get(iso3);
    if (!otherRings || otherRings.length === 0) continue;

    const cacheKey = coreIso3 < iso3 ? `${coreIso3}|${iso3}` : `${iso3}|${coreIso3}`;
    let distanceKm = distanceCacheKm.get(cacheKey);
    if (distanceKm == null) {
      distanceKm = minRingDistance(coreRings, otherRings) * KM_PER_DEGREE;
      distanceCacheKm.set(cacheKey, distanceKm);
    }
        if (distanceKm <= VAGRANT_MIN_DISTANCE_KM) continue;

    // See CANDIDATE_LARGE_COUNTRY_EXEMPT_KM's own comment — a physically huge candidate
    // country never gets a fair concentration comparison against the core, so skip straight
    // to "don't flag" rather than penalize it for its own size.
    const candidateOwnDiagonalKm = ringsBboxDiagonalKm(otherRings);
    if (candidateOwnDiagonalKm != null && candidateOwnDiagonalKm >= CANDIDATE_LARGE_COUNTRY_EXEMPT_KM) continue;

    // Distance alone can't tell a real, disjunct native population apart from a scattered
    // escapee one — a species can genuinely have two separate real populations far apart (a
    // disjunct range, or just two adjacent-ish countries whose nearest edges still end up
    // >500km apart). Concentration is the same signal that picked the core in the first place
    // (see coreScore's own comment): a real population, wherever it is, is a real PLACE — it
    // still has its own reasonably concentrated area. Scattered escapees don't; they're spread
    // thin across a country's cities with no real concentration anywhere. Only flag when the
    // candidate's own concentration is meaningfully worse than the core's, not merely "not the
    // best" — a second real, similarly-concentrated population must never lose to whichever one
    // happened to score marginally higher. Requires bbox data for BOTH countries (only ever true
    // for a local-cache hit — see LocalZipSpeciesCount) — without it there's no way to check this
    // at all, and the honest answer to "can't verify" is "don't flag," not "flag by default."
    const coreBboxKm = bboxKmByIso3?.get(coreIso3);
    const otherBboxKm = bboxKmByIso3?.get(iso3);
    if (coreBboxKm == null || otherBboxKm == null) continue;
    const otherScore = coreScore(countryCounts.get(iso3)!, otherBboxKm);
    const thisCoreScore = coreScore(countryCounts.get(coreIso3)!, coreBboxKm);
    if (otherScore < thisCoreScore * MAX_CANDIDATE_CONCENTRATION_RATIO) vagrant.add(iso3);
  }
  return vagrant;
}

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
      vagrantCountriesByGbifKey: [...result.vagrantCountriesByGbifKey.entries()].map(([k, v]) => [k, [...v]] as [number, string[]]),
    }),
  );
}

export function loadCrawlCache(): ElusivenessResult | null {
  if (!existsSync(CRAWL_CACHE_PATH)) return null;
  const raw = JSON.parse(readFileSync(CRAWL_CACHE_PATH, "utf-8")) as {
    byGbifKey: Array<[number, number]>;
    endemicCountryIso3ByGbifKey: Array<[number, string]>;
    vagrantCountriesByGbifKey?: Array<[number, string[]]>;
  };
  return {
    byGbifKey: new Map(raw.byGbifKey),
    countriesUsed: 0,
    countriesDropped: 0,
    endemicCountryIso3ByGbifKey: new Map(raw.endemicCountryIso3ByGbifKey),
    vagrantCountriesByGbifKey: new Map((raw.vagrantCountriesByGbifKey ?? []).map(([k, v]) => [k, new Set(v)])),
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
  // Set only for groups queried with the broader `countrycode` field (landOnly not true) whose
  // GBIF class name(s) exactly match a key in COUNT_CLASSES_BY_GROUP — lets this group reuse
  // compute-provinces-bulk.ts's already-downloaded per-country zips instead of a live GBIF
  // facet call wherever one's cached. Left unset for fish (a genuinely different query scope,
  // see COUNT_CLASSES_BY_GROUP's own comment) and for the test file's synthetic groups.
  localCacheClasses?: Set<string>;
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
  // Countries flagged as an escapee/introduced population for that species (see
  // computeVagrantCountries) — already excluded from endemicCountryIso3ByGbifKey's own count,
  // but also needed downstream by compute-provinces-bulk.ts/regions routes so a region within
  // one of these countries gets is_vagrant=true regardless of its own temporal recurrence.
  vagrantCountriesByGbifKey: Map<number, Set<string>>;
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
  const ringsByIso3 = new Map(countries.map((c) => [c.iso3, simplifiedRingsFor(c.feature)]));
  const distanceCacheKm = new Map<string, number>();
  const weightedSum = new Map<number, number>();
  const weightSum = new Map<number, number>();
  const countryCountsByGbifKey = new Map<number, Map<string, number>>();
  const bboxKmByGbifKeyAndIso3 = new Map<number, Map<string, number>>();
  let countriesUsed = 0;
  let countriesDropped = 0;

  // Only needed to convert a local-cache read (keyed by scientific_name, since that's all the
  // cached zips carry) back into the gbifKey space everything else in this file works in — and
  // only fetched when at least one group actually opts into the local cache, so a caller with
  // none (the test file's synthetic groups) never pays for an unused DB round-trip.
  const gbifKeyByScientificName = new Map<string, number>();
  if (taxonGroups.some((g) => g.localCacheClasses)) {
    const gbifKeyRes = await pool.query<{ scientific_name: string; gbif_key: string }>(`SELECT scientific_name, gbif_key FROM species`);
    for (const r of gbifKeyRes.rows) gbifKeyByScientificName.set(r.scientific_name, Number(r.gbif_key));
  }
  let countriesServedFromLocalCache = 0;

  for (let i = 0; i < countries.length; i++) {
    const country = countries[i];
    let countryTotal = 0;
    let countryHasEnoughSpecies = false;

    for (const group of taxonGroups) {
      const localTotals =
        group.localCacheClasses && country.iso2
          ? await countSpeciesFromLocalZip(
              country.iso2,
              group.localCacheClasses,
              group.minRecords,
              group.yearsWindow,
              group.basisOfRecord ?? REAL_BASIS_OF_RECORD,
              group.landOnly ? ringsByIso3.get(country.iso3) : undefined,
            )
          : null;
      const counts =
        localTotals != null
          ? [...localTotals.entries()]
              .map(([name, v]) => ({ gbifKey: gbifKeyByScientificName.get(name), recordCount: v.recordCount, bboxDiagonalKm: v.bboxDiagonalKm }))
              .filter((c): c is { gbifKey: number; recordCount: number; bboxDiagonalKm: number } => c.gbifKey != null)
          : (await fetchSpeciesCountsForRegion(country.iso3, group.taxonKeys, group.yearsWindow, group.landOnly ?? false, group.basisOfRecord)).map(
              (c) => ({ ...c, bboxDiagonalKm: null }),
            );
      if (localTotals != null) countriesServedFromLocalCache++;
      const total = counts.reduce((sum, c) => sum + c.recordCount, 0);
      countryTotal += total;
      if (counts.length >= 2) countryHasEnoughSpecies = true;

      for (const c of counts) {
        if (c.recordCount < group.minRecords) continue;
        if (!countryCountsByGbifKey.has(c.gbifKey)) countryCountsByGbifKey.set(c.gbifKey, new Map());
        const byCountry = countryCountsByGbifKey.get(c.gbifKey)!;
        byCountry.set(country.iso3, (byCountry.get(country.iso3) ?? 0) + c.recordCount);
        // Only ever set from a local-cache hit (bboxDiagonalKm is null for a live-fetched
        // country, which has no per-record coordinates at all — see computeVagrantCountries'
        // own comment on how a missing entry here is handled).
        if (c.bboxDiagonalKm != null) {
          if (!bboxKmByGbifKeyAndIso3.has(c.gbifKey)) bboxKmByGbifKeyAndIso3.set(c.gbifKey, new Map());
          bboxKmByGbifKeyAndIso3.get(c.gbifKey)!.set(country.iso3, c.bboxDiagonalKm);
        }
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

  console.log(
    `[elusiveness] served ${countriesServedFromLocalCache} of ${countries.length * taxonGroups.filter((g) => g.localCacheClasses).length} cache-eligible country/group passes from local GBIF zips`,
  );

  const byGbifKey = new Map<number, number>();
  for (const [gbifKey, sum] of weightedSum) {
    byGbifKey.set(gbifKey, sum / weightSum.get(gbifKey)!);
  }

  const vagrantCountriesByGbifKey = new Map<number, Set<string>>();
  for (const [gbifKey, countryCounts] of countryCountsByGbifKey) {
    const vagrant = computeVagrantCountries(countryCounts, bboxKmByGbifKeyAndIso3.get(gbifKey), ringsByIso3, distanceCacheKm);
    if (vagrant.size > 0) vagrantCountriesByGbifKey.set(gbifKey, vagrant);
  }

  // "Endemic to exactly one country" only counts countries NOT flagged as an escapee/
  // introduced population above — otherwise a species with a real single-country native range
  // plus a handful of feral records elsewhere (Black-Cheeked Lovebird: wild in Zambia, feral
  // cage-bird records in South Africa/Spain) would never qualify as endemic at all, since the
  // raw country list always has 2+ entries.
  const endemicCountryIso3ByGbifKey = new Map<number, string>();
  for (const [gbifKey, countryCounts] of countryCountsByGbifKey) {
    const vagrant = vagrantCountriesByGbifKey.get(gbifKey);
    const realCountries = [...countryCounts.keys()].filter((iso3) => !vagrant?.has(iso3));
    if (realCountries.length === 1) endemicCountryIso3ByGbifKey.set(gbifKey, realCountries[0]);
  }

  return { byGbifKey, countriesUsed, countriesDropped, endemicCountryIso3ByGbifKey, vagrantCountriesByGbifKey };
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
    { taxonKeys: [AVES_CLASS_KEY], minRecords: MIN_RECORDS, yearsWindow: RECENT_YEARS_WINDOW, localCacheClasses: COUNT_CLASSES_BY_GROUP.birds },
    {
      taxonKeys: [MAMMALIA_CLASS_KEY],
      minRecords: MIN_RECORDS,
      yearsWindow: RECENT_YEARS_WINDOW,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.mammals,
    },
    {
      // landOnly:true still means a live-fetched country (no cached zip) uses the narrower
      // gadmGid field, same as before — but a cache hit reconstructs that same scope locally
      // via a real point-in-polygon check (see countSpeciesFromLocalZip's `landRings` param and
      // this file's own comment above GBIF_COUNTRY_CACHE_DIR).
      taxonKeys: fishKeys,
      minRecords: FISH_MIN_RECORDS,
      yearsWindow: FISH_YEARS_WINDOW,
      landOnly: true,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.fish,
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
  await applyElusiveness(result.byGbifKey, result.endemicCountryIso3ByGbifKey, result.vagrantCountriesByGbifKey);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
