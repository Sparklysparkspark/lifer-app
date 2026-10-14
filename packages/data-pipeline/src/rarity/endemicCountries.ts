// Which species live in exactly one country: species_traits.endemic_country_iso3, behind the
// endemic badges, trip endemic counts and species pages. A species is endemic when it clears its
// group's presence threshold in exactly one country, not counting countries where its records
// look like an escapee or introduced population (computeVagrantCountries).
//
// Per-country counts come from the GBIF country downloads compute-provinces-bulk.ts caches, or a
// live GBIF facet call for a country without one, and are kept per country under
// data/build/endemic-country-counts so a rerun only reads countries whose download changed.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { CountryEntry } from "@lifer/core/regions/regionBoundary.js";
import {
  exteriorRingsFromGeometry,
  minRingDistance,
  pointInAnyRing,
  simplifyRingToMaxPoints,
} from "@lifer/core/lib/geometry.js";
import { AVES_CLASS_KEY, MAMMALIA_CLASS_KEY } from "../gbif/backbone.js";
import { fetchFishTaxonKeys } from "../gbif/fishOrders.js";
import { gbifDownloadFor } from "../regions/gbifCountryCodes.js";
import type { CountryEstablishment } from "../gbif/distributions.js";
import {
  CASUAL_OBSERVATION_BASIS_OF_RECORD,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  fetchSpeciesCountsForRegion,
  MIN_RECORDS,
  REAL_BASIS_OF_RECORD,
  RECENT_YEARS_WINDOW,
} from "../regions/buildRegionSpecies.js";

const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "data");
const GBIF_COUNTRY_CACHE_DIR = path.join(DATA_DIR, "gbif-country-cache");
export const ENDEMIC_COUNTS_DIR = path.join(DATA_DIR, "build", "endemic-country-counts");

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
 * Results line up with `groups`. An existing file with no matching rows gives empty maps: "has
 * none" and "we don't know" are different answers. */
