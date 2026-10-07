// Province/state-level checklists: for each country, submits a GBIF SQL download scoped to that
// country (with coordinates), point-in-polygon matches every occurrence against the country's
// province boundaries, and writes region_species per province.
//
// Requires GBIF_USER and GBIF_PWD env vars (GBIF SQL downloads need an authenticated account).
//
// Usage: npx tsx src/scripts/compute-provinces-bulk.ts [--countries=France,Germany] [--provinces=British Columbia] [--apply] [--refresh-gbif-cache] [--refresh-aggregate-cache]
// --refresh-aggregate-cache forces a fresh scan of the raw GBIF zip. Only needed after a
// country's set of provinces changes; scoring-only re-runs reuse the cache automatically.
import {
  createWriteStream,
  createReadStream,
  mkdtempSync,
  rmSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  statSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pool } from "@lifer/core/db.js";
import { NO_RARITY_TIER_TAXON_CLASSES, type TaxonClass } from "@lifer/shared";
import { fetchAllCountries } from "@lifer/core/regions/regionBoundary.js";
import {
  exteriorRingsFromGeometry,
  ringBoundingBox,
  bboxDiagonalDegrees,
  pointInAnyRing,
  bboxesNear,
  type Point,
  type BoundingBox,
} from "@lifer/core/lib/geometry.js";
import {
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  RECENT_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN,
  passesRecurrenceCheck,
  medianOf,
} from "@lifer/core/regions/buildRegionSpecies.js";
import {
  percentileRankScores,
  tierForScore,
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_ABSOLUTE_TIER_THRESHOLDS,
  FISH_ABSOLUTE_TIER_THRESHOLDS,
} from "@lifer/core/species/computeRarityPhase1.js";
import { drillDownAllCountries } from "./compute-all-regions.js";
import {
  resolveInatPlaceId,
  fetchInatResearchGradeTaxonIds,
  matchedSpeciesIdsForRegion,
  resolveRemovalRescues,
} from "@lifer/core/regions/inatChecklist.js";
import {
  EBIRD_SENSITIVE_SPECIES,
  weekInSeason,
  sensitiveRegionMatches,
  SENSITIVE_CLUSTER_DIAGONAL_KM,
} from "@lifer/core/species/sensitiveSpecies.js";

// Countries processed first, in order, before everyone else.
const PRIORITY_COUNTRIES = [
  "France",
  "Germany",
  "United Kingdom",
  "Belgium",
  "Netherlands",
  "Switzerland",
  "Austria",
  "Italy",
  "Spain",
  "Luxembourg",
  "Denmark",
  "Ireland",
  "Poland",
  "Czechia",
  "Brazil",
  "Colombia",
  "Kenya",
  "South Africa",
  "India",
  "Japan",
  "Australia",
  "New Zealand",
];

const FISH_VAGRANT_MIN_RECORDS = 3;
const FISH_CLASSES = new Set([
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
]);
const BIRD_MAMMAL_CLASSES = new Set(["Aves", "Mammalia"]);

// Reptiles, amphibians and marine invertebrates. GBIF's raw `class` is too coarse to bucket
// these (Gastropoda spans nudibranchs and marine_mollusks), so this is only a cheap admit filter;
// the real bucket comes from species.taxon_class in the row-scan loop.
const REPTILE_AMPHIBIAN_GBIF_CLASSES = new Set(["Reptilia", "Amphibia"]);
const MARINE_INVERT_GBIF_CLASSES = new Set([
  "Anthozoa", // corals + sea anemones
  "Hydrozoa",
  "Scyphozoa",
  "Cubozoa",
  "Staurozoa", // jellies_and_anemones (jellyfish side)
  "Echinoidea",
  "Asteroidea",
  "Ophiuroidea",
  "Holothuroidea",
  "Crinoidea", // echinodermata
  "Gastropoda", // nudibranchs / marine_mollusks, split by species lookup
  "Bivalvia",
  "Polyplacophora",
  "Scaphopoda", // marine_mollusks
  "Cephalopoda",
  "Malacostraca",
  "Maxillopoda",
  "Branchiopoda",
  "Ostracoda",
  "Thecostraca", // crustacea
  "Demospongiae",
  "Hexactinellida",
  "Calcarea",
  "Homoscleromorpha", // sponges
  "Ascidiacea", // tunicates, both fall under sponges_tunicates_other
]);
const EXTRA_ADMIT_GBIF_CLASSES = new Set([...REPTILE_AMPHIBIAN_GBIF_CLASSES, ...MARINE_INVERT_GBIF_CLASSES]);

// Internal taxon_class values covered by the extra-admit classes above. They are scored with
// FISH_ABSOLUTE_TIER_THRESHOLDS as an interim assumption of fish-like data density.
const NEW_OBSCURE_TAXON_CLASSES = new Set([
  "squamata",
  "testudines",
  "amphibia",
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
]);

let taxonClassByScientificNameCache: Map<string, string> | null = null;
// Loaded once per run. Maps a scientific name to our fine-grained taxon group.
async function taxonClassByScientificName(): Promise<Map<string, string>> {
  if (taxonClassByScientificNameCache) return taxonClassByScientificNameCache;
  // Includes synonyms, so a renamed species in the GBIF data still gets scored.
  const res = await pool.query<{ scientific_name: string; taxon_class: string }>(
    `SELECT scientific_name, taxon_class FROM species WHERE taxon_class = ANY($1)
     UNION ALL
     SELECT ss.synonym_name, s.taxon_class FROM species_synonyms ss JOIN species s ON s.id = ss.species_id
      WHERE s.taxon_class = ANY($1)`,
    [[...NEW_OBSCURE_TAXON_CLASSES]],
  );
  taxonClassByScientificNameCache = new Map(res.rows.map((r) => [r.scientific_name, r.taxon_class]));
  return taxonClassByScientificNameCache;
}

let catalogNameBySynonymCache: Map<string, string> | null = null;
// The catalog name each synonym stands for. Rows are renamed as they're read, so a split species
// adds up under one catalog name instead of one half overwriting the other.
async function catalogNameBySynonym(): Promise<Map<string, string>> {
  if (catalogNameBySynonymCache) return catalogNameBySynonymCache;
  const res = await pool.query<{ synonym_name: string; scientific_name: string }>(
    `SELECT ss.synonym_name, s.scientific_name FROM species_synonyms ss JOIN species s ON s.id = ss.species_id`,
  );
  catalogNameBySynonymCache = new Map(res.rows.map((r) => [r.synonym_name, r.scientific_name]));
  return catalogNameBySynonymCache;
}

// Hotspot clustering only uses live observations, not museum specimens, which aren't useful for
// trip planning and could otherwise expose precise locations of sensitive species.
const LIVE_OBSERVATION_BASIS_OF_RECORD = new Set(["HUMAN_OBSERVATION", "OBSERVATION"]);

// Hotspots show a species' distribution pattern (spread out vs. concentrated in one corner), not
// exact spots; iNaturalist's live map does that better. ~0.1 degree (~11km) keeps a glanceable
// handful of areas per species while still separating local concentrations.
const HOTSPOT_GRID_DEGREES = 0.1;
const KM_PER_DEGREE = 111; // equirectangular approximation, same tradeoff as geometry.ts's own bboxDiagonalDegrees

// Points matching eBird's sensitive-species list (region/season scoped) collapse into one fixed
// 20km-diagonal cluster, matching eBird's obscuring. All other points get normal grid clustering.

const GBIF_API = "https://api.gbif.org/v1";

// Each country's raw GBIF zip is kept on disk so logic changes can re-run without re-downloading
// from GBIF's slow, 3-concurrent-download API. --refresh-gbif-cache forces a fresh download.
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
const GBIF_COUNTRY_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/gbif-country-cache");

// Cache of the expensive point-in-polygon scan, so scoring-only changes skip it. Invalidated by
// the cached zip's mtime only; a change to a country's set of provinces needs a manual
// --refresh-aggregate-cache.
const PROVINCE_AGGREGATE_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/province-aggregate-cache");

