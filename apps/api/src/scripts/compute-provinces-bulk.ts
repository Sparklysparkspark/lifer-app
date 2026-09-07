// Fully-automated province/state-level checklist computation: for each country in
// PRIORITY_COUNTRIES (in order), submits a GBIF SQL Download scoped to that single country
// (species/lat/lon/class/year/record_count — WITH coordinates, unlike the world-scale
// aggregated download compute-all-regions-bulk.ts used, which has no lat/lon and so can never
// answer a province-level question), polls until it's ready, downloads it, point-in-polygon
// matches every occurrence against that country's own province boundaries (same core logic as
// compute-us-states-from-bulk.ts, generalized to any country instead of hardcoded to the US),
// writes region_species + occurrence_computed_at per province, deletes the downloaded file, and
// moves on to the next country — no manual per-country download/extract/run cycle needed. This
// is the "download country data, parse it, compute it" path the live per-region GBIF API calls
// in compute-all-regions.ts were too rate-limited for (150/156 regions failed on 429 in that
// run — see its own comment).
//
// Requires GBIF_USER and GBIF_PWD env vars (a registered GBIF.org account — SQL downloads need
// authenticated requests, unlike simple occurrence search).
//
// Usage: npx tsx src/scripts/compute-provinces-bulk.ts [--countries=France,Germany] [--apply] [--refresh-gbif-cache] [--refresh-aggregate-cache]
// --refresh-aggregate-cache forces a fresh raw-GBIF-zip scan even if a cached point-matched
// aggregate exists (see PROVINCE_AGGREGATE_CACHE_DIR's own comment) — only needed after a
// province boundary re-drill-down changes the actual set of provinces for a country; a plain
// re-run (e.g. after tweaking scoring logic) reuses the cache automatically.
import {
  createWriteStream,
  createReadStream,
  mkdtempSync,
  rmSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { pool } from "../db.js";
import { fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import {
  exteriorRingsFromGeometry,
  ringBoundingBox,
  bboxDiagonalDegrees,
  pointInAnyRing,
  bboxesNear,
  type Point,
  type BoundingBox,
} from "data-pipeline/src/geometry.js";
import {
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  RECENT_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN,
  passesRecurrenceCheck,
  medianOf,
} from "data-pipeline/src/build/build-region-species.js";
import {
  percentileRankScores,
  tierForScore,
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_ABSOLUTE_TIER_THRESHOLDS,
  FISH_ABSOLUTE_TIER_THRESHOLDS,
} from "data-pipeline/src/build/compute-rarity-phase1.js";
import { drillDownAllCountries } from "./compute-all-regions.js";
import {
  EBIRD_SENSITIVE_SPECIES,
  weekInSeason,
  sensitiveRegionMatches,
  SENSITIVE_CLUSTER_DIAGONAL_KM,
} from "data-pipeline/src/sensitive-species.js";

// Same order as build-and-publish-all-packs.ts's own priority list — personally-relevant
// countries first, then a couple of continent representatives, so provinces for the countries
// that matter most get filled in before working through everyone else.
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

// Hotspot clustering only uses records of a living, current-sighting bird/mammal/fish — not a
// decades-old museum specimen, which isn't useful "go here today" trip-planning information
// regardless of privacy. This also closes most of the gap where a sensitive-but-unflagged
// species' specimen records could otherwise produce a precise cluster (see the plan's own
// Section D writeup) — eBird's own obscuring targets exactly this record type.
const LIVE_OBSERVATION_BASIS_OF_RECORD = new Set(["HUMAN_OBSERVATION", "OBSERVATION"]);

// Deliberately NOT trying to be a precise "go stand exactly here" tool — a fine-grained
// (~500m) grid + flood-fill merge was tried and reverted: it correctly followed real sighting
// shapes, but most observation data is genuinely scattered at that resolution (a birder's own
// backyard, one park visit), so it exploded into 280,000+ clusters for a single province, almost
// all of them a single incidental sighting rather than a real repeat-visited spot. More to the
// point, that precision isn't this feature's job at all: iNaturalist's own live heatmap already
// does "exactly where, right now" better than a static snapshot ever could (see the "See more
// recent sightings on iNaturalist" link on the map itself). What this data IS uniquely good at —
// and what a live per-species heatmap doesn't surface — is the PATTERN: is this species spread
// evenly across the whole region, or hyper-localized to one small corner of it (Sage Thrasher's
// whole Canadian range sitting in a few dozen km² of the South Okanagan, confirmed live).
// ~0.1° (~11km) is tuned for that — coarse enough to stay a manageable, glanceable handful of
// areas per species, fine enough to tell "concentrated in the Okanagan" apart from "found
// everywhere in the province."
const HOTSPOT_GRID_DEGREES = 0.1;
const KM_PER_DEGREE = 111; // equirectangular approximation, same tradeoff as geometry.ts's own bboxDiagonalDegrees

// eBird's real published sensitive-species list (the user pasted it in directly — see
// sensitive-species.ts's own comment). A point matching a species' real region/season scope gets
// collapsed into a fixed 20x20km-diagonal cluster centered on its actual occurrence centroid,
// matching eBird's own obscuring resolution — imported from sensitive-species.ts so the API layer
// (species/routes.ts, flagging a hotspot as sensitive for the UI note) checks against the exact
// same constant this writer used, not a second independently-computed copy. All other points get
// full-precision grid clustering with no record-count throttle.

const GBIF_API = "https://api.gbif.org/v1";

// Persists each country's raw downloaded occurrence zip instead of deleting it after use — the
// GBIF data itself doesn't change between runs, only the LOGIC computed from it does (local
// tier formula, hotspot clustering, weekly frequency all changed multiple times in one session),
// so re-downloading identical data from a rate-limited, slow (minutes per country), 3-concurrent-
// download-capped API every time the computation logic changes is pure waste. A cached country
// is re-parsed from disk in seconds instead. Pass --refresh-gbif-cache to force a fresh download
// for every targeted country (e.g. to pick up genuinely new occurrence records after enough time
// has passed) — otherwise an existing cache entry is trusted indefinitely.
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..", "..", "..", "..");
const GBIF_COUNTRY_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/gbif-country-cache");

// The per-country unzip-and-point-in-polygon-match scan below (building `perProvince`) is by far
// the expensive part of this script — a full pass over a country's entire cached GBIF zip, tens
// of millions of rows for a country like Canada or Australia. The interpretation step AFTER it
// (recurrence/vagrant checks, hotspot clustering, composite tier scoring) only ever touches this
// already-aggregated per-species data, never the raw rows — confirmed live: every scoring tweak
// this pipeline has gone through (recurrence floor, concentration ratio, nearest-vs-dominant
// hotspot pick) required zero changes to the scan itself, yet re-ran it in full every time,
// burning hours re-parsing/matching the exact same rows for the exact same result. This cache
// lets a scoring-only iteration skip straight to the cheap interpretation step. Invalidated
// purely by the cached zip's own mtime (a `--refresh-gbif-cache` re-download naturally busts it,
// since the zip's mtime changes) — NOT by anything about the provinces themselves, so a province
// boundary re-drill-down that changes the actual set of provinces for a country needs a manual
// `--refresh-aggregate-cache` (or just deleting the cache file) to avoid serving a stale match
// against an outdated province set. That's a rare, deliberate operation, not a routine one, so
// this doesn't try to auto-detect it.
const PROVINCE_AGGREGATE_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/province-aggregate-cache");

// One small TSV file per province, not one combined structure holding every province's matched
// points in memory at once — a real production OOM crash on the United States (19.6GB heap,
// crashed after 7.5 hours with zero output) confirmed the previous "hold perProvince: Map<
// provinceId, Map<species, entry>> for ALL provinces live for the whole scan, only free each
// one's memory after ITS OWN write" approach still isn't enough at the US's scale: freeing after
// write only helps once writing has started, and the scan phase alone accumulates every
// province's matched points before a single write happens. Writing each matched row straight to
// its own province's file as it's found means the scan phase itself never holds more than a
// handful of open file handles in memory — the interpretation step below then reads back and
// fully processes ONE province's own file at a time (bounded to that one province's data, same
// as any other country), never all of them simultaneously. Also doubles as this file's existing
// point-matched-aggregate cache (a re-run with unchanged scoring logic skips the raw GBIF scan
// entirely if a province's own partition file is already fresh) — no separate cache format needed.
function partitionFilePath(aggregateCacheKey: string, provinceId: string): string {
  return path.join(PROVINCE_AGGREGATE_CACHE_DIR, `${aggregateCacheKey}__${provinceId}.tsv`);
}

// Builds/updates one species' aggregate entry from a single matched occurrence row — shared by
// both the raw-scan-to-partition-file pass and the per-province partition-file replay pass below,
// so the exact same accumulation logic runs regardless of which one produced the row.
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

// One row per (species, lat, lon, class, year, week, basisofrecord) with a pre-aggregated
// record_count — grouping by raw coordinates barely compresses (near one row per unique point)
// but keeps the query itself well-formed SQL; scoped to a SINGLE country's occurrences this
// stays a tractable size (already proven for the US — see compute-us-states-from-bulk.ts's own
// comment on where this pattern came from), unlike the world-scale unaggregated attempt that hit
// 1.5 billion rows/42GB. week/basisofrecord added for the hotspot-clustering + weekly-frequency
// work below — validated against real Luxembourg data first (only 11%/16% more rows/bytes than
// the bare version), and eventdategte needs an explicit CAST to TIMESTAMP since GBIF's SQL
// engine resolves it as a raw BIGINT (epoch millis), not a DATETIME.
// GBIF's own per-account ceiling on simultaneous downloads, per its own 420 error message.
const MAX_CONCURRENT_GBIF_DOWNLOADS = 3;

// Confirms an actual free download slot with GBIF's own account state before submitting a new
// one, rather than optimistically submitting and reacting to a 420 after the fact with a blind
// fixed-length cooldown. This matters beyond just avoiding a wasted request: killing this
// script's local process does NOT cancel a download it already submitted server-side — GBIF
// keeps preparing it regardless (see submitDownload's own comment) — so a locally-restarted run
// has no way to know how many of its own past submissions are still occupying real slots unless
// it asks GBIF directly. A fixed cooldown just guesses that whatever caused the 420 has cleared
// by now; this asks instead. Both the main pool and the prefetcher call into this independently
// (separate processes, no shared local state) — correct because it's asking GBIF's own ground
// truth each time, not coordinating against a local guess that could itself be wrong.
async function waitForFreeDownloadSlot(): Promise<void> {
  const user = process.env.GBIF_USER;
  if (!user) return; // authHeader() below throws its own clearer error once we actually submit
  for (;;) {
    const res = await fetch(`${GBIF_API}/occurrence/download/user/${user}?limit=20`, {
      headers: { Authorization: authHeader() },
    });
    // Can't check right now (GBIF hiccup, network blip) — fall through and let the submit
    // attempt itself happen; its own 420 handling is still there as a fallback.
    if (!res.ok) return;
    const body = (await res.json()) as { results: Array<{ status: string }> };
    const active = body.results.filter((d) => d.status === "PREPARING" || d.status === "RUNNING").length;
    if (active < MAX_CONCURRENT_GBIF_DOWNLOADS) return;
    console.log(`[compute-provinces-bulk] ${active} GBIF download(s) already active for this account, waiting for a free slot...`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

// A 420 here means the account's 3-simultaneous-download slots are all occupied — despite the
// waitForFreeDownloadSlot check above, GBIF's own state can still change in the gap between
// that check and this request (another process's download finishing prep and immediately being
// replaced by a new submission, say). Previously this threw immediately on the very first 420,
// which turned a few minutes of real, temporary slot contention into dozens of spuriously
// "FAILED" countries needing a manual re-run — this re-asks GBIF for a free slot and retries
// instead of guessing a fixed wait is long enough, so a transient slot conflict resolves itself
// rather than needing babysitting.
// GBIF's raw `countrycode` field is the record's own overseas-territory code, not its parent
// sovereign country's — a bulk download scoped to a single countrycode structurally never sees
// these territories' real occurrence data, even though they're modeled here as ordinary provinces
// with their own boundary polygons (France's Guadeloupe/Guyane française/Martinique/La
// Réunion/Mayotte; Netherlands' Bonaire/Saba/St. Eustatius, which GBIF lumps under one shared
// code). Confirmed live: these provinces were coming back empty despite valid boundary_geojson.
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
      console.log(`[compute-provinces-bulk] download slots full (420) despite the free-slot check — re-checking...`);
      continue; // loops back to waitForFreeDownloadSlot() above, not a blind fixed-length wait
    }
    throw new Error(`GBIF download request failed: ${res.status} ${await res.text()}`);
  }
}

// Returns the download's own reported byte size once SUCCEEDED — downloadZip below verifies the
// actual streamed byte count against this, since a silently truncated fetch (confirmed possible:
// this is exactly what wiped Austria and Australia's province data on 2026-09-01 — the stream's
// reader reported `done` early with no thrown error, `unzip -p` then failed silently because its
// exit code was never checked, and the country was written to the DB with zero species and
// checkpointed as a success) would otherwise resolve as cleanly as a real completion.
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
    // @ts-expect-error Node's fetch Response.body is a web ReadableStream, not a Node stream —
    // pipe manually below instead of assuming .pipe() exists on it.
    const reader = res.body.getReader();
    async function pump(): Promise<void> {
      const { done, value } = await reader.read();
      if (done) {
        // `.end()` only SCHEDULES the final flush+close — it does not happen synchronously.
        // Resolving right after calling it (the previous bug here) let the caller start
        // reading/unzipping the file before the OS had actually finished writing the last
        // buffered chunk(s) to disk, which is exactly what corrupted Austria's and Australia's
        // downloads on 2026-09-01/02: the byte-count check below only counts bytes handed to
        // `.write()`, not bytes physically flushed, so it passed cleanly on a file that wasn't
        // actually complete on disk yet. Passing a callback to `.end()` waits for the stream's
        // own 'finish' event, which only fires once every byte is truly flushed.
        file.end(() => resolve());
        return;
      }
      bytesWritten += value.length;
      file.write(value);
      return pump();
    }
    pump().catch(reject);
  });
  // A truncated stream can resolve as `done` with no thrown error (see comment on
  // pollUntilReady above) — catch that here rather than silently unzipping a partial/corrupt
  // file, which `unzip -p` below would otherwise fail on without anyone checking its exit code.
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
}

