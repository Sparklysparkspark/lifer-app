// Phase 4: the elusiveness axis, "how hard is it to detect where it lives", computed from GBIF
// observation density with a minimum-sample threshold so an unsampled area doesn't read as rare.
//
// Uses per-country occurrence counts rather than an equal-area grid: far cheaper, but weaker
// for huge countries with varied habitat. Each species is ranked against the other species
// recorded in the same country (not as a share of the country total, which is tiny for
// almost everyone). The per-country ranks are then averaged into one global score.

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { fetchAllCountries, type CountryEntry } from "@lifer/core/regions/regionBoundary.js";
import {
  fetchSpeciesCountsForRegion,
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  RECENT_YEARS_WINDOW,
  REAL_BASIS_OF_RECORD,
} from "@lifer/core/regions/buildRegionSpecies.js";
import { AVES_CLASS_KEY } from "@lifer/core/gbif/backbone.js";
import { BUILD_DIR } from "@lifer/core/rawCache.js";
import { exteriorRingsFromGeometry, minRingDistance, simplifyRingToMaxPoints, pointInAnyRing } from "@lifer/core/lib/geometry.js";
import { pool } from "../db.js";

// Per-country GBIF download zips cached by compute-provinces-bulk.ts. Countries with a cached
// zip skip the live GBIF facet call. The zips are scoped by `countrycode`, so fish (which need
// the land-only scope) get a point-in-polygon check against the country's land shape instead.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GBIF_COUNTRY_CACHE_DIR = path.join(__dirname, "..", "..", "data", "gbif-country-cache");

// GBIF backbone class keys for countries with no cached download. GBIF lists reptiles as three
// classes; "Reptilia" is only a pro parte synonym there.
const SQUAMATA_CLASS_KEY = 11592253;
const TESTUDINES_CLASS_KEY = 11418114;
const CROCODYLIA_CLASS_KEY = 11493978;
const AMPHIBIA_CLASS_KEY = 131;

// Mirrors compute-provinces-bulk.ts's class constants. The cached zip's `class` column is a
// class name, not a taxonKey, so groups match the cache by name.
const COUNT_CLASSES_BY_GROUP: Record<"birds" | "mammals" | "fish" | "reptiles" | "amphibians", Set<string>> = {
  birds: new Set(["Aves"]),
  mammals: new Set(["Mammalia"]),
  // The cached downloads spell reptiles "Reptilia"; GBIF's backbone splits them into three classes.
  reptiles: new Set(["Reptilia", "Squamata", "Testudines", "Crocodylia"]),
  amphibians: new Set(["Amphibia"]),
  fish: new Set(["Myxini", "Petromyzonti", "Elasmobranchii", "Holocephali", "Coelacanthi", "Dipneusti", "Actinopterygii", "Teleostei", "Chondrostei", "Cladistii", "Holostei"]),
};

// countGroupsFromLocalZip returns null only when the zip doesn't exist. An existing zip with no
// matching rows returns an empty map: "has none" and "we don't know" are different answers.
export interface LocalZipSpeciesCount {
  recordCount: number;
  // Bounding-box diagonal (km) of this species' records in this country, used to pick the core
  // country by concentration rather than raw count (see computeVagrantCountries).
  bboxDiagonalKm: number;
}

export interface LocalZipGroupSpec {
  classes: Set<string>;
  minRecords: number;
  yearsWindow: number | null;
  basisOfRecord: string[];
  // Fish only: the cache is scoped by `countrycode`, so a point-in-polygon test against the land
  // shape reproduces the land-only scope fish need.
  landRings?: Point[][];
}

/** Species record counts for several taxon groups from one read of a country's cached file.
 * Results line up with `groups`; null when the country has no cached file. */