// Matched rows are streamed to one TSV per province, so the scan never holds every province's
// points in memory at once (large countries OOM otherwise). Scoring then reads one province file
// at a time. These files double as the aggregate cache.
function partitionFilePath(aggregateCacheKey: string, provinceId: string): string {
  return path.join(PROVINCE_AGGREGATE_CACHE_DIR, `${aggregateCacheKey}__${provinceId}.tsv`);
}

// Adds one matched occurrence row to a species' aggregate entry.
function applyRowToEntry(
  bySpecies: Map<string, SpeciesProvinceEntry>,
  species: string,
  cls: string,
  lon: number,
  lat: number,
  year: number | null,
  week: number | null,
  recordCount: number,
  basisOfRecord: string,
): void {
  let entry = bySpecies.get(species);
  if (!entry) {
    entry = {
      class: cls,
      years: new Map(),
      pointBbox: null,
      clusterLons: [],
      clusterLats: [],
      clusterWeights: [],
      clusterYears: [],
      clusterWeeks: [],
      weekCounts: new Map(),
    };
    bySpecies.set(species, entry);
  }
  if (year != null) entry.years.set(year, (entry.years.get(year) ?? 0) + recordCount);
  if (entry.pointBbox) {
    if (lon < entry.pointBbox.minLon) entry.pointBbox.minLon = lon;
    if (lon > entry.pointBbox.maxLon) entry.pointBbox.maxLon = lon;
    if (lat < entry.pointBbox.minLat) entry.pointBbox.minLat = lat;
    if (lat > entry.pointBbox.maxLat) entry.pointBbox.maxLat = lat;
  } else {
    entry.pointBbox = { minLon: lon, maxLon: lon, minLat: lat, maxLat: lat };
  }
  if (week != null && week >= 1 && week <= 52) {
    entry.weekCounts.set(week, (entry.weekCounts.get(week) ?? 0) + recordCount);
  }
  if (basisOfRecord && LIVE_OBSERVATION_BASIS_OF_RECORD.has(basisOfRecord)) {
    entry.clusterLons.push(lon);
    entry.clusterLats.push(lat);
    entry.clusterWeights.push(recordCount);
    entry.clusterYears.push(year ?? 0);
    entry.clusterWeeks.push(week ?? 0);
  }
}

async function loadProvinceEntriesFromPartition(partitionPath: string): Promise<Map<string, SpeciesProvinceEntry>> {
  const bySpecies = new Map<string, SpeciesProvinceEntry>();
  if (!existsSync(partitionPath)) return bySpecies;
  const rl = readline.createInterface({ input: createReadStream(partitionPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const [species, cls, lonStr, latStr, yearStr, weekStr, recordCountStr, basisOfRecord] = line.split("\t");
    applyRowToEntry(
      bySpecies,
      species,
      cls,
      Number(lonStr),
      Number(latStr),
      yearStr ? Number(yearStr) : null,
      weekStr ? Number(weekStr) : null,
      Number(recordCountStr),
      basisOfRecord ?? "",
    );
  }
  return bySpecies;
}

function authHeader(): string {
  const user = process.env.GBIF_USER;
  const pwd = process.env.GBIF_PWD;
  if (!user || !pwd) throw new Error("GBIF_USER and GBIF_PWD env vars are required to submit a download");
  return `Basic ${Buffer.from(`${user}:${pwd}`).toString("base64")}`;
}

// GBIF's per-account limit on simultaneous downloads.
const MAX_CONCURRENT_GBIF_DOWNLOADS = 3;

// Asks GBIF how many downloads are active before submitting. Killing this script does not cancel
// downloads already submitted server-side, so only GBIF knows how many slots are really in use.
async function waitForFreeDownloadSlot(): Promise<void> {
  const user = process.env.GBIF_USER;
  if (!user) return; // authHeader() below throws its own clearer error once we actually submit
  for (;;) {
    const res = await fetch(`${GBIF_API}/occurrence/download/user/${user}?limit=20`, {
      headers: { Authorization: authHeader() },
    });
    // Can't check right now; let the submit happen and rely on its 420 handling.
    if (!res.ok) return;
    const body = (await res.json()) as { results: Array<{ status: string }> };
    const active = body.results.filter((d) => d.status === "PREPARING" || d.status === "RUNNING").length;
    if (active < MAX_CONCURRENT_GBIF_DOWNLOADS) return;
    console.log(
      `[compute-provinces-bulk] ${active} GBIF download(s) already active for this account, waiting for a free slot...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

// GBIF records overseas territories under their own countrycode, but we model them as provinces
// of the parent country, so their codes are added to that country's download.
const OVERSEAS_TERRITORY_GBIF_CODES: Record<string, string[]> = {
  FR: ["GP", "GF", "MQ", "RE", "YT"],
  NL: ["BQ"],
};

async function submitDownload(iso2: string): Promise<string> {
  const countryCodes = [iso2, ...(OVERSEAS_TERRITORY_GBIF_CODES[iso2] ?? [])];
  const countryCodeFilter =
    countryCodes.length === 1
      ? `countrycode = '${countryCodes[0]}'`
      : `countrycode IN (${countryCodes.map((c) => `'${c}'`).join(", ")})`;
  // eventdategte needs an explicit CAST: GBIF's SQL engine treats it as epoch millis.
  const sql =
    `SELECT species, decimallatitude, decimallongitude, "class", "year", basisofrecord, ` +
    `weekofyear(CAST(eventdategte AS TIMESTAMP)) AS week, count(*) AS record_count ` +
    `FROM occurrence WHERE ${countryCodeFilter} AND decimallatitude IS NOT NULL AND decimallongitude IS NOT NULL ` +
    `AND taxonrank = 'SPECIES' AND occurrencestatus = 'PRESENT' ` +
    `GROUP BY species, decimallatitude, decimallongitude, "class", "year", basisofrecord, weekofyear(CAST(eventdategte AS TIMESTAMP))`;
  for (;;) {
    await waitForFreeDownloadSlot();
    const res = await fetch(`${GBIF_API}/occurrence/download/request`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: authHeader() },
      body: JSON.stringify({ sendNotification: false, format: "SQL_TSV_ZIP", sql }),
    });
    if (res.ok) return (await res.text()).trim();
    if (res.status === 420) {
      await res.text(); // drain the body before retrying on the same connection
      console.log(`[compute-provinces-bulk] download slots full (420) despite the free-slot check: re-checking...`);
      continue; // slot freed up between the check and the submit; re-check
    }
    throw new Error(`GBIF download request failed: ${res.status} ${await res.text()}`);
  }
}

// Returns the download's reported byte size once SUCCEEDED. downloadZip checks against it, since
// a truncated stream can end as `done` with no error.
async function pollUntilReady(downloadKey: string): Promise<number> {
  for (;;) {
    const res = await fetch(`${GBIF_API}/occurrence/download/${downloadKey}`);
    const body = (await res.json()) as { status: string; size: number };
    if (body.status === "SUCCEEDED") return body.size;
    if (body.status === "KILLED" || body.status === "FAILED" || body.status === "CANCELLED") {
      throw new Error(`GBIF download ${downloadKey} ended with status ${body.status}`);
    }
    console.log(`[compute-provinces-bulk]   download ${downloadKey}: ${body.status}, waiting...`);
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

async function downloadZip(downloadKey: string, destPath: string, expectedSize: number): Promise<void> {
  const res = await fetch(`${GBIF_API}/occurrence/download/request/${downloadKey}.zip`);
  if (!res.ok || !res.body) throw new Error(`GBIF zip fetch failed: ${res.status}`);
  const file = createWriteStream(destPath);
  let bytesWritten = 0;
  await new Promise<void>((resolve, reject) => {
    // @ts-expect-error Node's fetch Response.body is a web ReadableStream, not a Node stream,
    // so pipe manually below instead of assuming .pipe() exists on it.
    const reader = res.body.getReader();
    async function pump(): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        // `.end()` only schedules the final flush. Resolve in its callback so the file is fully
        // on disk before anyone unzips it.
        file.end(() => resolve());
        return;
      }
      bytesWritten += value.length;
      file.write(value);
      return pump();
    }
    pump().catch(reject);
  });
  // A truncated stream can end as `done` with no error; don't unzip a partial file.
  if (bytesWritten !== expectedSize) {
    throw new Error(
      `GBIF zip download for ${downloadKey} is truncated: got ${bytesWritten} bytes, expected ${expectedSize}`,
    );
  }
}

interface ProvinceRegion {
  id: string;
  name: string;
  rings: Point[][];
  bbox: BoundingBox;
  ebirdRegionCode: string | null;
}

async function loadProvinces(countryId: string): Promise<ProvinceRegion[]> {
  const res = await pool.query<{
    id: string;
    name: string;
    boundary_geojson: { type: string; coordinates: unknown };
    ebird_region_code: string | null;
  }>(
    `SELECT id, name, boundary_geojson, ebird_region_code FROM regions WHERE parent_id = $1 AND boundary_geojson IS NOT NULL`,
    [countryId],
  );
  return res.rows.map((r) => {
    const geometry = (r.boundary_geojson as { geometry?: unknown }).geometry ?? r.boundary_geojson;
    const rings = exteriorRingsFromGeometry(geometry as { type: string; coordinates: unknown });
    const allPoints = rings.flat();
    return { id: r.id, name: r.name, rings, bbox: ringBoundingBox(allPoints), ebirdRegionCode: r.ebird_region_code };
  });
}

// eBird's historical species list for a province (spplist accepts subnational codes like "CA-BC").
// One-directional: presence on eBird only rescues a bird GBIF's recurrence check would exclude or
// flag vagrant, never excludes one GBIF accepted.
const EBIRD_API_KEY = process.env.EBIRD_API_KEY;
const EBIRD_SPPLIST_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/ebird-spplist-cache");
const ebirdSpeciesCodesCache = new Map<string, Promise<Set<string> | null>>();

async function fetchEbirdRegionSpeciesCodes(regionCode: string): Promise<Set<string> | null> {
  if (!EBIRD_API_KEY) return null;
  if (!ebirdSpeciesCodesCache.has(regionCode)) {
    ebirdSpeciesCodesCache.set(
      regionCode,
      (async () => {
        mkdirSync(EBIRD_SPPLIST_CACHE_DIR, { recursive: true });
        const cachePath = path.join(EBIRD_SPPLIST_CACHE_DIR, `${regionCode}.json`);
        if (existsSync(cachePath)) {
          return new Set(JSON.parse(readFileSync(cachePath, "utf8")) as string[]);
        }
        try {
          const res = await fetch(`https://api.ebird.org/v2/product/spplist/${regionCode}`, {
            headers: { "X-eBirdApiToken": EBIRD_API_KEY },
          });
          if (!res.ok) return null; // e.g. eBird doesn't recognize this exact region code
          const codes = (await res.json()) as string[];
          writeFileSync(cachePath, JSON.stringify(codes));
          return new Set(codes);
        } catch {
          return null; // best-effort: a network error just means no rescue this run
        }
      })(),
    );
  }
  return ebirdSpeciesCodesCache.get(regionCode)!;
}