async function loadProvinces(countryId: string): Promise<ProvinceRegion[]> {
  const res = await pool.query<{ id: string; name: string; boundary_geojson: { type: string; coordinates: unknown } }>(
    `SELECT id, name, boundary_geojson FROM regions WHERE parent_id = $1 AND boundary_geojson IS NOT NULL`,
    [countryId],
  );
  return res.rows.map((r) => {
    const geometry = (r.boundary_geojson as { geometry?: unknown }).geometry ?? r.boundary_geojson;
    const rings = exteriorRingsFromGeometry(geometry as { type: string; coordinates: unknown });
    const allPoints = rings.flat();
    return { id: r.id, name: r.name, rings, bbox: ringBoundingBox(allPoints) };
  });
}

// Math.max(...arr) blows the engine's call-stack/argument limit once arr gets into the hundreds
// of thousands — exactly what a widespread species' single province (or even a single grid
// cell) can hit for a country with Canada's occurrence volume. A plain loop has no such limit
// regardless of array size.
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
  // A cluster's own year range, distinct from the species-level `is_vagrant`/recurrence check —
  // a cluster built from records spread across many recent years reads very differently from one
  // built entirely from a single old sighting, even at identical point count. Real facts (not a
  // derived confidence score), same reasoning as this file's own eBird-sensitivity guardrail:
  // show what's true and let the user judge, don't invent a score that itself needs calibrating.
  lastSeenYear: number | null;
  distinctYears: number | null;
}