export async function countGroupsFromLocalZip(iso2: string, groups: LocalZipGroupSpec[]): Promise<Array<Map<string, LocalZipSpeciesCount>> | null> {
  const zipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  if (!existsSync(zipPath)) return null;
  const currentYear = new Date().getFullYear();
  const specs = groups.map((g) => ({
    ...g,
    yearCutoff: g.yearsWindow != null ? currentYear - g.yearsWindow : null,
    basisSet: new Set(g.basisOfRecord),
    bySpecies: new Map<string, { recordCount: number; minLat: number; maxLat: number; minLon: number; maxLon: number }>(),
  }));
  const anyClass = new Set(groups.flatMap((g) => [...g.classes]));

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
    if (!anyClass.has(cls)) continue;
    const species = cols[colIndex.species];
    if (!species) continue;
    const basis = cols[colIndex.basisofrecord];
    const yearRaw = cols[colIndex.year];
    const year = yearRaw ? Number(yearRaw) : null;
    const recordCountRaw = cols[colIndex.record_count];
    const recordCount = recordCountRaw ? Number(recordCountRaw) : 1;
    const lat = Number(cols[colIndex.decimallatitude]);
    const lon = Number(cols[colIndex.decimallongitude]);
    for (const g of specs) {
      if (!g.classes.has(cls) || !g.basisSet.has(basis)) continue;
      if (g.yearCutoff != null && (year == null || year < g.yearCutoff)) continue;
      if (g.landRings && !pointInAnyRing([lon, lat], g.landRings)) continue;
      let entry = g.bySpecies.get(species);
      if (!entry) {
        entry = { recordCount: 0, minLat: lat, maxLat: lat, minLon: lon, maxLon: lon };
        g.bySpecies.set(species, entry);
      }
      entry.recordCount += recordCount;
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        if (lat < entry.minLat) entry.minLat = lat;
        if (lat > entry.maxLat) entry.maxLat = lat;
        if (lon < entry.minLon) entry.minLon = lon;
        if (lon > entry.maxLon) entry.maxLon = lon;
      }
    }
  }
  await new Promise((resolve) => unzipProc.on("close", resolve));

  return specs.map((g) => {
    const result = new Map<string, LocalZipSpeciesCount>();
    for (const [species, entry] of g.bySpecies) {
      if (entry.recordCount < g.minRecords) continue;
      const bboxDiagonalKm =
        Math.hypot((entry.maxLat - entry.minLat) * KM_PER_DEGREE, (entry.maxLon - entry.minLon) * KM_PER_DEGREE * Math.cos((entry.minLat * Math.PI) / 180)) ||
        0;
      result.set(species, { recordCount: entry.recordCount, bboxDiagonalKm });
    }
    return result;
  });
}

// A native range and a scattered escapee population look alike to record-count and recurrence
// checks; geography tells them apart, since a true range isn't split across countries far apart.
// No share-of-records filter: an escapee population in a well-recorded country can out-record
// the real wild one. Once coreScore picks the core, distance is the discriminating signal.
const VAGRANT_MIN_DISTANCE_KM = 500;
// The "one core, distant countries are suspect" model only fits narrow-range species. Widespread
// natives and migrants would get flagged across most of their range, so species recorded in more
// than a handful of countries skip vagrant detection entirely.
const MAX_COUNTRIES_FOR_VAGRANT_CHECK = 15;
// A real second population still has its own concentration, close to the core's. Only a
// candidate markedly less concentrated than the core is flagged.
const MAX_CANDIDATE_CONCENTRATION_RATIO = 0.7;
// coreScore penalizes a continuously occupied range in a physically huge country, since its
// records spread over thousands of km. Candidates whose own country diagonal exceeds this are
// never flagged. Chosen to exempt Canada, Australia, China and Brazil while mid-sized countries
// (South Africa, Kazakhstan, Mongolia) still get the normal check.
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
// Simplified rings keep minRingDistance's pairwise comparison cheap; a few km of accuracy is enough.
const DISTANCE_CHECK_MAX_RING_POINTS = 80;
const KM_PER_DEGREE = 111;

function simplifiedRingsFor(feature: CountryEntry["feature"] | undefined): Point[][] {
  if (!feature?.geometry) return [];
  const geometry = feature.geometry as { type: string; coordinates: unknown };
  return exteriorRingsFromGeometry(geometry).map((ring) => simplifyRingToMaxPoints(ring, DISTANCE_CHECK_MAX_RING_POINTS));
}

type Point = [number, number];

// An escapee population in a well-recorded country can have more raw records than the real,
// remote wild one, so the core pick uses records per km of spread (concentration) when bbox
// data exists (local-cache hits only), and raw count otherwise.
const MIN_CONCENTRATION_BBOX_KM = 10;

function coreScore(recordCount: number, bboxDiagonalKm: number | undefined): number {
  if (bboxDiagonalKm != null) return recordCount / Math.max(bboxDiagonalKm, MIN_CONCENTRATION_BBOX_KM);
  return recordCount;
}