// Math.max(...arr) overflows the argument limit on very large arrays; a loop does not.
function maxOf(values: number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return max;
}

interface Hotspot {
  centroidLat: number;
  centroidLon: number;
  pointCount: number;
  bboxDiagonalKm: number;
  // The cluster's own year range, shown as plain facts so the user can tell a long-running spot
  // from a single old sighting.
  lastSeenYear: number | null;
  distinctYears: number | null;
}

// A plain average over a whole ~11km cell drifts toward scattered records, so a cell reports the
// average of its densest sub-cell instead, the spot where sightings actually pile up.
const HOTSPOT_PEAK_SUBCELL_DEGREES = 0.02; // ~2.2km, coarse enough that GPS noise doesn't split one spot
function peakCentroid(cell: { lats: number[]; lons: number[]; weights: number[] }): {
  centroidLat: number;
  centroidLon: number;
} {
  const subCells = new Map<string, { latSum: number; lonSum: number; weight: number }>();
  for (let i = 0; i < cell.lats.length; i++) {
    const key = `${Math.floor(cell.lats[i] / HOTSPOT_PEAK_SUBCELL_DEGREES)},${Math.floor(cell.lons[i] / HOTSPOT_PEAK_SUBCELL_DEGREES)}`;
    let sub = subCells.get(key);
    if (!sub) {
      sub = { latSum: 0, lonSum: 0, weight: 0 };
      subCells.set(key, sub);
    }
    sub.latSum += cell.lats[i] * cell.weights[i];
    sub.lonSum += cell.lons[i] * cell.weights[i];
    sub.weight += cell.weights[i];
  }
  let peak: { latSum: number; lonSum: number; weight: number } | null = null;
  for (const sub of subCells.values()) {
    if (!peak || sub.weight > peak.weight) peak = sub;
  }
  return { centroidLat: peak!.latSum / peak!.weight, centroidLon: peak!.lonSum / peak!.weight };
}

function summarizeSensitiveCluster(
  points: Array<{ lon: number; lat: number; weight: number; year: number | null }>,
): Hotspot {
  const totalWeight = points.reduce((sum, p) => sum + p.weight, 0);
  const years = points.map((p) => p.year).filter((y): y is number => y != null);
  return {
    centroidLat: points.reduce((sum, p) => sum + p.lat, 0) / points.length,
    centroidLon: points.reduce((sum, p) => sum + p.lon, 0) / points.length,
    pointCount: totalWeight,
    bboxDiagonalKm: SENSITIVE_CLUSTER_DIAGONAL_KM,
    lastSeenYear: years.length > 0 ? maxOf(years) : null,
    distinctYears: years.length > 0 ? new Set(years).size : null,
  };
}

// Grid-bins points into hotspots. Sensitive points (checked per point, so region/season scoped)
// collapse into one fixed-size obscured cluster instead. Takes parallel arrays, with 0 as the
// "null" sentinel for years/weeks.
function clusterHotspots(
  lons: number[],
  lats: number[],
  weights: number[],
  years: number[],
  weeks: number[],
  isSensitivePoint: (week: number | null) => boolean,
): Hotspot[] {
  const n = lons.length;
  if (n === 0) return [];
  const sensitivePoints: Array<{ lon: number; lat: number; weight: number; year: number | null }> = [];
  const cells = new Map<
    string,
    { lats: number[]; lons: number[]; weights: number[]; weight: number; years: number[] }
  >();
  for (let i = 0; i < n; i++) {
    const year = years[i] === 0 ? null : years[i];
    const week = weeks[i] === 0 ? null : weeks[i];
    if (isSensitivePoint(week)) {
      sensitivePoints.push({ lon: lons[i], lat: lats[i], weight: weights[i], year });
      continue;
    }
    const key = `${Math.floor(lats[i] / HOTSPOT_GRID_DEGREES)},${Math.floor(lons[i] / HOTSPOT_GRID_DEGREES)}`;
    let cell = cells.get(key);
    if (!cell) {
      cell = { lats: [], lons: [], weights: [], weight: 0, years: [] };
      cells.set(key, cell);
    }
    cell.lats.push(lats[i]);
    cell.lons.push(lons[i]);
    cell.weights.push(weights[i]);
    cell.weight += weights[i];
    if (year != null) cell.years.push(year);
  }
  const sensitiveCluster = sensitivePoints.length > 0 ? [summarizeSensitiveCluster(sensitivePoints)] : [];
  if (cells.size === 0) return sensitiveCluster;

  // A cluster of only a point or two is one incidental sighting, not a repeat-visited area.
  const MIN_CLUSTER_WEIGHT = 3;
  const filtered = [...cells.values()].filter((cell) => cell.weight >= MIN_CLUSTER_WEIGHT);

  // A province-wide top-N cap lets one busy metro area fill every slot. Instead, a cluster is
  // kept if it is still a meaningful share of the best cluster in its own ~55km area.
  const DIVERSITY_CELL_DEGREES = 0.5; // ~55km, roughly one city's worth of area
  const MIN_RELATIVE_SHARE_OF_LOCAL_BEST = 0.05; // keep anything still >=5% of the best cluster in the same ~55km area
  const MAX_CLUSTERS_PER_DIVERSITY_CELL = 25; // safety ceiling only

  const centroidCells = filtered.map((cell) => ({ cell, ...peakCentroid(cell) }));
  const byDiversityCell = new Map<string, typeof centroidCells>();
  for (const c of centroidCells) {
    const key = `${Math.floor(c.centroidLat / DIVERSITY_CELL_DEGREES)},${Math.floor(c.centroidLon / DIVERSITY_CELL_DEGREES)}`;
    if (!byDiversityCell.has(key)) byDiversityCell.set(key, []);
    byDiversityCell.get(key)!.push(c);
  }
  const kept = [...byDiversityCell.values()].flatMap((group) => {
    const sorted = group.sort((a, b) => b.cell.weight - a.cell.weight);
    const localBestWeight = sorted[0].cell.weight;
    return sorted
      .filter((c) => c.cell.weight >= localBestWeight * MIN_RELATIVE_SHARE_OF_LOCAL_BEST)
      .slice(0, MAX_CLUSTERS_PER_DIVERSITY_CELL);
  });

  return [
    ...sensitiveCluster,
    ...kept.map(({ cell, centroidLat, centroidLon }) => ({
      centroidLat,
      centroidLon,
      pointCount: cell.weight,
      bboxDiagonalKm:
        bboxDiagonalDegrees(ringBoundingBox(cell.lats.map((lat, i) => [cell.lons[i], lat] as Point))) * KM_PER_DEGREE,
      lastSeenYear: cell.years.length > 0 ? maxOf(cell.years) : null,
      distinctYears: cell.years.length > 0 ? new Set(cell.years).size : null,
    })),
  ];
}