// A ~11km HOTSPOT_GRID_DEGREES cell reported via the plain average of every point inside it
// drifts toward whichever edge of the cell happens to have more scattered records — confirmed
// live against Cottonwood Island Park (Prince George): the reported centroid landed ~2km east of
// the park itself, pulled off by sightings scattered across the wider cell. Sub-binning at a
// finer resolution and reporting the densest sub-cell's own average — the actual spot where
// sightings piled up, not the geometric mean of a whole spread-out area — fixes this without
// changing what a "cluster" is (still the same ~11km cell for grouping/filtering purposes,
// only the reported point within it changes).
const HOTSPOT_PEAK_SUBCELL_DEGREES = 0.02; // ~2.2km — fine enough to separate "the park entrance" from "the parking lot 2km away", still coarse enough that real GPS noise/eBird checklist rounding doesn't fragment one real spot into several
function peakCentroid(cell: { lats: number[]; lons: number[]; weights: number[] }): { centroidLat: number; centroidLon: number } {
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

function summarizeSensitiveCluster(points: Array<{ lon: number; lat: number; weight: number; year: number | null }>): Hotspot {
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

// Snap-and-average grid binning (see HOTSPOT_GRID_DEGREES's own comment on why this instead of
// real DBSCAN, and why a flat grid is actually the right tool here, not a limitation to route
// around). Points where `isSensitivePoint` matches skip real clustering and collapse into one
// fixed-size 20x20km-diagonal cluster (see SENSITIVE_CLUSTER_DIAGONAL_KM's own comment) —
// per-point rather than per-species, so a species only sensitive in one region/season (see
// sensitive-species.ts) still gets real, precise clusters everywhere/everywhen else it's found.
// Takes parallel arrays (lons/lats/weights/years/weeks — see SpeciesProvinceEntry's own comment
// on why not one array of point objects), years/weeks using 0 as a "null" sentinel. Iterates by
// index and buckets each point into either the sensitive-cluster subset or its grid cell as it
// goes, rather than building an intermediate filtered array-of-objects the way this used to —
// the whole point of the parallel-array change upstream is not undoing it one function later.
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
  const cells = new Map<string, { lats: number[]; lons: number[]; weights: number[]; weight: number; years: number[] }>();
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

  // A cluster backed by only a point or two is one incidental sighting, not a real repeat-
  // visited area worth surfacing as its own entry in the list — dropped rather than shown.
  const MIN_CLUSTER_WEIGHT = 3;
  const filtered = [...cells.values()].filter((cell) => cell.weight >= MIN_CLUSTER_WEIGHT);

  // Confirmed live: a widely-distributed, heavily-recorded species in a large province can
  // legitimately populate dozens to hundreds of separate grid cells — real, not a bug, but not
  // useful either. A flat "top N by weight, province-wide" cap (the original fix here) solves
  // that but creates a NEW, worse problem for a big province: whichever single area has the most
  // raw records (a metro area's own huge birder volume) can fill every slot on its own, silently
  // erasing a real, substantial secondary area. Confirmed live: British Columbia's own top-20-
  // by-weight cut for Black-capped Chickadee had zero clusters anywhere near Prince George,
  // despite 186,663 real bird records and 294 species recorded within about a degree of it.
  //
  // A FIXED per-region cap has its own failure mode, also confirmed live: Prince George's own
  // area (a real, well-birded small city, not just one dominant metro competing against a whole
  // province) has 21 distinct real clusters for this same species, topped by Cottonwood Island
  // Park at 4,903 records — a flat cap of even 8-10 would still arbitrarily drop real, comparable
  // local spots just because the cap ran out, the same problem one level down. What actually
  // varies here isn't "how many good spots exist per unit area" (that's the whole point — a
  // richly-birded small city can have MORE distinct good spots than a much bigger but quieter
  // region), it's how much a candidate spot matters RELATIVE TO the other real spots already
  // found nearby. Kept via a relative-weight threshold instead of a fixed count: a cluster
  // survives if it's still a meaningful fraction of the BEST cluster in its own local area,
  // rather than competing for one of N arbitrary slots. A data-poor area naturally has few
  // qualifying clusters regardless (nothing to keep); a well-birded one gets to show every real
  // spot that's genuinely comparable to its own best, however many that turns out to be.
  const DIVERSITY_CELL_DEGREES = 0.5; // ~55km, roughly one city/metro's worth of area — small enough that a city's own real spots compete against each other, not against a whole region's worth of unrelated towns
  const MIN_RELATIVE_SHARE_OF_LOCAL_BEST = 0.05; // keep anything still >=5% of the best cluster in the same ~55km area
  const MAX_CLUSTERS_PER_DIVERSITY_CELL = 25; // a safety ceiling only, not the primary mechanism — never expected to bind in practice

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
    return sorted.filter((c) => c.cell.weight >= localBestWeight * MIN_RELATIVE_SHARE_OF_LOCAL_BEST).slice(0, MAX_CLUSTERS_PER_DIVERSITY_CELL);
  });

  return [
    ...sensitiveCluster,
    ...kept.map(({ cell, centroidLat, centroidLon }) => ({
      centroidLat,
      centroidLon,
      pointCount: cell.weight,
      bboxDiagonalKm: bboxDiagonalDegrees(ringBoundingBox(cell.lats.map((lat, i) => [cell.lons[i], lat] as Point))) * KM_PER_DEGREE,
      lastSeenYear: cell.years.length > 0 ? maxOf(cell.years) : null,
      distinctYears: cell.years.length > 0 ? new Set(cell.years).size : null,
    })),
  ];
}