// For one species' per-country counts, returns the countries that are almost certainly an
// escapee or introduced population: far from the core country (see coreScore) and less
// concentrated. Country pair distances are cached since the same pairs recur across species.
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
  // Missing geometry makes minRingDistance return Infinity. That means "can't measure", so don't flag.
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

    // A physically huge candidate never gets a fair concentration comparison, so don't flag it.
    const candidateOwnDiagonalKm = ringsBboxDiagonalKm(otherRings);
    if (candidateOwnDiagonalKm != null && candidateOwnDiagonalKm >= CANDIDATE_LARGE_COUNTRY_EXEMPT_KM) continue;

    // Distance alone can't separate a real disjunct population from scattered escapees. A real
    // population is still concentrated somewhere; escapees are spread thin. Only flag when the
    // candidate is meaningfully less concentrated than the core. Needs bbox data for both
    // countries; without it, don't flag.
    const coreBboxKm = bboxKmByIso3?.get(coreIso3);
    const otherBboxKm = bboxKmByIso3?.get(iso3);
    if (coreBboxKm == null || otherBboxKm == null) continue;
    const otherScore = coreScore(countryCounts.get(iso3)!, otherBboxKm);
    const thisCoreScore = coreScore(countryCounts.get(coreIso3)!, coreBboxKm);
    if (otherScore < thisCoreScore * MAX_CANDIDATE_CONCENTRATION_RATIO) vagrant.add(iso3);
  }
  return vagrant;
}

// Caches the raw crawl so tuning apply-rarity-phase4.ts's weights can re-run applyElusiveness()
// in seconds without re-crawling GBIF. See reapply-elusiveness-from-cache.ts.
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

// Below this many total records, a country's per-species ranking is too noisy to trust.
const MIN_COUNTRY_RECORDS = 5000;

export interface TaxonGroup {
  taxonKeys: number[];
  minRecords: number;
  yearsWindow: number | null;
  // Fish default to the land polygon: a country's fish are its land and freshwater species, with
  // sea zones layered in separately, and elusiveness uses the same definition.
  landOnly?: boolean;
  // basisOfRecord values that count as a record for this axis. Defaults to REAL_BASIS_OF_RECORD.
  basisOfRecord?: string[];
  // GBIF class names that let this group reuse compute-provinces-bulk.ts's cached per-country zips
  // instead of a live facet call. Unset for test groups.
  localCacheClasses?: Set<string>;
}

export interface ElusivenessResult {
  byGbifKey: Map<number, number>;
  countriesUsed: number;
  countriesDropped: number;
  // Endemic = clears its group's presence threshold in exactly one country. Checked against every
  // country, including thin-data ones below MIN_COUNTRY_RECORDS, since an under-sampled country
  // can still be a real endemic's only home.
  endemicCountryIso3ByGbifKey: Map<number, string>;
  // Countries flagged as escapee/introduced for that species (see computeVagrantCountries).
  // Excluded from the endemic count and from the elusiveness average. Not written to
  // species_nonnative_countries: see apply-introduced-flags.ts.
  vagrantCountriesByGbifKey: Map<number, Set<string>>;
}

/** Several names can stand for one catalog species (a split species' halves, a renamed one):
 * their records add up, and the widest spread is kept. */
export function mergeByGbifKey<T extends { gbifKey: number; recordCount: number; bboxDiagonalKm: number }>(counts: T[]): T[] {
  const merged = new Map<number, T>();
  for (const c of counts) {
    const prev = merged.get(c.gbifKey);
    merged.set(
      c.gbifKey,
      prev ? { ...prev, recordCount: prev.recordCount + c.recordCount, bboxDiagonalKm: Math.max(prev.bboxDiagonalKm, c.bboxDiagonalKm) } : c,
    );
  }
  return [...merged.values()];
}

/** A species' elusiveness: its rank among the species recorded in each country, averaged over
 * the countries where it actually lives, weighted by its own records there. Vagrant countries
 * are left out so a few escapee records don't outweigh the native range; if every country
 * looks vagrant, all of them are used. */