export async function countGroupsFromLocalZip(
  zipPath: string,
  groups: LocalZipGroupSpec[],
): Promise<Array<Map<string, LocalZipSpeciesCount>>> {
  const currentYear = new Date().getFullYear();
  const specs = groups.map((g) => ({
    ...g,
    yearCutoff: g.yearsWindow != null ? currentYear - g.yearsWindow : null,
    basisSet: new Set(g.basisOfRecord),
    bySpecies: new Map<
      string,
      { recordCount: number; minLat: number; maxLat: number; minLon: number; maxLon: number }
    >(),
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
        Math.hypot(
          (entry.maxLat - entry.minLat) * KM_PER_DEGREE,
          (entry.maxLon - entry.minLon) * KM_PER_DEGREE * Math.cos((entry.minLat * Math.PI) / 180),
        ) || 0;
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
// Escapees turn up in one or two countries far from each other. When at least this many flagged
// countries each border another flagged one, they're a native range recorded less than a
// well-birded core, so none is flagged.
const MIN_CONTIGUOUS_FLAGGED_FOR_RANGE = 3;
const NEIGHBOUR_MAX_DISTANCE_KM = 100;

function ringsBbox(rings: Point[][]) {
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
  return Number.isFinite(minLat) && Number.isFinite(minLon) ? { minLat, maxLat, minLon, maxLon } : null;
}

function ringsBboxDiagonalKm(rings: Point[][]): number | null {
  const box = ringsBbox(rings);
  if (!box) return null;
  const { minLat, maxLat, minLon, maxLon } = box;
  const latSpanKm = (maxLat - minLat) * KM_PER_DEGREE;
  const lonSpanKm = (maxLon - minLon) * KM_PER_DEGREE;
  return Math.hypot(latSpanKm, lonSpanKm);
}
// Simplified rings keep minRingDistance's pairwise comparison cheap; a few km of accuracy is enough.
const DISTANCE_CHECK_MAX_RING_POINTS = 80;
const KM_PER_DEGREE = 111;

export function simplifiedRingsFor(feature: CountryEntry["feature"] | undefined): Point[][] {
  if (!feature?.geometry) return [];
  const geometry = feature.geometry as { type: string; coordinates: unknown };
  return exteriorRingsFromGeometry(geometry).map((ring) =>
    simplifyRingToMaxPoints(ring, DISTANCE_CHECK_MAX_RING_POINTS),
  );
}

export type Point = [number, number];

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

  const distanceKm = (a: string, b: string): number => {
    const cacheKey = a < b ? `${a}|${b}` : `${b}|${a}`;
    let km = distanceCacheKm.get(cacheKey);
    if (km == null) {
      km = minRingDistance(ringsByIso3.get(a)!, ringsByIso3.get(b)!) * KM_PER_DEGREE;
      distanceCacheKm.set(cacheKey, km);
    }
    return km;
  };

  const vagrant = new Set<string>();
  for (const [iso3] of countryCounts) {
    if (iso3 === coreIso3) continue;
    const otherRings = ringsByIso3.get(iso3);
    if (!otherRings || otherRings.length === 0) continue;
    if (distanceKm(coreIso3, iso3) <= VAGRANT_MIN_DISTANCE_KM) continue;

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
  const flagged = [...vagrant];
  const contiguous = flagged.filter((a) =>
    flagged.some((b) => b !== a && distanceKm(a, b) <= NEIGHBOUR_MAX_DISTANCE_KM),
  );
  if (contiguous.length >= MIN_CONTIGUOUS_FLAGGED_FOR_RANGE) return new Set();
  return vagrant;
}

/** Several names can stand for one catalog species (a split species' halves, a renamed one):
 * their records add up, and the widest spread is kept. */
export function mergeByGbifKey<T extends { gbifKey: number; recordCount: number; bboxDiagonalKm: number }>(
  counts: T[],
): T[] {
  const merged = new Map<number, T>();
  for (const c of counts) {
    const prev = merged.get(c.gbifKey);
    merged.set(
      c.gbifKey,
      prev
        ? {
            ...prev,
            recordCount: prev.recordCount + c.recordCount,
            bboxDiagonalKm: Math.max(prev.bboxDiagonalKm, c.bboxDiagonalKm),
          }
        : c,
    );
  }
  return [...merged.values()];
}

export interface CountGroup {
  /** GBIF backbone keys for a live facet call, for a country with no cached download. */
  taxonKeys: number[];
  minRecords: number;
  yearsWindow: number | null;
  /** Fish: land and freshwater species only, sea zones are separate. */
  landOnly?: boolean;
  /** basisOfRecord values that count as a record. Defaults to REAL_BASIS_OF_RECORD. */
  basisOfRecord?: string[];
  /** The cached downloads' `class` names for this group. */
  classes: Set<string>;
}

/** One country's species counts per group: [scientific name from a cached download or GBIF key
 *  from a live call, records, bounding-box diagonal in km or null]. */
export type CountryGroupCounts = Array<Array<[string | number, number, number | null]>>;

interface CountryCountsFile {
  groupsKey: string;
  /** The cached download's "mtime:size" it was read from, or "live:<ISO date>". */
  source: string;
  groups: CountryGroupCounts;
}

// GBIF backbone class keys for live calls. GBIF lists reptiles as three classes; "Reptilia" is
// only a pro parte synonym there.
const SQUAMATA_CLASS_KEY = 11592253;
const TESTUDINES_CLASS_KEY = 11418114;
const CROCODYLIA_CLASS_KEY = 11493978;
const AMPHIBIA_CLASS_KEY = 131;

/** Birds, mammals, fish, reptiles and amphibians, each with its own presence threshold. Casual
 *  sightings only: museum, camera-trap and zoo records put species where people don't see them. */
export async function endemicCountGroups(): Promise<CountGroup[]> {
  const common = {
    minRecords: MIN_RECORDS,
    yearsWindow: RECENT_YEARS_WINDOW,
    basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
  };
  return [
    { ...common, taxonKeys: [AVES_CLASS_KEY], classes: new Set(["Aves"]) },
    { ...common, taxonKeys: [MAMMALIA_CLASS_KEY], classes: new Set(["Mammalia"]) },
    {
      taxonKeys: await fetchFishTaxonKeys(),
      minRecords: FISH_MIN_RECORDS,
      yearsWindow: FISH_YEARS_WINDOW,
      landOnly: true,
      basisOfRecord: CASUAL_OBSERVATION_BASIS_OF_RECORD,
      // Mirrors compute-provinces-bulk.ts's fish classes.
      classes: new Set([
        "Myxini",
        "Petromyzonti",
        "Elasmobranchii",
        "Holocephali",
        "Coelacanthi",
        "Dipneusti",
        "Actinopterygii",
        "Teleostei",
        "Chondrostei",
        "Cladistii",
        "Holostei",
      ]),
    },
    {
      ...common,
      taxonKeys: [SQUAMATA_CLASS_KEY, TESTUDINES_CLASS_KEY, CROCODYLIA_CLASS_KEY],
      // The cached downloads spell reptiles "Reptilia"; GBIF's backbone splits them into three classes.
      classes: new Set(["Reptilia", "Squamata", "Testudines", "Crocodylia"]),
    },
    { ...common, taxonKeys: [AMPHIBIA_CLASS_KEY], classes: new Set(["Amphibia"]) },
  ];
}

const groupsKeyOf = (groups: CountGroup[]) =>
  createHash("sha256")
    .update(JSON.stringify(groups.map((g) => ({ ...g, classes: [...g.classes].sort() }))))
    .digest("hex")
    .slice(0, 16);

/** Which cached download each country reads, or null for none. Natural Earth gives a few reefs
 *  and leased areas their sovereign's iso2 (Ashmore and Cartier Is. is "AU"), so they'd read the
 *  whole sovereign's download and every species there would look like it lives in two countries.
 *  A shared download belongs to the largest country using it; the rest read none. */
export function countryDownloads(countries: Pick<CountryEntry, "iso2" | "iso3" | "name" | "feature">[]) {
  const byZip = new Map<string, { iso3: string; sizeKm: number }[]>();
  for (const c of countries) {
    if (!c.iso2) continue;
    const zipName = gbifDownloadFor(c.name, c.iso2).zipName;
    const users = byZip.get(zipName) ?? [];
    users.push({ iso3: c.iso3, sizeKm: ringsBboxDiagonalKm(simplifiedRingsFor(c.feature)) ?? 0 });
    byZip.set(zipName, users);
  }
  const zipByIso3 = new Map<string, string | null>();
  for (const [zipName, users] of byZip) {
    const owner = users.reduce((a, b) => (b.sizeKm > a.sizeKm ? b : a));
    for (const u of users) zipByIso3.set(u.iso3, u === owner ? zipName : null);
  }
  return zipByIso3;
}

// An island territory's endemics are mostly reef fish just offshore, outside its land polygon.
const ISLAND_QUERY_PADDING_DEG = 0.5;

/** For a country that shares its sovereign's download: a box around it, padded to take in its
 *  reefs, to query GBIF by. Only for a remote island (Clipperton); a territory within reach of
 *  another country (Ashmore and Cartier, Baikonur) gets null, since GBIF files its records under
 *  that neighbour and a box would count the neighbour's species twice. */
export function islandQueryBox(rings: Point[][], others: Point[][][]): string | null {
  const box = ringsBbox(rings);
  if (!box) return null;
  const { minLat, maxLat, minLon, maxLon } = box;
  const pad = ISLAND_QUERY_PADDING_DEG;
  const inside: Point = rings[0][0];
  if (
    others.some(
      (o) =>
        o.length > 0 &&
        (pointInAnyRing(inside, o) || minRingDistance(rings, o) * KM_PER_DEGREE <= VAGRANT_MIN_DISTANCE_KM),
    )
  )
    return null;
  const [w, e, s, n] = [minLon - pad, maxLon + pad, minLat - pad, maxLat + pad];
  return `POLYGON((${w} ${s},${e} ${s},${e} ${n},${w} ${n},${w} ${s}))`;
}

/** One country's counts, from its per-country file when still current: its cached download is
 *  unchanged, or a live call is younger than liveMaxAgeDays. A country that shares its
 *  sovereign's download (zipName null, see countryDownloads) is queried live by islandBox, or
 *  has none without one. */
export async function countryGroupCounts(
  country: { iso3: string; zipName: string | null; sharesDownload?: boolean; islandBox?: string | null },
  groups: CountGroup[],
  opts: { landRings: Point[][]; liveMaxAgeDays: number; full?: boolean },
): Promise<{ counts: CountryGroupCounts; fresh: boolean }> {
  if (country.sharesDownload && !country.islandBox) return { counts: groups.map(() => []), fresh: false };
  const groupsKey = groupsKeyOf(groups);
  const file = path.join(ENDEMIC_COUNTS_DIR, `${country.iso3}.json`);
  const zipPath = country.zipName ? path.join(GBIF_COUNTRY_CACHE_DIR, `${country.zipName}.zip`) : null;
  const zipStat = zipPath && existsSync(zipPath) ? statSync(zipPath) : null;
  const zipSource = zipStat ? `${zipStat.mtimeMs}:${zipStat.size}` : null;

  if (!opts.full && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as CountryCountsFile;
    const liveAgeDays = cached.source.startsWith("live:")
      ? (Date.now() - Date.parse(cached.source.slice(5))) / 86_400_000
      : Infinity;
    if (cached.groupsKey === groupsKey && (zipSource ? cached.source === zipSource : liveAgeDays < opts.liveMaxAgeDays))
      return { counts: cached.groups, fresh: false };
  }

  let counts: CountryGroupCounts;
  if (zipPath && zipStat) {
    const byGroup = await countGroupsFromLocalZip(
      zipPath,
      groups.map((g) => ({
        classes: g.classes,
        minRecords: g.minRecords,
        yearsWindow: g.yearsWindow,
        basisOfRecord: g.basisOfRecord ?? REAL_BASIS_OF_RECORD,
        landRings: g.landOnly ? opts.landRings : undefined,
      })),
    );
    counts = byGroup.map((m) => [...m].map(([name, c]) => [name, c.recordCount, c.bboxDiagonalKm]));
  } else {
    counts = [];
    for (const g of groups) {
      const live = await fetchSpeciesCountsForRegion(
        country.islandBox ?? country.iso3,
        g.taxonKeys,
        g.yearsWindow,
        g.landOnly ?? false,
        g.basisOfRecord,
      );
      counts.push(live.map((c) => [c.gbifKey, c.recordCount, null]));
    }
  }
  mkdirSync(ENDEMIC_COUNTS_DIR, { recursive: true });
  const out: CountryCountsFile = { groupsKey, source: zipSource ?? `live:${new Date().toISOString()}`, groups: counts };
  writeFileSync(file, JSON.stringify(out));
  return { counts, fresh: true };
}

export interface CountryCountTotals {
  countryCountsByGbifKey: Map<number, Map<string, number>>;
  bboxKmByGbifKeyAndIso3: Map<number, Map<string, number>>;
}

export function emptyCountryCountTotals(): CountryCountTotals {
  return { countryCountsByGbifKey: new Map(), bboxKmByGbifKeyAndIso3: new Map() };
}

/** Folds one country's rows into the running totals: each species' records per country (over its
 *  group's threshold), keyed by GBIF key. Names from the downloads resolve through gbifKeyByName
 *  (catalog names and synonyms), and several names for one species add up. Folding country by
 *  country keeps memory flat; holding every country's rows at once doesn't fit in the heap. */
export function addCountryCounts(
  totals: CountryCountTotals,
  iso3: string,
  byGroup: CountryGroupCounts,
  groups: CountGroup[],
  gbifKeyByName: Map<string, number>,
): void {
  const { countryCountsByGbifKey, bboxKmByGbifKeyAndIso3 } = totals;
  byGroup.forEach((rows, gi) => {
    const named = mergeByGbifKey(
      rows
        .filter((r) => typeof r[0] === "string")
        .map(([name, recordCount, bbox]) => ({
          gbifKey: gbifKeyByName.get(name as string),
          recordCount,
          bboxDiagonalKm: bbox ?? 0,
        }))
        .filter((c): c is { gbifKey: number; recordCount: number; bboxDiagonalKm: number } => c.gbifKey != null),
    );
    const keyed = rows
      .filter((r) => typeof r[0] === "number")
      .map(([gbifKey, recordCount]) => ({
        gbifKey: gbifKey as number,
        recordCount,
        bboxDiagonalKm: null as number | null,
      }));
    for (const c of [...named, ...keyed]) {
      if (c.recordCount < groups[gi].minRecords) continue;
      if (!countryCountsByGbifKey.has(c.gbifKey)) countryCountsByGbifKey.set(c.gbifKey, new Map());
      const byCountry = countryCountsByGbifKey.get(c.gbifKey)!;
      byCountry.set(iso3, (byCountry.get(iso3) ?? 0) + c.recordCount);
      // Only from a cached download; a live call has no per-record coordinates.
      if (c.bboxDiagonalKm != null) {
        if (!bboxKmByGbifKeyAndIso3.has(c.gbifKey)) bboxKmByGbifKeyAndIso3.set(c.gbifKey, new Map());
        bboxKmByGbifKeyAndIso3.get(c.gbifKey)!.set(iso3, c.bboxDiagonalKm);
      }
    }
  });
}

/** addCountryCounts over several countries at once. */
export function aggregateCountryCounts(
  perCountry: Map<string, CountryGroupCounts>,
  groups: CountGroup[],
  gbifKeyByName: Map<string, number>,
): CountryCountTotals {
  const totals = emptyCountryCountTotals();
  for (const [iso3, byGroup] of perCountry) addCountryCounts(totals, iso3, byGroup, groups, gbifKeyByName);
  return totals;
}

/** The countries each species was introduced to (iso3), from GBIF's distribution records. A
 *  country counts by its own iso2 and the GBIF codes its download covers (Indian Ocean Ter. is
 *  "AU", "CX" and "CC"). One the records also call native is never counted introduced, since a
 *  species native to part of a country can be introduced elsewhere in it. */
export function introducedCountries(
  establishment: Map<number, CountryEstablishment>,
  countries: Array<Pick<CountryEntry, "iso2" | "iso3" | "name">>,
): Map<number, Set<string>> {
  const codesByIso3 = new Map(
    countries
      .filter((c) => c.iso2)
      .map((c) => [c.iso3, new Set([c.iso2!, ...gbifDownloadFor(c.name, c.iso2!).codes])] as const),
  );
  const out = new Map<number, Set<string>>();
  for (const [gbifKey, { native, introduced }] of establishment) {
    if (introduced.length === 0) continue;
    const iso3s = new Set<string>();
    for (const [iso3, codes] of codesByIso3) {
      if (native.some((c) => codes.has(c))) continue;
      if (introduced.some((c) => codes.has(c))) iso3s.add(iso3);
    }
    if (iso3s.size > 0) out.set(gbifKey, iso3s);
  }
  return out;
}

/** The one country each endemic species lives in. Vagrant countries don't count, so a
 *  single-country native with a few feral records elsewhere still qualifies. */
export function endemicCountries(
  countryCountsByGbifKey: Map<number, Map<string, number>>,
  bboxKmByGbifKeyAndIso3: Map<number, Map<string, number>>,
  countries: Array<Pick<CountryEntry, "iso3" | "feature">>,
  introducedByGbifKey: Map<number, Set<string>> = new Map(),
): Map<number, string> {
  const ringsByIso3 = new Map(countries.map((c) => [c.iso3, simplifiedRingsFor(c.feature)]));
  const distanceCacheKm = new Map<string, number>();
  const endemic = new Map<number, string>();
  for (const [gbifKey, allCounts] of countryCountsByGbifKey) {
    // Records from where a species was introduced don't count, except in its best-recorded
    // country: a register can list a species moved around inside its native country, and an
    // introduced population rarely out-records the native one.
    const introduced = introducedByGbifKey.get(gbifKey);
    const [mostRecorded] = [...allCounts].reduce((a, b) => (b[1] > a[1] ? b : a), ["", -1]);
    const countryCounts = introduced
      ? new Map([...allCounts].filter(([iso3]) => iso3 === mostRecorded || !introduced.has(iso3)))
      : allCounts;
    const vagrant = computeVagrantCountries(
      countryCounts,
      bboxKmByGbifKeyAndIso3.get(gbifKey),
      ringsByIso3,
      distanceCacheKm,
    );
    const realCountries = [...countryCounts.keys()].filter((iso3) => !vagrant.has(iso3));
    // With introduced countries left out, only the best-recorded one can be home: a smaller
    // leftover is usually another introduction the register misses, with the native range under
    // the threshold. Never endemic to a country it was introduced to.
    const filtered = countryCounts.size < allCounts.size;
    if (
      realCountries.length === 1 &&
      !introduced?.has(realCountries[0]) &&
      (!filtered || realCountries[0] === mostRecorded)
    )
      endemic.set(gbifKey, realCountries[0]);
  }
  return endemic;
}