// Guarantees this country's GBIF zip exists at GBIF_COUNTRY_CACHE_DIR/{iso2}.zip, submitting a
// fresh download only if it's missing (or --refresh-gbif-cache forces one). Split out from
// computeCountryProvinces so refresh-all-provinces.ts's download queue (--cache-only below) can
// run JUST this step, well ahead of and concurrently with the real per-country processing pass —
// the download wait (submit -> poll -> fetch, pure network I/O, negligible CPU/RAM) is the
// actual bottleneck for a country that's never been fetched before, and there's no reason to
// pay for it serially, back to back with the CPU/memory-heavy province processing that follows,
// when the two have completely different resource profiles. This is also the ONLY function that
// ever actually submits a download — waitForOrEnsureGbifZipCached below (what the real
// processing pass calls) only falls back to calling this directly as a last resort; the normal
// path is to let the dedicated download queue submit every download exactly once each.
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

// How long the real processing pass waits for refresh-all-provinces.ts's own download queue to
// produce this country's cached zip before giving up on it and submitting the download itself.
// The queue walks the exact same country list in the exact same order, at the FULL GBIF
// concurrency ceiling (3) and doing nothing but downloads — since it starts at the same point
// and is strictly faster per country than a full processing pass, it should always get there
// first in practice. This exists purely as a correctness backstop (a queue crash, a country it
// skipped for some reason), not the expected path — the whole reason to split "download" and
// "process" into separate roles is so the processing pool never submits a REDUNDANT duplicate
// download for a country the queue already has in flight.
// 60 minutes, not 20 — confirmed live that GBIF can leave an ordinary (non-huge) country's SQL
// download sitting in PREPARING for 20+ minutes with zero movement, no error, nothing actually
// wrong. Firing the fallback there wouldn't cancel the original — it can't, GBIF has no
// "abandon this download because a different process gave up waiting" concept — it would just
// submit a SECOND real download for the same country, burning a real slot on duplicate work and
// making the actual wait longer, not shorter. Better to simply wait longer for the one download
// that was always going to finish anyway.
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
    `[compute-provinces-bulk] ${countryName}: still not cached after waiting ${DOWNLOAD_QUEUE_WAIT_MS / 60_000}min on the download queue — submitting it directly instead`,
  );
  await ensureGbifZipCached(countryName, iso2, refreshCache);
}

// `pointBbox` tracks the running bounding box of every coordinate a species was recorded at
// within this province — reused to score the distribution-elusiveness boost (see
// compute-rarity-phase1.ts) directly from data this download already fetches, with no additional
// GBIF calls. A running min/max needs only those 4 numbers per species the whole time, rather
// than every individual [lon, lat] pair surviving in memory for the whole country's scan just to
// compute a bounding-box diagonal — for a country with Australia's occurrence volume, that's what
// OOM-crashed this script even at an 8GB heap. The cluster* fields are a separate, genuinely-
// needed point list restricted to LIVE_OBSERVATION_BASIS_OF_RECORD for the hotspot-clustering
// step (clustering needs the real spatial distribution, not just its bounding box, so this one
// can't be collapsed the same way) — filtered to a much smaller subset than the full occurrence
// stream, which was assumed to keep it safely below the same blowup risk. Confirmed live that
// assumption breaks down for a country with the US's occurrence volume: stored as one object
// per point (`{lon,lat,weight,year,week}`), tens of millions of live-observation records (the
// bulk of US citizen-science data) meant tens of millions of individual heap-allocated objects
// alive at once, which is what turned the scan into a GC-thrashing loop that ran for 25+ hours
// without ever finishing — the CPU was real, but almost none of it was forward progress. Five
// parallel plain-number arrays instead of one array of objects avoids that per-point object
// allocation entirely (V8 packs a pure-number array far more densely than an array of small
// objects). year/week use 0 as a "null" sentinel (real years are always > 1000, real weeks are
// 1-52) specifically so these two arrays also stay pure `number[]` rather than forcing a
// holey/tagged element kind just to carry the occasional null — `weekCounts` still accumulates
// every record (any basis of record — a temporal histogram at province granularity carries no
// location precision to guard, unlike the hotspot centroids).
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

// Species flagged as an escapee/introduced population IN THIS COUNTRY by the elusiveness
// crawl's geographic-distance check (compute-elusiveness.ts) — a country holding only a small,
// geographically implausible share of a species' total records (e.g. Black-Cheeked Lovebird
// cage-bird escapees in South Africa, native only to Zambia). Keyed by scientific_name, not
// species_id, since that's the join key already available in `included` below without an
// extra per-species DB lookup.
async function loadNonNativeSpeciesNames(iso3: string): Promise<Set<string>> {
  const res = await pool.query<{ scientific_name: string }>(
    `SELECT s.scientific_name FROM species_nonnative_countries snc
     JOIN species s ON s.id = snc.species_id
     WHERE snc.country_iso3 = $1`,
    [iso3],
  );
  return new Set(res.rows.map((r) => r.scientific_name));
}