export function elusivenessFromRanks(
  entries: Array<{ iso3: string; percentile: number; speciesRecords: number }>,
  vagrantCountries: Set<string> | undefined,
): number {
  const native = vagrantCountries ? entries.filter((e) => !vagrantCountries.has(e.iso3)) : entries;
  const used = native.length > 0 ? native : entries;
  let weighted = 0;
  let weights = 0;
  for (const e of used) {
    const w = Math.max(1, e.speciesRecords);
    weighted += e.percentile * w;
    weights += w;
  }
  return weights > 0 ? weighted / weights : 0.5;
}

export async function computeElusiveness(
  taxonGroups: TaxonGroup[] = [{ taxonKeys: [AVES_CLASS_KEY], minRecords: MIN_RECORDS, yearsWindow: RECENT_YEARS_WINDOW }],
  onProgress?: (done: number, total: number) => void,
): Promise<ElusivenessResult> {
  const countries = await fetchAllCountries();
  const ringsByIso3 = new Map(countries.map((c) => [c.iso3, simplifiedRingsFor(c.feature)]));
  const distanceCacheKm = new Map<string, number>();
  // Each species' ranks per country, kept until vagrant countries are known so those can be excluded.
  const rankEntriesByGbifKey = new Map<number, Array<{ iso3: string; percentile: number; speciesRecords: number }>>();
  const countryCountsByGbifKey = new Map<number, Map<string, number>>();
  const bboxKmByGbifKeyAndIso3 = new Map<number, Map<string, number>>();
  let countriesUsed = 0;
  let countriesDropped = 0;

  // Maps the cache's scientific names back to gbifKeys. Only fetched when a group uses the cache.
  const gbifKeyByScientificName = new Map<string, number>();
  if (taxonGroups.some((g) => g.localCacheClasses)) {
    // Synonyms too, so a renamed species' records (the GBIF data uses current names) still count.
    const gbifKeyRes = await pool.query<{ scientific_name: string; gbif_key: string }>(
      `SELECT scientific_name, gbif_key FROM species
       UNION ALL
       SELECT ss.synonym_name, s.gbif_key FROM species_synonyms ss JOIN species s ON s.id = ss.species_id`,
    );
    // Real names (listed first) win over a synonym spelled the same.
    for (const r of gbifKeyRes.rows) if (!gbifKeyByScientificName.has(r.scientific_name)) gbifKeyByScientificName.set(r.scientific_name, Number(r.gbif_key));
  }
  let countriesServedFromLocalCache = 0;

  for (let i = 0; i < countries.length; i++) {
    const country = countries[i];
    let countryTotal = 0;
    let countryHasEnoughSpecies = false;

    // Every cache-backed group from one read of this country's file.
    const cachedGroups = taxonGroups.filter((g) => g.localCacheClasses);
    const cachedTotals =
      country.iso2 && cachedGroups.length > 0
        ? await countGroupsFromLocalZip(
            country.iso2,
            cachedGroups.map((g) => ({
              classes: g.localCacheClasses!,
              minRecords: g.minRecords,
              yearsWindow: g.yearsWindow,
              basisOfRecord: g.basisOfRecord ?? REAL_BASIS_OF_RECORD,
              landRings: g.landOnly ? ringsByIso3.get(country.iso3) : undefined,
            })),
          )
        : null;

    for (const group of taxonGroups) {
      const localTotals = cachedTotals && group.localCacheClasses ? cachedTotals[cachedGroups.indexOf(group)] : null;
      const counts =
        localTotals != null
          ? mergeByGbifKey(
              [...localTotals.entries()]
                .map(([name, v]) => ({ gbifKey: gbifKeyByScientificName.get(name), recordCount: v.recordCount, bboxDiagonalKm: v.bboxDiagonalKm }))
                .filter((c): c is { gbifKey: number; recordCount: number; bboxDiagonalKm: number } => c.gbifKey != null),
            )
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
        // Only set for local-cache hits; live-fetched countries have no per-record coordinates.
        if (c.bboxDiagonalKm != null) {
          if (!bboxKmByGbifKeyAndIso3.has(c.gbifKey)) bboxKmByGbifKeyAndIso3.set(c.gbifKey, new Map());
          bboxKmByGbifKeyAndIso3.get(c.gbifKey)!.set(country.iso3, c.bboxDiagonalKm);
        }
      }

      if (total >= MIN_COUNTRY_RECORDS && counts.length >= 2) {
        const sorted = [...counts].sort((a, b) => b.recordCount - a.recordCount);
        const n = sorted.length;
        sorted.forEach((c, rank) => {
          // rank 0 = most-recorded species in this group and country (elusiveness 0); least-recorded = 1.
          const percentile = rank / (n - 1);
          if (!rankEntriesByGbifKey.has(c.gbifKey)) rankEntriesByGbifKey.set(c.gbifKey, []);
          rankEntriesByGbifKey.get(c.gbifKey)!.push({ iso3: country.iso3, percentile, speciesRecords: c.recordCount });
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

  const vagrantCountriesByGbifKey = new Map<number, Set<string>>();
  for (const [gbifKey, countryCounts] of countryCountsByGbifKey) {
    const vagrant = computeVagrantCountries(countryCounts, bboxKmByGbifKeyAndIso3.get(gbifKey), ringsByIso3, distanceCacheKm);
    if (vagrant.size > 0) vagrantCountriesByGbifKey.set(gbifKey, vagrant);
  }

  const byGbifKey = new Map<number, number>();
  for (const [gbifKey, entries] of rankEntriesByGbifKey) {
    byGbifKey.set(gbifKey, elusivenessFromRanks(entries, vagrantCountriesByGbifKey.get(gbifKey)));
  }

  // Endemic counts only non-vagrant countries, so a single-country native with a few feral
  // records elsewhere still qualifies.
  const endemicCountryIso3ByGbifKey = new Map<number, string>();
  for (const [gbifKey, countryCounts] of countryCountsByGbifKey) {
    const vagrant = vagrantCountriesByGbifKey.get(gbifKey);
    const realCountries = [...countryCounts.keys()].filter((iso3) => !vagrant?.has(iso3));
    if (realCountries.length === 1) endemicCountryIso3ByGbifKey.set(gbifKey, realCountries[0]);
  }

  return { byGbifKey, countriesUsed, countriesDropped, endemicCountryIso3ByGbifKey, vagrantCountriesByGbifKey };
}

async function main() {
  // One crawl covering every taxon group. Each group is fetched and ranked separately within a
  // country, since record volumes differ hugely between taxa, and carries its own
  // minRecords/yearsWindow (fish are far more permissive).
  const { MAMMALIA_CLASS_KEY } = await import("@lifer/core/gbif/backbone.js");
  const { fetchFishTaxonKeys } = await import("@lifer/core/gbif/fishOrders.js");
  const fishKeys = await fetchFishTaxonKeys();
  const { CASUAL_OBSERVATION_BASIS_OF_RECORD } = await import("@lifer/core/regions/buildRegionSpecies.js");
  // Every group counts casual sightings only (CASUAL_OBSERVATION_BASIS_OF_RECORD): museum,
  // camera-trap and zoo records inflate documentation for species that are hard to see.
  const taxonGroups: TaxonGroup[] = [
    {
      taxonKeys: [AVES_CLASS_KEY],
      minRecords: MIN_RECORDS,
      yearsWindow: RECENT_YEARS_WINDOW,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.birds,
    },
    {
      taxonKeys: [MAMMALIA_CLASS_KEY],
      minRecords: MIN_RECORDS,
      yearsWindow: RECENT_YEARS_WINDOW,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.mammals,
    },
    {
      // A live-fetched country uses gadmGid; a cache hit reproduces that scope via landRings.
      taxonKeys: fishKeys,
      minRecords: FISH_MIN_RECORDS,
      yearsWindow: FISH_YEARS_WINDOW,
      landOnly: true,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.fish,
    },
    // Reptiles and amphibians rank separately for the same reason: their record volumes differ.
    {
      taxonKeys: [SQUAMATA_CLASS_KEY, TESTUDINES_CLASS_KEY, CROCODYLIA_CLASS_KEY],
      minRecords: MIN_RECORDS,
      yearsWindow: RECENT_YEARS_WINDOW,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.reptiles,
    },
    {
      taxonKeys: [AMPHIBIA_CLASS_KEY],
      minRecords: MIN_RECORDS,
      yearsWindow: RECENT_YEARS_WINDOW,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      localCacheClasses: COUNT_CLASSES_BY_GROUP.amphibians,
    },
  ];
  console.log(
    `[elusiveness] crawling ${taxonGroups.length} taxon groups (birds, mammals, fish with ${taxonGroups[2].taxonKeys.length} keys, reptiles, amphibians)`,
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