// Makes sure GBIF_COUNTRY_CACHE_DIR/{iso2}.zip exists, downloading it if missing. Split out so
// refresh-all-provinces.ts's download queue (--cache-only) can fetch ahead of processing.
async function ensureGbifZipCached(countryName: string, iso2: string, refreshCache: boolean): Promise<void> {
  const cachedZipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  if (!refreshCache && existsSync(cachedZipPath)) return;

  console.log(`[compute-provinces-bulk] ${countryName}: submitting GBIF download for country=${iso2}...`);
  const downloadKey = await submitDownload(iso2);
  console.log(`[compute-provinces-bulk] ${countryName}: download key ${downloadKey}, polling...`);
  const expectedSize = await pollUntilReady(downloadKey);
  console.log(`[compute-provinces-bulk] ${countryName}: download ready, fetching zip...`);

  const workDir = mkdtempSync(path.join(tmpdir(), "gbif-provinces-"));
  try {
    const zipPath = path.join(workDir, "download.zip");
    await downloadZip(downloadKey, zipPath, expectedSize);
    mkdirSync(GBIF_COUNTRY_CACHE_DIR, { recursive: true });
    copyFileSync(zipPath, cachedZipPath);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

// How long processing waits for the download queue to produce a country's zip before submitting
// the download itself (a backstop only). GBIF can sit in PREPARING for a long time, and a second
// submit would just waste a slot on a duplicate.
const DOWNLOAD_QUEUE_WAIT_MS = 60 * 60_000;

async function waitForOrEnsureGbifZipCached(countryName: string, iso2: string, refreshCache: boolean): Promise<void> {
  const cachedZipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  if (refreshCache || existsSync(cachedZipPath)) {
    await ensureGbifZipCached(countryName, iso2, refreshCache);
    return;
  }
  const deadline = Date.now() + DOWNLOAD_QUEUE_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(cachedZipPath)) return;
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  console.log(
    `[compute-provinces-bulk] ${countryName}: still not cached after waiting ${DOWNLOAD_QUEUE_WAIT_MS / 60_000}min on the download queue: submitting it directly instead`,
  );
  await ensureGbifZipCached(countryName, iso2, refreshCache);
}

// `pointBbox` is a running bounding box (for the distribution-elusiveness boost), kept as 4
// numbers instead of every point to bound memory. The cluster* fields hold live-observation
// points for hotspot clustering as parallel number arrays rather than objects, which avoids GC
// thrashing on huge countries; year/week use 0 as the "null" sentinel to keep them pure numbers.
// `weekCounts` counts every record regardless of basis of record.
interface SpeciesProvinceEntry {
  class: string;
  years: Map<number, number>;
  pointBbox: BoundingBox | null;
  clusterLons: number[];
  clusterLats: number[];
  clusterWeights: number[];
  clusterYears: number[];
  clusterWeeks: number[];
  weekCounts: Map<number, number>;
}

// Species flagged as escapee/introduced in this country (compute-elusiveness.ts). Keyed by
// scientific_name, the join key already available in `included` below.
async function loadNonNativeSpeciesNames(iso3: string): Promise<Set<string>> {
  const res = await pool.query<{ scientific_name: string }>(
    `SELECT s.scientific_name FROM species_nonnative_countries snc
     JOIN species s ON s.id = snc.species_id
     WHERE snc.country_iso3 = $1`,
    [iso3],
  );
  return new Set(res.rows.map((r) => r.scientific_name));
}

// Verified (region, species) answers from authoritative sources that override the record-pattern
// check. Loaded once per country.
async function loadManualOverrides(
  provinceIds: string[],
): Promise<Map<string, Map<string, { isVagrant: boolean; isInvasive: boolean | null }>>> {
  const byProvince = new Map<string, Map<string, { isVagrant: boolean; isInvasive: boolean | null }>>();
  if (provinceIds.length === 0) return byProvince;
  const res = await pool.query<{
    region_id: string;
    species_id: string;
    is_vagrant: boolean;
    is_invasive: boolean | null;
  }>(
    `SELECT region_id, species_id, is_vagrant, is_invasive FROM region_species_manual_overrides WHERE region_id = ANY($1)`,
    [provinceIds],
  );
  for (const row of res.rows) {
    if (!byProvince.has(row.region_id)) byProvince.set(row.region_id, new Map());
    byProvince.get(row.region_id)!.set(row.species_id, { isVagrant: row.is_vagrant, isInvasive: row.is_invasive });
  }
  return byProvince;
}

async function computeCountryProvinces(
  countryName: string,
  iso2: string,
  countryId: string,
  apply: boolean,
  refreshCache: boolean,
  refreshAggregateCache = false,
): Promise<void> {
  const provincesArg = process.argv.find((a) => a.startsWith("--provinces="));
  // --provinces limits the run to named provinces.
  const provinceNameFilter = provincesArg ? new Set(provincesArg.split("=")[1].split(",")) : null;
  const allProvinces = await loadProvinces(countryId);
  const provinces = provinceNameFilter ? allProvinces.filter((p) => provinceNameFilter.has(p.name)) : allProvinces;
  if (provinces.length === 0) {
    console.log(
      `[compute-provinces-bulk] ${countryName}: no province rows found (drill-down produced none, or none matched --provinces): skipping`,
    );
    return;
  }

  const iso3 = (await fetchAllCountries()).find((c) => c.iso2 === iso2)?.iso3 ?? null;
  const nonNativeSpeciesNames = iso3 ? await loadNonNativeSpeciesNames(iso3) : new Set<string>();
  // Resolved once per country; province iNat place lookups are filtered against it.
  const countryInatPlaceId = await resolveInatPlaceId(countryId, countryName, true, null);
  const manualOverridesByProvince = await loadManualOverrides(provinces.map((p) => p.id));

  await waitForOrEnsureGbifZipCached(countryName, iso2, refreshCache);
  console.log(
    `[compute-provinces-bulk] ${countryName}: tracking ${provinces.length} province(s), using cached GBIF data...`,
  );
  const cachedZipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  // Keyed by iso2 plus country name: some countries share an iso2 (a territory and its parent)
  // but have different province sets, so they'd poison each other's cache otherwise.
  const aggregateCacheKey = `${iso2}-${countryName.replace(/[^a-zA-Z0-9]+/g, "_")}`;
  const partitionPaths = new Map(provinces.map((p) => [p.id, partitionFilePath(aggregateCacheKey, p.id)] as const));
  const zipMtimeMs = statSync(cachedZipPath).mtimeMs;
  const allPartitionsFresh =
    !refreshAggregateCache &&
    [...partitionPaths.values()].every((p) => existsSync(p) && statSync(p).mtimeMs >= zipMtimeMs);

  if (allPartitionsFresh) {
    console.log(
      `[compute-provinces-bulk] ${countryName}: reusing cached point-matched partitions (skipping the raw GBIF scan)`,
    );
  } else {
    // Single-threaded on purpose: the worker_threads pool in provinceMatchWorker.ts deadlocks
    // under load for an unknown reason. Don't re-enable it without root-causing that.
    function findProvinces(point: [number, number]): ProvinceRegion[] {
      const pointBbox: BoundingBox = { minLon: point[0], minLat: point[1], maxLon: point[0], maxLat: point[1] };
      const matches: ProvinceRegion[] = [];
      for (const province of provinces) {
        if (!bboxesNear(province.bbox, pointBbox, 0)) continue;
        if (pointInAnyRing(point, province.rings)) matches.push(province);
      }
      return matches;
    }

    mkdirSync(PROVINCE_AGGREGATE_CACHE_DIR, { recursive: true });
    // One write stream per province for the whole scan; matched rows are written straight through.
    const writeStreams = new Map(provinces.map((p) => [p.id, createWriteStream(partitionPaths.get(p.id)!)] as const));
    const taxonClassByName = await taxonClassByScientificName();
    const catalogNames = await catalogNameBySynonym();

    const unzipProc = spawn("unzip", ["-p", cachedZipPath]);
    // A corrupt zip makes `unzip -p` emit nothing on stdout, which looks like zero occurrences,
    // so capture stderr and check the exit code below.
    let unzipStderr = "";
    unzipProc.stderr.on("data", (chunk) => (unzipStderr += chunk));
    const rl = readline.createInterface({ input: unzipProc.stdout, crlfDelay: Infinity });
    let header: string[] | null = null;
    // Columns are read by index, and class is checked first, since most of the 100M+ rows are
    // taxa this script skips.
    let colIndex: Record<string, number> = {};
    let rowCount = 0;
    let matchedCount = 0;
    for await (const line of rl) {
      if (!line) continue;
      const cols = line.split("\t");
      if (!header) {
        header = cols;
        colIndex = Object.fromEntries(header.map((h, i) => [h, i]));
        continue;
      }
      rowCount++;
      const rawClass = cols[colIndex.class] ?? "";
      // Skip untracked classes before reading anything else.
      const isFastPathClass = BIRD_MAMMAL_CLASSES.has(rawClass) || FISH_CLASSES.has(rawClass);
      if (!isFastPathClass && !EXTRA_ADMIT_GBIF_CLASSES.has(rawClass)) continue;
      const rawSpecies = cols[colIndex.species];
      const species = catalogNames.get(rawSpecies) ?? rawSpecies;
      const cls = isFastPathClass ? rawClass : (taxonClassByName.get(species) ?? null);
      if (!cls) continue;
      const lat = Number(cols[colIndex.decimallatitude]);
      const lon = Number(cols[colIndex.decimallongitude]);
      if (!species || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const yearRaw = cols[colIndex.year];
      const year = yearRaw ? Number(yearRaw) : null;
      const weekRaw = cols[colIndex.week];
      const week = weekRaw ? Number(weekRaw) : null;
      const basisOfRecord = cols[colIndex.basisofrecord] ?? "";
      const recordCountRaw = cols[colIndex.record_count];
      const recordCount = recordCountRaw ? Number(recordCountRaw) : 1;

      const matched = findProvinces([lon, lat]);
      if (matched.length === 0) continue;
      matchedCount++;
      for (const province of matched) {
        const stream = writeStreams.get(province.id)!;
        stream.write(
          `${species}\t${cls}\t${lon}\t${lat}\t${year ?? ""}\t${week ?? ""}\t${recordCount}\t${basisOfRecord}\n`,
        );
      }
    }

    const unzipExit = await new Promise<number | null>((resolve) => unzipProc.on("close", resolve));
    if (unzipExit !== 0) {
      throw new Error(`unzip -p on ${cachedZipPath} exited ${unzipExit}: ${unzipStderr.trim()}`);
    }

    await Promise.all(
      [...writeStreams.values()].map(
        (stream) =>
          new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve()))),
      ),
    );

    console.log(
      `[compute-provinces-bulk] ${countryName}: scanned ${rowCount.toLocaleString()} rows, ${matchedCount.toLocaleString()} matched a province`,
    );
    console.log(`[compute-provinces-bulk] ${countryName}: cached point-matched partitions for future re-scoring runs`);
  }

  {
    const currentYear = new Date().getFullYear();
    for (const province of provinces) {
      // Only one province's points are in memory at a time.
      const bySpecies = await loadProvinceEntriesFromPartition(partitionPaths.get(province.id)!);
      const included: Array<{ species: string; recordCount: number; isVagrant: boolean }> = [];

      // Per-class median for the recurrence floor, since record volumes differ widely by class.
      // Computed only from species that clear MIN_RECORDS, as the raw candidate pool is mostly noise.
      const allTimeTotalByClass = new Map<string, number[]>();
      for (const [, { class: cls, years }] of bySpecies) {
        if (FISH_CLASSES.has(cls)) continue;
        const allTimeTotal = [...years.values()].reduce((sum, c) => sum + c, 0);
        const recentTotal = [...years.entries()]
          .filter(([year]) => year >= currentYear - RECENT_YEARS_WINDOW)
          .reduce((sum, [, c]) => sum + c, 0);
        if (recentTotal < MIN_RECORDS) continue;
        if (!allTimeTotalByClass.has(cls)) allTimeTotalByClass.set(cls, []);
        allTimeTotalByClass.get(cls)!.push(allTimeTotal);
      }
      const recurrenceFloorByClass = new Map(
        [...allTimeTotalByClass.entries()].map(([cls, totals]) => [
          cls,
          medianOf(totals) * RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN,
        ]),
      );

      for (const [species, { class: cls, years }] of bySpecies) {
        const yearCountArr = [...years.entries()].map(([year, count]) => ({ year, count }));
        const allTimeTotal = yearCountArr.reduce((sum, y) => sum + y.count, 0);

        const isNonNative = nonNativeSpeciesNames.has(species);
        if (FISH_CLASSES.has(cls)) {
          if (allTimeTotal < FISH_MIN_RECORDS) continue;
          included.push({
            species,
            recordCount: allTimeTotal,
            isVagrant: isNonNative || allTimeTotal < FISH_VAGRANT_MIN_RECORDS,
          });
          continue;
        }
        const recurrenceFloor = recurrenceFloorByClass.get(cls) ?? 0;
        const recentTotal = yearCountArr
          .filter((y) => y.year >= currentYear - RECENT_YEARS_WINDOW)
          .reduce((sum, y) => sum + y.count, 0);
        if (recentTotal >= MIN_RECORDS) {
          included.push({
            species,
            recordCount: recentTotal,
            isVagrant: isNonNative || !passesRecurrenceCheck(yearCountArr, recurrenceFloor),
          });
          continue;
        }
        // Enough records to be findable but no proven recurrence: list it flagged vagrant rather
        // than drop it. Hard-to-detect residents are fixed via region_species_manual_overrides.
        if (allTimeTotal >= RECURRENCE_ALLTIME_FLOOR) {
          included.push({
            species,
            recordCount: allTimeTotal,
            isVagrant: isNonNative || !passesRecurrenceCheck(yearCountArr, recurrenceFloor),
          });
        }
      }

      // eBird rescue pass for birds GBIF dropped or flagged vagrant. Nonnative species are never
      // rescued. Rescued names are kept through the iNat reconcile below.
      const ebirdRescuedNames: string[] = [];
      if (province.ebirdRegionCode && EBIRD_API_KEY) {
        const includedByName = new Map(included.map((c) => [c.species, c]));
        const rescueCandidates: string[] = [];
        for (const [species, { class: cls }] of bySpecies) {
          if (cls !== "Aves" || nonNativeSpeciesNames.has(species)) continue;
          const existing = includedByName.get(species);
          if (!existing || existing.isVagrant) rescueCandidates.push(species);
        }
        if (rescueCandidates.length > 0) {
          const ebirdCodes = await fetchEbirdRegionSpeciesCodes(province.ebirdRegionCode);
          if (ebirdCodes) {
            const codeRes = await pool.query<{ scientific_name: string; ebird_code: string | null }>(
              `SELECT scientific_name, ebird_code FROM species WHERE scientific_name = ANY($1)`,
              [rescueCandidates],
            );
            let rescued = 0;
            for (const row of codeRes.rows) {
              if (!row.ebird_code || !ebirdCodes.has(row.ebird_code)) continue;
              ebirdRescuedNames.push(row.scientific_name);
              const existing = includedByName.get(row.scientific_name);
              if (existing) {
                existing.isVagrant = false;
              } else {
                const entry = bySpecies.get(row.scientific_name)!;
                const allTimeTotal = [...entry.years.values()].reduce((sum, c) => sum + c, 0);
                const rescuedEntry = { species: row.scientific_name, recordCount: allTimeTotal, isVagrant: false };
                included.push(rescuedEntry);
                includedByName.set(row.scientific_name, rescuedEntry);
              }
              rescued++;
            }
            if (rescued > 0) {
              console.log(
                `[compute-provinces-bulk]   ${province.name}: eBird rescued ${rescued} bird(s) GBIF's own pattern check would have excluded or flagged vagrant`,
              );
            }
          }
        }
      }

      // iNaturalist Research Grade rescue pass, for all taxa (eBird covers only birds). Re-reads
      // `included` so it sees the eBird rescues above.
      {
        const includedByName = new Map(included.map((c) => [c.species, c]));
        const rescueCandidates: string[] = [];
        for (const [species] of bySpecies) {
          if (nonNativeSpeciesNames.has(species)) continue;
          const existing = includedByName.get(species);
          if (!existing || existing.isVagrant) rescueCandidates.push(species);
        }
        if (rescueCandidates.length > 0) {
          const provinceInatPlaceId = await resolveInatPlaceId(province.id, province.name, false, countryInatPlaceId);
          if (provinceInatPlaceId != null) {
            const researchGradeTaxonIds = await fetchInatResearchGradeTaxonIds(provinceInatPlaceId);
            if (researchGradeTaxonIds) {
              const codeRes = await pool.query<{ scientific_name: string; inat_taxon_id: number | null }>(
                `SELECT scientific_name, inat_taxon_id FROM species WHERE scientific_name = ANY($1)`,
                [rescueCandidates],
              );
              let rescued = 0;
              for (const row of codeRes.rows) {
                if (row.inat_taxon_id == null || !researchGradeTaxonIds.has(row.inat_taxon_id)) continue;
                const existing = includedByName.get(row.scientific_name);
                if (existing) {
                  existing.isVagrant = false;
                } else {
                  const entry = bySpecies.get(row.scientific_name)!;
                  const allTimeTotal = [...entry.years.values()].reduce((sum, c) => sum + c, 0);
                  const rescuedEntry = { species: row.scientific_name, recordCount: allTimeTotal, isVagrant: false };
                  included.push(rescuedEntry);
                  includedByName.set(row.scientific_name, rescuedEntry);
                }
                rescued++;
              }
              if (rescued > 0) {
                console.log(
                  `[compute-provinces-bulk]   ${province.name}: iNaturalist Research Grade rescued ${rescued} species GBIF's own pattern check would have excluded or flagged vagrant`,
                );
              }
            }
          }
        }
      }

      console.log(
        `[compute-provinces-bulk]   ${province.name}: ${included.length} species pass inclusion (of ${bySpecies.size} candidates)`,
      );
      if (!apply) continue;

      // Local tier mirrors the global tier logic (apply-rarity-phase4.ts) on this province's data:
      // an absolute composite threshold, not a percentile quota.
      //
      // Hotspots are clustered once and reused for rangeScore and the hotspot write below.
      const clustersBySpecies = new Map<string, Hotspot[]>();
      for (const c of included) {
        const entry = bySpecies.get(c.species)!;
        const scope = EBIRD_SENSITIVE_SPECIES.get(c.species);
        // Not sensitive: never blur. Globally sensitive: always blur. Regionally sensitive: blur
        // only if this province matches a listed region and the point's week is in its season.
        const isSensitivePoint = !scope
          ? () => false
          : scope.global
            ? () => true
            : (week: number | null) => {
                const matchingRegions = scope.regions.filter((r) =>
                  sensitiveRegionMatches(r.region, province.name, countryName, iso2),
                );
                return matchingRegions.some((r) => r.season === null || (week != null && weekInSeason(week, r.season)));
              };
        clustersBySpecies.set(
          c.species,
          clusterHotspots(
            entry.clusterLons,
            entry.clusterLats,
            entry.clusterWeights,
            entry.clusterYears,
            entry.clusterWeeks,
            isSensitivePoint,
          ),
        );
      }

      // rangeScore: how concentrated a species' points are relative to the province's bounding
      // box (small range, high score). abundanceScore: record-count rank (fewer records, higher
      // score). Both are percentile sub-scores; the composite is compared against the same
      // absolute thresholds used globally.
      //
      // Range drops only outlier clusters that are both small and far from the rest. Dropping
      // merely small clusters would shrink the range of widespread species seen in many towns.
      const OUTLIER_MAX_SHARE = 0.1;
      const OUTLIER_DISTANCE_STD_DEVS = 2.5;
      function coreRangeDiagonalKm(clusters: Hotspot[]): number {
        if (clusters.length <= 1) return clusters[0]?.bboxDiagonalKm ?? 0;
        const total = clusters.reduce((sum, cl) => sum + cl.pointCount, 0);
        const centroidLat = clusters.reduce((sum, cl) => sum + cl.centroidLat * cl.pointCount, 0) / total;
        const centroidLon = clusters.reduce((sum, cl) => sum + cl.centroidLon * cl.pointCount, 0) / total;
        // Equirectangular approximation, with longitude scaled by cos(latitude).
        const lonScale = Math.cos((centroidLat * Math.PI) / 180);
        const distanceKm = (cl: Hotspot) =>
          Math.sqrt((cl.centroidLat - centroidLat) ** 2 + ((cl.centroidLon - centroidLon) * lonScale) ** 2) *
          KM_PER_DEGREE;
        const meanDistanceKm = clusters.reduce((sum, cl) => sum + distanceKm(cl) * cl.pointCount, 0) / total;
        const stdDevKm = Math.sqrt(
          clusters.reduce((sum, cl) => sum + (distanceKm(cl) - meanDistanceKm) ** 2 * cl.pointCount, 0) / total,
        );

        const core = clusters.filter((cl) => {
          const isSmall = cl.pointCount / total <= OUTLIER_MAX_SHARE;
          const isFar = stdDevKm > 0 && distanceKm(cl) > meanDistanceKm + OUTLIER_DISTANCE_STD_DEVS * stdDevKm;
          return !(isSmall && isFar);
        });
        // Defensive fallback if every cluster was flagged an outlier.
        const effective = core.length > 0 ? core : clusters;
        if (effective.length === 1) return effective[0].bboxDiagonalKm;
        const centroidSpanKm =
          bboxDiagonalDegrees(ringBoundingBox(effective.map((cl) => [cl.centroidLon, cl.centroidLat] as Point))) *
          KM_PER_DEGREE;
        const maxClusterRadiusKm = maxOf(effective.map((cl) => cl.bboxDiagonalKm / 2));
        return centroidSpanKm + maxClusterRadiusKm * 2;
      }

      // Interim even split between the only two axes available here (no elusiveness data),
      // pending calibration against anchor species.
      const PROVINCE_RANGE_ABUNDANCE_WEIGHTS = { range: 0.5, abundance: 0.5 };
      const regionDiagonalKm = bboxDiagonalDegrees(province.bbox) * KM_PER_DEGREE;
      // Species with no hotspot clusters are left out of the ranking (a ratio of 0 would read as
      // perfectly concentrated) and get the neutral `?? 0.5` fallback below.
      const spreadRatioEntries = included.flatMap((c, idx) => {
        const clusters = clustersBySpecies.get(c.species) ?? [];
        if (clusters.length === 0) return [];
        return [{ idx, value: regionDiagonalKm > 0 ? coreRangeDiagonalKm(clusters) / regionDiagonalKm : 0 }];
      });
      const spreadScoreByIdx = percentileRankScores(spreadRatioEntries);
      const baseScoreByIdx = percentileRankScores(included.map((c, idx) => ({ idx, value: c.recordCount })));

      // Record volume varies hugely between provinces, and in thin-data ones percentile rank is
      // mostly noise. Composites there are pulled toward the taxon's neutral threshold; a class
      // with >=1M records in the province is trusted fully.
      const CONFIDENCE_LOW_RECORDS = 10_000;
      const CONFIDENCE_HIGH_RECORDS = 1_000_000;
      function confidenceFromTotalRecords(totalRecords: number): number {
        if (totalRecords <= CONFIDENCE_LOW_RECORDS) return 0;
        if (totalRecords >= CONFIDENCE_HIGH_RECORDS) return 1;
        return (
          (Math.log10(totalRecords) - Math.log10(CONFIDENCE_LOW_RECORDS)) /
          (Math.log10(CONFIDENCE_HIGH_RECORDS) - Math.log10(CONFIDENCE_LOW_RECORDS))
        );
      }
      const totalRecordsByClass = new Map<string, number>();
      for (const c of included) {
        const cls = bySpecies.get(c.species)!.class;
        totalRecordsByClass.set(cls, (totalRecordsByClass.get(cls) ?? 0) + c.recordCount);
      }

      const localTierBySpecies = new Map<string, string>();
      included.forEach((c, idx) => {
        const cls = bySpecies.get(c.species)!.class;
        // Taxon groups without reliable data density stay untiered everywhere, for consistency.
        if (NO_RARITY_TIER_TAXON_CLASSES.has(cls as TaxonClass)) return;
        const rangeScore = spreadScoreByIdx.get(idx) ?? 0.5;
        const abundanceScore = baseScoreByIdx.get(idx) ?? 0.5;
        const rawComposite =
          PROVINCE_RANGE_ABUNDANCE_WEIGHTS.range * rangeScore +
          PROVINCE_RANGE_ABUNDANCE_WEIGHTS.abundance * abundanceScore;
        const thresholds =
          FISH_CLASSES.has(cls) || NEW_OBSCURE_TAXON_CLASSES.has(cls)
            ? FISH_ABSOLUTE_TIER_THRESHOLDS
            : cls === "Mammalia"
              ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS
              : BIRD_ABSOLUTE_TIER_THRESHOLDS;
        const confidence = confidenceFromTotalRecords(totalRecordsByClass.get(cls) ?? 0);
        const neutralAnchor = thresholds.find((t) => t.tier === "occasional")!.minScore;
        const composite = confidence * rawComposite + (1 - confidence) * neutralAnchor;
        localTierBySpecies.set(c.species, tierForScore(composite, thresholds));
      });
      // Clamp the local tier to within a few steps of the global tier, same rule as
      // regions/routes.ts, so thin-data noise can't swing a species too far either way.
      const LOCAL_TIER_GLOBAL_FLOOR_STEPS = 1;
      const LOCAL_TIER_GLOBAL_CEILING_STEPS = 2;
      const TIER_ORDER = ["legendary", "rare", "uncommon", "occasional", "common"];
      const globalTierRes = await pool.query<{ scientific_name: string; tier: string }>(
        `SELECT s.scientific_name, r.tier FROM species s JOIN species_rarity r ON r.species_id = s.id WHERE s.scientific_name = ANY($1)
         UNION ALL
         SELECT ss.synonym_name, r.tier FROM species_synonyms ss JOIN species_rarity r ON r.species_id = ss.species_id
          WHERE ss.synonym_name = ANY($1)`,
        [included.map((c) => c.species)],
      );
      const globalTierBySpecies = new Map(globalTierRes.rows.map((r) => [r.scientific_name, r.tier]));
      for (const [species, localTier] of localTierBySpecies) {
        const globalTier = globalTierBySpecies.get(species);
        if (!globalTier || globalTier === "unrated") continue;
        const globalRank = TIER_ORDER.indexOf(globalTier);
        const localRank = TIER_ORDER.indexOf(localTier);
        const clampedRank = Math.min(
          Math.max(localRank, globalRank - LOCAL_TIER_GLOBAL_CEILING_STEPS),
          globalRank + LOCAL_TIER_GLOBAL_FLOOR_STEPS,
        );
        if (clampedRank !== localRank) localTierBySpecies.set(species, TIER_ORDER[clampedRank]);
      }

      // Timeout so an exhausted pool fails loudly instead of hanging silently.
      const client = await Promise.race([
        pool.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`pool.connect() timed out acquiring a client for ${province.name}`)),
            30_000,
          ),
        ),
      ]);
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM region_species WHERE region_id = $1`, [province.id]);
        await client.query(`DELETE FROM region_species_hotspots WHERE region_id = $1`, [province.id]);
        let written = 0;
        let hotspotsWritten = 0;
        // GBIF names drift from our catalog after reclassifications, so names also resolve via
        // species_synonyms (the catalog name wins). One lookup for the whole province.
        const names = included.map((c) => c.species);
        const idRes = await client.query<{ name: string; id: string }>(
          `SELECT DISTINCT ON (n.name) n.name, m.id
           FROM unnest($1::text[]) AS n(name)
           JOIN (
             SELECT scientific_name AS name, id, 0 AS pref FROM species WHERE scientific_name = ANY($1)
             UNION ALL
             SELECT synonym_name, species_id, 1 FROM species_synonyms WHERE synonym_name = ANY($1)
           ) m ON m.name = n.name
           ORDER BY n.name, m.pref`,
          [names],
        );
        const idByName = new Map(idRes.rows.map((r) => [r.name, r.id]));
        // Keyed by species id: two names can resolve to one species, and the later one wins.
        const speciesRows = new Map<string, unknown[]>();
        const hotspotRows: unknown[][] = [];
        for (const c of included) {
          const speciesId = idByName.get(c.species);
          if (!speciesId) continue;

          // Manual overrides win. is_invasive only ever comes from an override.
          const override = manualOverridesByProvince.get(province.id)?.get(speciesId);
          const isVagrant = override?.isVagrant ?? c.isVagrant;
          const isInvasive = override?.isInvasive ?? false;

          // 1-indexed ISO week -> 0-indexed array slot, same convention as region_species.seasonality.
          const entry = bySpecies.get(c.species)!;
          const weeklyFrequency = Array.from({ length: 52 }, (_, i) => entry.weekCounts.get(i + 1) ?? 0);
          const hasWeeklyData = weeklyFrequency.some((v) => v > 0);
          speciesRows.set(speciesId, [
            province.id,
            speciesId,
            c.recordCount,
            isVagrant,
            isInvasive,
            localTierBySpecies.get(c.species) ?? null,
            hasWeeklyData ? `{${weeklyFrequency.join(",")}}` : null,
          ]);
          for (const hotspot of clustersBySpecies.get(c.species) ?? []) {
            hotspotRows.push([
              province.id,
              speciesId,
              hotspot.centroidLat,
              hotspot.centroidLon,
              hotspot.pointCount,
              hotspot.bboxDiagonalKm,
              hotspot.lastSeenYear,
              hotspot.distinctYears,
            ]);
          }
        }
        const insertBatches = async (
          rows: unknown[][],
          perRow: number,
          sql: (values: string) => string,
          casts: string[],
        ) => {
          const BATCH = 1000;
          for (let i = 0; i < rows.length; i += BATCH) {
            const batch = rows.slice(i, i + BATCH);
            const params = batch.flat();
            const values = batch
              .map(
                (_, r) =>
                  `(${Array.from({ length: perRow }, (__, k) => `$${r * perRow + k + 1}${casts[k] ?? ""}`).join(", ")})`,
              )
              .join(", ");
            await client.query(sql(values), params);
          }
        };
        await insertBatches(
          [...speciesRows.values()],
          7,
          (
            values,
          ) => `INSERT INTO region_species (region_id, species_id, local_frequency, is_vagrant, is_invasive, local_tier, weekly_frequency)
             VALUES ${values}
             ON CONFLICT (region_id, species_id) DO UPDATE SET
               local_frequency = EXCLUDED.local_frequency, is_vagrant = EXCLUDED.is_vagrant, is_invasive = EXCLUDED.is_invasive,
               local_tier = EXCLUDED.local_tier, weekly_frequency = EXCLUDED.weekly_frequency`,
          ["::uuid", "::uuid", "::numeric", "::boolean", "::boolean", "::text", "::int[]"],
        );
        written = speciesRows.size;
        await insertBatches(
          hotspotRows,
          8,
          (values) => `INSERT INTO region_species_hotspots
             (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km, last_seen_year, distinct_years)
             VALUES ${values}`,
          [
            "::uuid",
            "::uuid",
            "::double precision",
            "::double precision",
            "::int",
            "::double precision",
            "::int",
            "::int",
          ],
        );
        hotspotsWritten = hotspotRows.length;
        await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [province.id]);
        await client.query("COMMIT");
        console.log(
          `[compute-provinces-bulk]   ${province.name}: wrote ${written} species, ${hotspotsWritten} hotspot clusters`,
        );
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      // Let iNat decide final membership on top of the GBIF write above.
      await reconcileProvinceMembershipWithInat(province.id, province.name, ebirdRescuedNames);
    }
  }
  // No cleanup: cachedZipPath is the persistent GBIF cache.
}

// Lets iNaturalist Research Grade data decide final membership for one province:
//   1. Species iNat confirms but GBIF never recorded here are added, unrated.
//   2. Thinly-evidenced species iNat has no record of are dropped, unless resolveRemovalRescues
//      shows it's only a stale taxon-id mismatch.
// Does nothing when no iNat place resolves for the province.
async function reconcileProvinceMembershipWithInat(
  provinceId: string,
  provinceName: string,
  ebirdRescuedNames: string[] = [],
): Promise<void> {
  const inatMatch = await matchedSpeciesIdsForRegion(provinceId, provinceName);
  if (!inatMatch) return;
  const { matchedSpeciesIds, rawTaxonIds } = inatMatch;

  const existingRes = await pool.query<{ species_id: string; local_frequency: string | null }>(
    `SELECT species_id, local_frequency FROM region_species WHERE region_id = $1`,
    [provinceId],
  );
  const existingIds = new Set(existingRes.rows.map((r) => r.species_id));
  // Only species with thin GBIF evidence (below MIN_RECORDS) can be dropped for lacking iNat
  // confirmation; otherwise places few iNat users visit would lose most of their list.
  const wellEvidencedIds = new Set(
    existingRes.rows
      .filter((r) => r.local_frequency != null && Number(r.local_frequency) >= MIN_RECORDS)
      .map((r) => r.species_id),
  );
  // Birds on eBird's province list count as well-evidenced too.
  if (ebirdRescuedNames.length > 0) {
    const rescued = await pool.query<{ id: string }>(`SELECT id FROM species WHERE scientific_name = ANY($1)`, [
      ebirdRescuedNames,
    ]);
    for (const r of rescued.rows) wellEvidencedIds.add(r.id);
  }

  const removalCandidateIds = [...existingIds].filter((id) => !matchedSpeciesIds.has(id) && !wellEvidencedIds.has(id));
  let rescuedIds = new Set<string>();
  if (removalCandidateIds.length > 0) {
    const candidateRows = await pool.query<{ id: string; scientific_name: string }>(
      `SELECT id, scientific_name FROM species WHERE id = ANY($1::uuid[])`,
      [removalCandidateIds],
    );
    rescuedIds = await resolveRemovalRescues(candidateRows.rows, rawTaxonIds);
  }
  const toDrop = removalCandidateIds.filter((id) => !rescuedIds.has(id));
  const toAdd = [...matchedSpeciesIds].filter((id) => !existingIds.has(id));
  if (toDrop.length === 0 && toAdd.length === 0) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (toDrop.length > 0) {
      await client.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2::uuid[])`, [
        provinceId,
        toDrop,
      ]);
      await client.query(`DELETE FROM region_species_hotspots WHERE region_id = $1 AND species_id = ANY($2::uuid[])`, [
        provinceId,
        toDrop,
      ]);
    }
    for (const speciesId of toAdd) {
      await client.query(
        `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive)
         VALUES ($1, $2, false, false)
         ON CONFLICT (region_id, species_id) DO NOTHING`,
        [provinceId, speciesId],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  if (toDrop.length > 0 || toAdd.length > 0) {
    console.log(
      `[compute-provinces-bulk]   ${provinceName}: iNat membership reconcile - dropped ${toDrop.length} (no iNat confirmation), added ${toAdd.length} (iNat-only, unrated)`,
    );
  }
}

async function main() {
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countryNames = countriesArg ? countriesArg.split("=")[1].split(",") : PRIORITY_COUNTRIES;
  const apply = process.argv.includes("--apply");
  const refreshCache = process.argv.includes("--refresh-gbif-cache");
  const refreshAggregateCache = process.argv.includes("--refresh-aggregate-cache");
  const cacheOnly = process.argv.includes("--cache-only");

  const countries = await fetchAllCountries();
  const iso2ByName = new Map(countries.filter((c) => c.iso2).map((c) => [c.name, c.iso2!]));

  // --cache-only: download zips ahead of processing (used by refresh-all-provinces.ts), so
  // network waits overlap with the memory-heavy processing pass.
  if (cacheOnly) {
    // Drill down first so countries with zero provinces don't waste a download slot.
    await drillDownAllCountries(countryNames);
    const countryRowsRes = await pool.query<{ id: string; name: string }>(
      `SELECT r.id, r.name FROM regions r
       JOIN regions cont ON cont.id = r.parent_id
       JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
       WHERE r.name = ANY($1)`,
      [countryNames],
    );
    const countryIdByName = new Map(countryRowsRes.rows.map((r) => [r.name, r.id]));

    for (const name of countryNames) {
      const iso2 = iso2ByName.get(name);
      const countryId = countryIdByName.get(name);
      if (!iso2 || !countryId) continue;
      try {
        const provinces = await loadProvinces(countryId);
        if (provinces.length === 0) {
          console.log(
            `[compute-provinces-bulk] ${name}: no province rows found: skipping download (nothing would ever process it)`,
          );
          continue;
        }
        await ensureGbifZipCached(name, iso2, refreshCache);
      } catch (err) {
        // Best-effort: the processing pass downloads it itself if this fails.
        console.error(`[compute-provinces-bulk] cache-only prefetch failed for ${name}: ${(err as Error).message}`);
      }
    }
    await pool.end();
    return;
  }

  if (!apply) console.log(`[compute-provinces-bulk] DRY RUN: pass --apply to actually write region_species`);

  console.log(`[compute-provinces-bulk] ensuring provinces are drilled down for ${countryNames.length} countries...`);
  await drillDownAllCountries(countryNames);

  // Scoped to country-level regions (World > continent > country), since some country names
  // collide with other regions (Georgia the country vs. the US state).
  const countryRowsRes = await pool.query<{ id: string; name: string }>(
    `SELECT r.id, r.name FROM regions r
     JOIN regions cont ON cont.id = r.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
     WHERE r.name = ANY($1)`,
    [countryNames],
  );
  const countryIdByName = new Map(countryRowsRes.rows.map((r) => [r.name, r.id]));

  // One country's failure shouldn't stop the batch; failures are reported together at the end.
  const failed: string[] = [];
  for (const [i, name] of countryNames.entries()) {
    const iso2 = iso2ByName.get(name);
    const countryId = countryIdByName.get(name);
    if (!iso2 || !countryId) {
      console.log(
        `[compute-provinces-bulk] ${i + 1}/${countryNames.length} ${name}: no ISO2/region row match, skipping`,
      );
      continue;
    }
    console.log(`[compute-provinces-bulk] ${i + 1}/${countryNames.length} ${name} (${iso2})`);
    try {
      await computeCountryProvinces(name, iso2, countryId, apply, refreshCache, refreshAggregateCache);
    } catch (err) {
      console.error(`[compute-provinces-bulk] ${name}: FAILED: ${(err as Error).message}`);
      failed.push(name);
    }
  }

  if (failed.length > 0) {
    console.log(`[compute-provinces-bulk] done, with ${failed.length} failure(s): ${failed.join(", ")}`);
  } else {
    console.log(`[compute-provinces-bulk] done.`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