// See region_species_manual_overrides' own migration comment — a verified answer from an
// authoritative outside source (range map, government status report) for one specific
// (region, species) pair, taking precedence over whatever the record-pattern check alone
// would have concluded. Loaded once per country (keyed by every province being scored) rather
// than per-species, since overrides are rare enough that one query up front is cheap and this
// avoids a per-species round trip inside the write loop below.
async function loadManualOverrides(
  provinceIds: string[],
): Promise<Map<string, Map<string, { isVagrant: boolean; isInvasive: boolean | null }>>> {
  const byProvince = new Map<string, Map<string, { isVagrant: boolean; isInvasive: boolean | null }>>();
  if (provinceIds.length === 0) return byProvince;
  const res = await pool.query<{ region_id: string; species_id: string; is_vagrant: boolean; is_invasive: boolean | null }>(
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
  const provinces = await loadProvinces(countryId);
  if (provinces.length === 0) {
    console.log(`[compute-provinces-bulk] ${countryName}: no province rows found (drill-down produced none) — skipping`);
    return;
  }

  const iso3 = (await fetchAllCountries()).find((c) => c.iso2 === iso2)?.iso3 ?? null;
  const nonNativeSpeciesNames = iso3 ? await loadNonNativeSpeciesNames(iso3) : new Set<string>();
  const manualOverridesByProvince = await loadManualOverrides(provinces.map((p) => p.id));

  await waitForOrEnsureGbifZipCached(countryName, iso2, refreshCache);
  console.log(`[compute-provinces-bulk] ${countryName}: tracking ${provinces.length} province(s), using cached GBIF data...`);
  const cachedZipPath = path.join(GBIF_COUNTRY_CACHE_DIR, `${iso2}.zip`);
  // NOT keyed by iso2 alone, unlike the raw GBIF zip above — confirmed live that Ashmore and
  // Cartier Is. and Australia share Natural Earth's "AU" code (Ashmore genuinely is an
  // Australian territory, so the raw GBIF data legitimately IS the same for both), but this
  // aggregate is the result of matching those raw points against ONE country's own specific
  // set of province boundaries — Ashmore's real 1-province scan and Australia's real
  // 11-province scan produce completely different aggregates from the same iso2. Keying this
  // by iso2 alone let whichever of the two ran first silently poison the other's cache: Ashmore
  // ran moments before Australia in the same pass, wrote its own (near-empty) aggregate to
  // what was nominally "AU.json," and Australia's own run then found that file already fresh
  // and reused it verbatim — every single Australian province wrote zero species as a result.
  const aggregateCacheKey = `${iso2}-${countryName.replace(/[^a-zA-Z0-9]+/g, "_")}`;
  const partitionPaths = new Map(provinces.map((p) => [p.id, partitionFilePath(aggregateCacheKey, p.id)] as const));
  const zipMtimeMs = statSync(cachedZipPath).mtimeMs;
  const allPartitionsFresh =
    !refreshAggregateCache &&
    [...partitionPaths.values()].every((p) => existsSync(p) && statSync(p).mtimeMs >= zipMtimeMs);

  if (allPartitionsFresh) {
    console.log(`[compute-provinces-bulk] ${countryName}: reusing cached point-matched partitions (skipping the raw GBIF scan)`);
  } else {
    // Single-threaded scan, inline on this thread — the worker_threads pool (still present in
    // provinceMatchWorker.ts) turned out to deadlock unpredictably under real load (confirmed
    // live: hung silently with zero CPU on two separate Canada runs, and OOM-crashed deserializing
    // a worker's result on a third), with the actual bug never pinned down. Given the goal here is
    // a checklist that's actually correct, not fast, this reverts to the simple, proven approach:
    // slower (single core), but it just works. Revisit the worker pool once someone has time to
    // properly root-cause the hang — don't re-enable it blind.
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
    // One write stream per province, open for the whole scan — a handful of file descriptors
    // and their own small internal buffers, nowhere near the memory cost of holding every
    // matched point for every province as live JS objects (see partitionFilePath's own comment
    // on the OOM this replaced). Matched rows are written straight through as they're found;
    // nothing about a row survives past this loop iteration.
    const writeStreams = new Map(provinces.map((p) => [p.id, createWriteStream(partitionPaths.get(p.id)!)] as const));

    const unzipProc = spawn("unzip", ["-p", cachedZipPath]);
    // Exit code was never checked before — a corrupt/truncated zip makes `unzip -p` print an
    // error to stderr (never surfaced; nothing reads that pipe) and emit nothing on stdout, which
    // the loop below couldn't tell apart from a country that legitimately has zero occurrences.
    // The byte-count check in downloadZip should catch a truncated download before this even
    // runs, but this stays as a second, independent guard against a zip that's corrupt for some
    // other reason.
    let unzipStderr = "";
    unzipProc.stderr.on("data", (chunk) => (unzipStderr += chunk));
    const rl = readline.createInterface({ input: unzipProc.stdout, crlfDelay: Infinity });
    let header: string[] | null = null;
    // Column positions looked up once from the header, not a fresh { [name]: value } object
    // built for every one of a country's 100M+ rows — a GBIF occurrence dump has 40-50+
    // columns, and most rows here are never anything this script tracks (insects, plants,
    // fungi, ...), so building the full row object before the class check even runs was
    // real, avoidable per-row cost paid on rows about to be thrown away immediately after.
    // Reading the handful of columns actually used, by index, and checking class FIRST (a
    // plain array read, not an object-property one) skips that construction for every row
    // that was going to be discarded anyway — same values, same filtering, just reordered so
    // the cheap check runs before the expensive one.
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
      const cls = cols[colIndex.class] ?? "";
      if (!BIRD_MAMMAL_CLASSES.has(cls) && !FISH_CLASSES.has(cls)) continue;
      const species = cols[colIndex.species];
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
        stream.write(`${species}\t${cls}\t${lon}\t${lat}\t${year ?? ""}\t${week ?? ""}\t${recordCount}\t${basisOfRecord}\n`);
      }
    }

    const unzipExit = await new Promise<number | null>((resolve) => unzipProc.on("close", resolve));
    if (unzipExit !== 0) {
      throw new Error(`unzip -p on ${cachedZipPath} exited ${unzipExit}: ${unzipStderr.trim()}`);
    }

    await Promise.all(
      [...writeStreams.values()].map(
        (stream) => new Promise<void>((resolve, reject) => stream.end((err?: Error | null) => (err ? reject(err) : resolve()))),
      ),
    );

    console.log(`[compute-provinces-bulk] ${countryName}: scanned ${rowCount.toLocaleString()} rows, ${matchedCount.toLocaleString()} matched a province`);
    console.log(`[compute-provinces-bulk] ${countryName}: cached point-matched partitions for future re-scoring runs`);
  }

  {
    const currentYear = new Date().getFullYear();
    for (const province of provinces) {
      // Read back and fully aggregate ONE province's own partition file here, at the top of
      // this loop iteration — not a shared structure populated for every province up front. Goes
      // out of scope (eligible for GC) the moment this iteration ends, so at most one province's
      // worth of matched points is ever live in memory at once, regardless of how many provinces
      // a country has or how large its raw GBIF data was.
      const bySpecies = await loadProvinceEntriesFromPartition(partitionPaths.get(province.id)!);
      const included: Array<{ species: string; recordCount: number; isVagrant: boolean }> = [];

      // Per-taxon-class baseline for the recurrence check's record-count floor (see
      // RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN's own comment) — birds and mammals have
      // wildly different volumes even within the same province, so each needs its own median,
      // computed ONLY from species that clear MIN_RECORDS outright (a real, unambiguous
      // "genuinely present here" population) rather than the raw candidate pool, which is mostly
      // noise (a single incidental record is enough to create a bySpecies entry at all).
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
        [...allTimeTotalByClass.entries()].map(([cls, totals]) => [cls, medianOf(totals) * RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN]),
      );

      for (const [species, { class: cls, years }] of bySpecies) {
        const yearCountArr = [...years.entries()].map(([year, count]) => ({ year, count }));
        const allTimeTotal = yearCountArr.reduce((sum, y) => sum + y.count, 0);

        const isNonNative = nonNativeSpeciesNames.has(species);
        if (FISH_CLASSES.has(cls)) {
          if (allTimeTotal < FISH_MIN_RECORDS) continue;
          included.push({ species, recordCount: allTimeTotal, isVagrant: isNonNative || allTimeTotal < FISH_VAGRANT_MIN_RECORDS });
          continue;
        }
        const recurrenceFloor = recurrenceFloorByClass.get(cls) ?? 0;
        const recentTotal = yearCountArr
          .filter((y) => y.year >= currentYear - RECENT_YEARS_WINDOW)
          .reduce((sum, y) => sum + y.count, 0);
        if (recentTotal >= MIN_RECORDS) {
          included.push({ species, recordCount: recentTotal, isVagrant: isNonNative || !passesRecurrenceCheck(yearCountArr, recurrenceFloor) });
          continue;
        }
        // A species that clears the bare "is there any real chance of finding this here"
        // floor but fails the recurrence PATTERN check used to still get dropped from the
        // checklist entirely, with no distinction from a species that was never here at
        // all — Mountain Beaver in British Columbia (a genuine, if hard-to-detect, resident)
        // and a genuine one-off vagrant burst look identical from here on: both have "some
        // real records, but the pattern doesn't prove recurrence." The difference between
        // them needs an authoritative outside source (a range map, a government status
        // report), not more GBIF record-counting — see region_species_manual_overrides. So
        // list it, flagged vagrant, rather than silently erase it — a real resident that
        // fails the pattern check is still findable and belongs on the list; an actual
        // vagrant is exactly what the vagrant flag exists to communicate.
        if (allTimeTotal >= RECURRENCE_ALLTIME_FLOOR) {
          included.push({ species, recordCount: allTimeTotal, isVagrant: isNonNative || !passesRecurrenceCheck(yearCountArr, recurrenceFloor) });
        }
      }

      console.log(`[compute-provinces-bulk]   ${province.name}: ${included.length} species pass inclusion (of ${bySpecies.size} candidates)`);
      if (!apply) continue;

      // Local tier: mirrors the GLOBAL tier logic exactly (apply-rarity-phase4.ts), just fed
      // this province's own data instead of world data — an absolute composite-value threshold,
      // not a percentile quota. The old version here ranked species purely by position among
      // this province's OTHER candidates, which meant a species only findable on one tiny island
      // could still get bumped down to "epic" just because some other species in the same
      // province ranked even more concentrated — diluting a real, absolute difficulty signal by
      // whoever else happened to share the dataset. Same failure mode the global composite's own
      // comment already warns against, just not caught here originally.
      //
      // Hotspot clusters computed once, upfront — reused both for the rangeScore below AND the
      // region_species_hotspots write further down, instead of clustering the same species'
      // points twice.
      const clustersBySpecies = new Map<string, Hotspot[]>();
      for (const c of included) {
        const entry = bySpecies.get(c.species)!;
        const scope = EBIRD_SENSITIVE_SPECIES.get(c.species);
        // Not sensitive at all -> never blur. Globally sensitive -> always blur, regardless of
        // this record's own region/season. Regionally sensitive -> only blur a point if THIS
        // province matches one of the listed regions, and (if that region has a season) the
        // point's own week falls inside it — see sensitive-species.ts's own comment on why the
        // old flat "sensitive everywhere, always" behavior was a real, confirmed bug.
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
          clusterHotspots(entry.clusterLons, entry.clusterLats, entry.clusterWeights, entry.clusterYears, entry.clusterWeeks, isSensitivePoint),
        );
      }

      // rangeScore mirrors global rangeScore (small range -> high score): here "range" is how
      // concentrated each species' own points are relative to the whole province's bounding box
      // (reusing the `points` this download already collected, no extra GBIF calls) rather than
      // a global range-size figure. abundanceScore mirrors global's IUCN-modifier abundance axis
      // (no per-province IUCN data exists, so record-count rank is the closest analog: fewer
      // records here -> higher score, same "how easy to detect HERE" signal as before). Both are
      // percentile RANKS (0-1 sub-scores, exactly how global's own rangeScore is built too — see
      // percentileRankScores' own comment), only the FINAL tier assignment changes: compare the
      // resulting composite against the same taxon-calibrated absolute thresholds used globally,
      // instead of re-ranking it into yet another percentile.
      //
      // Range excludes only genuine OUTLIER clusters — both small AND geographically isolated
      // from the species' main cluster group — not just "small." A first version tried a flat
      // "keep whichever clusters hold >=80% of records" rule; confirmed live in British Columbia
      // that this broke badly for widespread species like House Sparrow, which has 366 small
      // population clusters spread right across the province (one per town/city) where only 18
      // (the biggest cities) happen to hold 80% of records — that's just where more birders
      // live, not where the species doesn't occur, and the 80% rule wrongly shrank its "range"
      // from ~82% of BC's diagonal down to ~20%. Sage Thrasher's real case is different in kind,
      // not just degree: a small (~7%) cluster near the Fraser Valley sits FAR from its actual
      // Okanagan stronghold — a genuine isolated vagrant record, not one of many real population
      // centers. Testing both "small AND far from the rest" catches Sage Thrasher's real outlier
      // while leaving House Sparrow's many small-but-contiguous town clusters alone (none of them
      // is a distance outlier relative to the others, even though each is individually small).
      const OUTLIER_MAX_SHARE = 0.1;
      const OUTLIER_DISTANCE_STD_DEVS = 2.5;
      function coreRangeDiagonalKm(clusters: Hotspot[]): number {
        if (clusters.length <= 1) return clusters[0]?.bboxDiagonalKm ?? 0;
        const total = clusters.reduce((sum, cl) => sum + cl.pointCount, 0);
        const centroidLat = clusters.reduce((sum, cl) => sum + cl.centroidLat * cl.pointCount, 0) / total;
        const centroidLon = clusters.reduce((sum, cl) => sum + cl.centroidLon * cl.pointCount, 0) / total;
        // Equirectangular approx (same tradeoff as bboxDiagonalDegrees) — fine at province scale,
        // and longitude degrees narrow with latitude so scale them by cos(latitude) or two
        // clusters at the same longitude-degree offset but different latitudes would compare as
        // equally far apart regardless of how close together they actually are near the poles.
        const lonScale = Math.cos((centroidLat * Math.PI) / 180);
        const distanceKm = (cl: Hotspot) =>
          Math.sqrt((cl.centroidLat - centroidLat) ** 2 + ((cl.centroidLon - centroidLon) * lonScale) ** 2) * KM_PER_DEGREE;
        const meanDistanceKm = clusters.reduce((sum, cl) => sum + distanceKm(cl) * cl.pointCount, 0) / total;
        const stdDevKm = Math.sqrt(clusters.reduce((sum, cl) => sum + (distanceKm(cl) - meanDistanceKm) ** 2 * cl.pointCount, 0) / total);

        const core = clusters.filter((cl) => {
          const isSmall = cl.pointCount / total <= OUTLIER_MAX_SHARE;
          const isFar = stdDevKm > 0 && distanceKm(cl) > meanDistanceKm + OUTLIER_DISTANCE_STD_DEVS * stdDevKm;
          return !(isSmall && isFar);
        });
        // A species where EVERY cluster somehow qualified as an outlier (shouldn't happen —
        // the single largest cluster alone is never "small") falls back to the full set rather
        // than computing a range off zero clusters.
        const effective = core.length > 0 ? core : clusters;
        if (effective.length === 1) return effective[0].bboxDiagonalKm;
        const centroidSpanKm =
          bboxDiagonalDegrees(ringBoundingBox(effective.map((cl) => [cl.centroidLon, cl.centroidLat] as Point))) * KM_PER_DEGREE;
        const maxClusterRadiusKm = maxOf(effective.map((cl) => cl.bboxDiagonalKm / 2));
        return centroidSpanKm + maxClusterRadiusKm * 2;
      }

      // PROVINCE_RANGE_ABUNDANCE_WEIGHTS is a deliberately even split, NOT a copy of global's
      // WEIGHTS/MAMMAL_WEIGHTS/FISH_WEIGHTS — this scope only ever has these two axes available
      // (no elusiveness data exists in this bulk SQL pipeline), and neither axis's real quality
      // differs by taxon at this level the way IUCN coverage or behavioral data does globally, so
      // there's no basis yet to split it further by taxon here. Also, a single province's sample
      // is far smaller/noisier than the full global dataset, so even where global's per-taxon
      // splits exist, they don't necessarily transfer to this scope unchanged. This is an interim
      // value pending real anchor-species calibration once this recompute provides actual data to
      // check it against (tracked as a follow-up task) — not a validated, final split.
      const PROVINCE_RANGE_ABUNDANCE_WEIGHTS = { range: 0.5, abundance: 0.5 };
      const regionDiagonalKm = bboxDiagonalDegrees(province.bbox) * KM_PER_DEGREE;
      // Species with zero hotspot clusters (every one of their records had a basis_of_record
      // outside LIVE_OBSERVATION_BASIS_OF_RECORD — rare but possible) are left OUT of the
      // percentile ranking entirely, not given a ratio of 0 — a ratio of 0 reads as "perfectly
      // concentrated," the single best possible rangeScore, which is backwards for "no
      // information available." spreadScoreByIdx's own `?? 0.5` fallback below already handles
      // an idx with no entry here by defaulting to neutral.
      const spreadRatioEntries = included.flatMap((c, idx) => {
        const clusters = clustersBySpecies.get(c.species) ?? [];
        if (clusters.length === 0) return [];
        return [{ idx, value: regionDiagonalKm > 0 ? coreRangeDiagonalKm(clusters) / regionDiagonalKm : 0 }];
      });
      const spreadScoreByIdx = percentileRankScores(spreadRatioEntries);
      const baseScoreByIdx = percentileRankScores(included.map((c, idx) => ({ idx, value: c.recordCount })));

      // Confirmed live: Alagoas, Brazil has ~86,000 total bird records across its whole
      // checklist versus British Columbia's 22 MILLION — a ~250x difference in reporting
      // volume. With that few total records, one species' own count is noisy enough that
      // percentile rank alone can swing it toward a falsely extreme tier (Rock Pigeon reading
      // "rare" there isn't a real fact, unlike a genuinely sparse population — it's small-
      // sample noise). Composite scores in a thin-data taxon+province are pulled toward each
      // taxon's own "uncommon" threshold (a deliberately unremarkable, conservative default —
      // taxon-specific since fish/mammal/bird threshold scales aren't comparable) rather than
      // trusted at full strength; a region with abundant data (>=1M total records for this
      // taxon here) is unaffected.
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
        const rangeScore = spreadScoreByIdx.get(idx) ?? 0.5;
        const abundanceScore = baseScoreByIdx.get(idx) ?? 0.5;
        const rawComposite =
          PROVINCE_RANGE_ABUNDANCE_WEIGHTS.range * rangeScore + PROVINCE_RANGE_ABUNDANCE_WEIGHTS.abundance * abundanceScore;
        const cls = bySpecies.get(c.species)!.class;
        const thresholds = FISH_CLASSES.has(cls)
          ? FISH_ABSOLUTE_TIER_THRESHOLDS
          : cls === "Mammalia"
            ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS
            : BIRD_ABSOLUTE_TIER_THRESHOLDS;
        const confidence = confidenceFromTotalRecords(totalRecordsByClass.get(cls) ?? 0);
        const neutralAnchor = thresholds.find((t) => t.tier === "uncommon")!.minScore;
        const composite = confidence * rawComposite + (1 - confidence) * neutralAnchor;
        localTierBySpecies.set(c.species, tierForScore(composite, thresholds));
      });
      // Same floor-AND-ceiling rule as the live per-region computation (regions/routes.ts) —
      // see its own comment on LOCAL_TIER_GLOBAL_CEILING_STEPS for why a globally common
      // species (e.g. Mallard) needs a ceiling too, not just a floor, to stop it swinging all
      // the way to "legendary" from thin-data noise in one under-birded province.
      const LOCAL_TIER_GLOBAL_FLOOR_STEPS = 1;
      const LOCAL_TIER_GLOBAL_CEILING_STEPS = 2;
      const TIER_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];
      const globalTierRes = await pool.query<{ scientific_name: string; tier: string }>(
        `SELECT scientific_name, tier FROM species s JOIN species_rarity r ON r.species_id = s.id WHERE s.scientific_name = ANY($1)`,
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

      // A plain `await pool.connect()` here previously hung forever with zero CPU and zero log
      // output when a connection never became available (observed live during a Canada run
      // alongside several other long-running scripts sharing the same Postgres instance) —
      // completely indistinguishable from a real deadlock elsewhere in the worker-thread code
      // until the process was killed and inspected. A timeout turns that silent hang into a
      // loud, immediate failure instead.
      const client = await Promise.race([
        pool.connect(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`pool.connect() timed out acquiring a client for ${province.name}`)), 30_000),
        ),
      ]);
      try {
        await client.query("BEGIN");
        await client.query(`DELETE FROM region_species WHERE region_id = $1`, [province.id]);
        await client.query(`DELETE FROM region_species_hotspots WHERE region_id = $1`, [province.id]);
        let written = 0;
        let hotspotsWritten = 0;
        for (const c of included) {
          // GBIF's bulk download reports whatever scientific name its OWN current taxonomic
          // backbone uses, which drifts from our catalog's scientific_name after a genus
          // reclassification (Oceanodroma furcata -> Hydrobates furcatus, Haemorhous cassinii
          // -> Carpodacus cassinii, ...) — confirmed live: this silently dropped Fork-Tailed
          // and Leach's Storm-Petrel entirely from British Columbia's checklist (147 and 85
          // real records respectively) with no error, no vagrant flag, nothing — the species
          // just never got as far as an INSERT. species_synonyms exists for exactly this
          // ("kept so name-based matching against external data ... still resolves to the
          // right species," see its own migration comment) but this lookup never consulted
          // it. Falls back to it here rather than only matching the catalog's own current name.
          const speciesRes = await client.query<{ id: string }>(
            `SELECT id FROM species WHERE scientific_name = $1
             UNION
             SELECT species_id AS id FROM species_synonyms WHERE synonym_name = $1
             LIMIT 1`,
            [c.species],
          );
          const speciesId = speciesRes.rows[0]?.id;
          if (!speciesId) continue;

          // See loadManualOverrides' own comment — a verified answer from an authoritative
          // outside source for this exact (region, species) pair beats the record-pattern
          // check's own conclusion. is_invasive has no algorithmic signal at all (see its own
          // migration comment) — it only ever comes from a manual override, defaulting to false.
          const override = manualOverridesByProvince.get(province.id)?.get(speciesId);
          const isVagrant = override?.isVagrant ?? c.isVagrant;
          const isInvasive = override?.isInvasive ?? false;

          // 1-indexed ISO week -> 0-indexed array slot, same convention as region_species.seasonality.
          const entry = bySpecies.get(c.species)!;
          const weeklyFrequency = Array.from({ length: 52 }, (_, i) => entry.weekCounts.get(i + 1) ?? 0);
          const hasWeeklyData = weeklyFrequency.some((v) => v > 0);

          await client.query(
            `INSERT INTO region_species (region_id, species_id, local_frequency, is_vagrant, is_invasive, local_tier, weekly_frequency)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (region_id, species_id) DO UPDATE SET
               local_frequency = EXCLUDED.local_frequency, is_vagrant = EXCLUDED.is_vagrant, is_invasive = EXCLUDED.is_invasive,
               local_tier = EXCLUDED.local_tier, weekly_frequency = EXCLUDED.weekly_frequency`,
            [
              province.id,
              speciesId,
              c.recordCount,
              isVagrant,
              isInvasive,
              localTierBySpecies.get(c.species) ?? null,
              hasWeeklyData ? weeklyFrequency : null,
            ],
          );
          written++;

          for (const hotspot of clustersBySpecies.get(c.species) ?? []) {
            await client.query(
              `INSERT INTO region_species_hotspots
                 (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km, last_seen_year, distinct_years)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                province.id,
                speciesId,
                hotspot.centroidLat,
                hotspot.centroidLon,
                hotspot.pointCount,
                hotspot.bboxDiagonalKm,
                hotspot.lastSeenYear,
                hotspot.distinctYears,
              ],
            );
            hotspotsWritten++;
          }
        }
        await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [province.id]);
        await client.query("COMMIT");
        console.log(`[compute-provinces-bulk]   ${province.name}: wrote ${written} species, ${hotspotsWritten} hotspot clusters`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      // No explicit cleanup needed here — bySpecies was built fresh from this province's own
      // partition file at the top of this iteration (see loadProvinceEntriesFromPartition's own
      // comment) and never shared with any other province, so it's simply eligible for GC the
      // moment the next iteration reassigns it.
    }
  }
  // Deliberately no cleanup here — cachedZipPath is the persistent GBIF cache (see
  // GBIF_COUNTRY_CACHE_DIR's own comment), not a scratch download; ensureGbifZipCached above is
  // the only thing that ever writes to it, and only ever via its own temp workDir, which it
  // already cleans up itself.
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

  // Prefetch mode — refresh-all-provinces.ts's own prefetcher runs this well ahead of (and
  // concurrently with) the real processing pass below, for exactly one reason: guaranteeing a
  // country's zip is cached is pure network wait with negligible CPU/RAM, while the processing
  // pass is memory-heavy and deliberately serialized (see that file's own concurrency comment).
  // Running the two back to back for every country that's never been downloaded pays for both
  // waits in sequence; running this ahead of time overlaps the download wait with whatever the
  // main pass is busy processing instead.
  if (cacheOnly) {
    // Drill-down + province check still happen here (unlike the original version of this mode,
    // which skipped both "for speed") — confirmed live that skipping them wasted a real GBIF
    // download slot on Antarctica (zero provinces, always skipped by the real processing pass
    // below) not once but twice across restarts, since nothing here knew it was pointless before
    // downloading it anyway. Drill-down is idempotent and a fast no-op for anything already
    // drilled down, so this costs little for the common case while avoiding a wasted download
    // for the zero-province case.
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
          console.log(`[compute-provinces-bulk] ${name}: no province rows found — skipping download (nothing would ever process it)`);
          continue;
        }
        await ensureGbifZipCached(name, iso2, refreshCache);
      } catch (err) {
        // Best-effort only — a failed prefetch just means the real processing pass pays for the
        // download itself later, exactly as if this prefetcher didn't exist. Never worth
        // retrying or surfacing as a failure in its own right.
        console.error(`[compute-provinces-bulk] cache-only prefetch failed for ${name}: ${(err as Error).message}`);
      }
    }
    await pool.end();
    return;
  }

  if (!apply) console.log(`[compute-provinces-bulk] DRY RUN — pass --apply to actually write region_species`);

  console.log(`[compute-provinces-bulk] ensuring provinces are drilled down for ${countryNames.length} countries...`);
  await drillDownAllCountries(countryNames);

  // Scoped to country-level regions (a direct child of a continent, which is itself a direct
  // child of World) — a bare `name = ANY($1)` match, tried first, silently grabbed the WRONG
  // region whenever a country's name collides with some other region elsewhere in the tree
  // (confirmed live: "Georgia" matches both the real Caucasus country AND the US state of the
  // same name; the JS Map below keeps whichever row Postgres happened to return last, with no
  // ordering guarantee). That picked the US state's id for a run targeting the country, which
  // then found zero matching provinces under it, logged "skipping," and exited 0 — checkpointed
  // as a real success in refresh-all-provinces.ts despite writing nothing for the actual
  // country. Same scoping refresh-all-provinces.ts's own country-listing query already uses.
  const countryRowsRes = await pool.query<{ id: string; name: string }>(
    `SELECT r.id, r.name FROM regions r
     JOIN regions cont ON cont.id = r.parent_id
     JOIN regions w ON w.id = cont.parent_id AND w.name = 'World'
     WHERE r.name = ANY($1)`,
    [countryNames],
  );
  const countryIdByName = new Map(countryRowsRes.rows.map((r) => [r.name, r.id]));

  // One country's failure (a truncated GBIF download, a transient network error, GBIF's own
  // download API hiccuping) used to take the ENTIRE batch down with it — confirmed live: a
  // truncated Costa Rica download threw out of computeCountryProvinces, propagated past this
  // loop uncaught, and silently killed a multi-country run partway through, leaving every
  // country after it (regardless of how unrelated to the actual failure) never even attempted.
  // Catching per-country and continuing means one bad download costs exactly that one country,
  // not the rest of a long batch — failures are collected and reported in one place at the end
  // instead of being individually easy to miss in a long scrolling log.
  const failed: string[] = [];
  for (const [i, name] of countryNames.entries()) {
    const iso2 = iso2ByName.get(name);
    const countryId = countryIdByName.get(name);
    if (!iso2 || !countryId) {
      console.log(`[compute-provinces-bulk] ${i + 1}/${countryNames.length} ${name}: no ISO2/region row match, skipping`);
      continue;
    }
    console.log(`[compute-provinces-bulk] ${i + 1}/${countryNames.length} ${name} (${iso2})`);
    try {
      await computeCountryProvinces(name, iso2, countryId, apply, refreshCache, refreshAggregateCache);
    } catch (err) {
      console.error(`[compute-provinces-bulk] ${name}: FAILED — ${(err as Error).message}`);
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
