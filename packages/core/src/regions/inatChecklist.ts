// Shared iNaturalist plumbing: resolve a region's iNat place and fetch its Research Grade species
// list. Used by the province rescue/reconcile passes and flag-vagrant-mismatch-inat.ts.
//
// Research Grade needs evidence and two agreeing identifiers, so it's a strong presence signal.
// Absence is weaker (hard-to-photograph species may never reach it), so it never excludes a
// well-evidenced species on its own.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";
import { bboxDiagonalDegrees, exteriorRingsFromGeometry, pointInAnyRing, ringBoundingBox } from "../lib/geometry.js";

// packages/data-pipeline/src/scripts -> the repo root.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

const INAT_PLACES_API = "https://api.inaturalist.org/v1/places";
const INAT_OBSERVATIONS_API = "https://api.inaturalist.org/v1/observations";
const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";
const INAT_USER_AGENT = "lifer-app/0.1 (personal project; region checklist verification)";

// Races the fetch against an independent timer, because AbortSignal.timeout() alone can fail to
// fire on a connection that goes silent.
export async function fetchWithHardTimeout(url: string, init: RequestInit, timeoutMs = 30_000): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`fetch timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
// Cached place lists younger than this are used as is. LIFER_INAT_OFFLINE=1 never calls iNat:
// a species it can't check from the cache is kept rather than removed.
const INAT_CACHE_MAX_AGE_MS = Number(process.env.LIFER_INAT_CACHE_MAX_AGE_DAYS ?? 90) * 24 * 60 * 60 * 1000;
const INAT_OFFLINE = process.env.LIFER_INAT_OFFLINE === "1";

const inatPlaceIdCache = new Map<string, Promise<number | null>>();
const inatResearchGradeTaxaCache = new Map<number, Promise<InatTaxon[] | null>>();
const inatCurrentTaxonIdCache = new Map<string, Promise<number | null>>();

// Shared ~1 request/sec pacing for all iNat calls here. Unpaced bursts get throttled hard, and
// retrying only adds load, so staying under the limit up front is faster overall.
const INAT_TAXA_REQUEST_INTERVAL_MS = 1000;
let lastInatTaxaRequestAt = 0;
async function paceInatTaxaRequest(): Promise<void> {
  const wait = lastInatTaxaRequestAt + INAT_TAXA_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastInatTaxaRequestAt = Date.now();
}

// Disk cache of each name's current iNat taxon id, including definite "none" answers, so
// re-runs never repeat a lookup that already came back with an answer.
const INAT_CURRENT_TAXON_CACHE_PATH = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-current-taxon-cache.json");
let inatCurrentTaxonDiskCache: Record<string, number | null> | null = null;

function loadInatCurrentTaxonDiskCache(): Record<string, number | null> {
  if (inatCurrentTaxonDiskCache) return inatCurrentTaxonDiskCache;
  if (existsSync(INAT_CURRENT_TAXON_CACHE_PATH)) {
    try {
      inatCurrentTaxonDiskCache = JSON.parse(readFileSync(INAT_CURRENT_TAXON_CACHE_PATH, "utf8")) as Record<
        string,
        number | null
      >;
      return inatCurrentTaxonDiskCache;
    } catch {
      // A corrupt file is treated as missing.
    }
  }
  inatCurrentTaxonDiskCache = {};
  return inatCurrentTaxonDiskCache;
}

function saveInatCurrentTaxonDiskCache(name: string, result: number | null): void {
  const cache = loadInatCurrentTaxonDiskCache();
  cache[name] = result;
  mkdirSync(path.dirname(INAT_CURRENT_TAXON_CACHE_PATH), { recursive: true });
  writeFileSync(INAT_CURRENT_TAXON_CACHE_PATH, JSON.stringify(cache));
}

interface InatPlaceCandidate {
  id: number;
  display_name: string;
  admin_level: number | null;
  ancestor_place_ids: number[] | null;
}

/** A province's iNaturalist place found by location when its name matches nothing (Natural
 *  Earth and iNaturalist spell and level provinces differently). Picks the largest level 10 or
 *  20 place under the country whose centre lies inside the province and whose size is at most a
 *  few times the province's. */
async function inatPlaceByLocation(regionId: string, countryInatPlaceId: number): Promise<number | null> {
  // Stored as a GeoJSON Feature; older rows may hold the bare geometry.
  const geo = await pool.query<{
    boundary_geojson: { type: string; coordinates?: unknown; geometry?: { type: string; coordinates: unknown } } | null;
  }>(`SELECT boundary_geojson FROM regions WHERE id = $1`, [regionId]);
  const stored = geo.rows[0]?.boundary_geojson;
  const geometry = stored?.geometry ?? (stored as { type: string; coordinates: unknown } | undefined);
  if (!geometry) return null;
  const rings = exteriorRingsFromGeometry(geometry);
  if (rings.length === 0) return null;
  const bbox = ringBoundingBox(rings.flat());
  const regionArea = Math.max(1e-6, (bbox.maxLon - bbox.minLon) * (bbox.maxLat - bbox.minLat));
  if (bboxDiagonalDegrees(bbox) > 60) return null; // an ocean-spanning outline, not a province
  let res: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    await paceInatTaxaRequest();
    res = await fetchWithHardTimeout(
      `${INAT_PLACES_API}/nearby?nelat=${bbox.maxLat}&nelng=${bbox.maxLon}&swlat=${bbox.minLat}&swlng=${bbox.minLon}&per_page=100`,
      { headers: { "User-Agent": INAT_USER_AGENT } },
    );
    if (res.ok || (res.status !== 429 && res.status < 500)) break;
    await new Promise((resolve) => setTimeout(resolve, 15_000 * (attempt + 1)));
  }
  if (!res || !res.ok) return null;
  const data = (await res.json()) as {
    results: { standard: Array<InatPlaceCandidate & { location?: string; bbox_area?: number }> };
  };
  const inside = data.results.standard.filter((p) => {
    if (p.admin_level !== 10 && p.admin_level !== 20) return false;
    if (!(p.ancestor_place_ids ?? []).includes(countryInatPlaceId) || !p.location || p.bbox_area == null) return false;
    const [lat, lon] = p.location.split(",").map(Number);
    return pointInAnyRing([lon, lat], rings) && p.bbox_area <= regionArea * 4;
  });
  inside.sort((a, b) => (b.bbox_area ?? 0) - (a.bbox_area ?? 0));
  return inside[0]?.id ?? null;
}

// Natural Earth region names are abbreviated ("Dem. Rep. Congo") or differ from iNaturalist's
// ("United States of America" is "United States" there).
const INAT_PLACE_NAME_ALIASES: Record<string, string> = {
  "United States of America": "United States",
  Turkey: "Türkiye",
  "Cabo Verde": "Cape Verde",
  "Timor-Leste": "East Timor",
  "U.S. Virgin Is.": "US Virgin Islands",
  "Faeroe Is.": "Faroe Islands",
  "St-Barthélemy": "Saint Barthélemy",
  "St-Martin": "Saint Martin",
  "S. Geo. and the Is.": "South Georgia and the South Sandwich Islands",
  "Fr. S. Antarctic Lands": "French Southern Territories",
  "U.S. Minor Outlying Is.": "United States Minor Outlying Islands",
  "Dem. Rep. Congo": "Democratic Republic of the Congo",
};
const NATURAL_EARTH_ABBREVIATIONS: Array<[RegExp, string]> = [
  // Before the single-letter rules, or "U.S." reads as "U.South".
  [/\bU\.S\./g, "United States"],
  [/\bDem\./g, "Democratic"],
  [/\bRep\./g, "Republic"],
  [/\bIs\./g, "Islands"],
  [/\bI\./g, "Island"],
  [/\bSt\./g, "Saint"],
  [/\bEq\./g, "Equatorial"],
  [/\bFr\./g, "French"],
  [/\bBr\./g, "British"],
  [/\bN\./g, "Northern"],
  [/\bS\./g, "South"],
  [/\bW\./g, "Western"],
  [/\bHerz\./g, "Herzegovina"],
  [/\bBarb\./g, "Barbuda"],
  [/\bVin\./g, "Vincent"],
  [/\bGren\./g, "the Grenadines"],
  [/\bTer\./g, "Territory"],
];

/** Names to search iNaturalist for, best first: a known alias, the name with its abbreviations
 *  spelled out, then the name itself. */
export function inatPlaceQueryNames(regionName: string): string[] {
  let expanded = regionName;
  for (const [re, full] of NATURAL_EARTH_ABBREVIATIONS) expanded = expanded.replace(re, full);
  return [...new Set([INAT_PLACE_NAME_ALIASES[regionName], expanded, regionName].filter((n): n is string => !!n))];
}

/** Resolves and caches (regions.inat_place_id) a region's iNaturalist place id on demand.
 * Filters on admin_level (0 = country, 10 = state/province) and, for provinces, requires the
 * country's place among ancestors, to avoid name collisions like Georgia. */
export async function resolveInatPlaceId(
  regionId: string,
  regionName: string,
  isCountry: boolean,
  countryInatPlaceId: number | null,
): Promise<number | null> {
  const cacheKey = regionId;
  if (!inatPlaceIdCache.has(cacheKey)) {
    inatPlaceIdCache.set(
      cacheKey,
      (async () => {
        const existing = await pool.query<{ inat_place_id: number | null }>(
          `SELECT inat_place_id FROM regions WHERE id = $1`,
          [regionId],
        );
        if (existing.rows[0]?.inat_place_id != null) return existing.rows[0].inat_place_id;
        for (const query of inatPlaceQueryNames(regionName)) {
          try {
            // A rate limit or server error isn't "no such place": wait and ask again.
            let res: Response | null = null;
            for (let attempt = 0; attempt < 4; attempt++) {
              await paceInatTaxaRequest();
              res = await fetchWithHardTimeout(
                `${INAT_PLACES_API}/autocomplete?q=${encodeURIComponent(query)}&per_page=20`,
                {
                  headers: { "User-Agent": INAT_USER_AGENT },
                },
              );
              if (res.ok || (res.status !== 429 && res.status < 500)) break;
              await new Promise((resolve) => setTimeout(resolve, 15_000 * (attempt + 1)));
            }
            if (!res || !res.ok) continue;
            const data = (await res.json()) as { results: InatPlaceCandidate[] };
            const wantLevel = isCountry ? 0 : 10;
            const candidates = data.results.filter(
              (p) =>
                p.admin_level === wantLevel &&
                (isCountry ||
                  (countryInatPlaceId != null && (p.ancestor_place_ids ?? []).includes(countryInatPlaceId))),
            );
            // Prefer an exact name match over the first fuzzy hit ("Samoa" vs "American Samoa").
            const match =
              candidates.find(
                (p) => p.display_name.split(",")[0].trim().toLowerCase() === query.trim().toLowerCase(),
              ) ?? candidates[0];
            if (!match) continue;
            await pool.query(`UPDATE regions SET inat_place_id = $1 WHERE id = $2`, [match.id, regionId]);
            return match.id;
          } catch {
            continue;
          }
        }
        if (!isCountry && countryInatPlaceId != null) {
          try {
            const byLocation = await inatPlaceByLocation(regionId, countryInatPlaceId);
            if (byLocation) {
              await pool.query(`UPDATE regions SET inat_place_id = $1 WHERE id = $2`, [byLocation, regionId]);
              return byLocation;
            }
          } catch {
            // fall through: no place
          }
        }
        return null;
      })(),
    );
  }
  return inatPlaceIdCache.get(cacheKey)!;
}

// Research Grade species_counts per place (500/page, iNat's max), disk-cached with counts. Lists
// older than LIFER_INAT_CACHE_MAX_AGE_DAYS are refetched in full, since counts drive tiers.
const INAT_SPECIES_COUNTS_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-species-counts-cache");

interface InatTaxon {
  id: number;
  name: string;
  /** Research-grade observations of it in the place: photographs, the basis of its tier. */
  count?: number;
  iconic?: string | null;
}

interface SpeciesCountsCacheFile {
  fetchedAt: string;
  taxa: InatTaxon[];
  /** Set once counts are stored; a list without them is refetched in full to get them. */
  withCounts?: boolean;
}

// Per-page retries, so a transient failure doesn't truncate a place's list.
const PAGE_FETCH_RETRIES = 4;

// iNat iconic taxa covering every Lifer taxon class. Without this filter plants, fungi and
// insects swamp the results and can hit the page cap before the species we track.
const RELEVANT_ICONIC_TAXA = ["Aves", "Mammalia", "Reptilia", "Amphibia", "Actinopterygii", "Mollusca", "Animalia"];
const ICONIC_TAXA_PARAM = RELEVANT_ICONIC_TAXA.map((t) => `&iconic_taxa[]=${t}`).join("");

async function fetchOnePage(placeId: number, page: number, extraParams: string): Promise<Response | null> {
  for (let attempt = 0; attempt < PAGE_FETCH_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt)); // 2s, 4s, 8s
    await paceInatTaxaRequest();
    try {
      const res = await fetchWithHardTimeout(
        `${INAT_OBSERVATIONS_API}/species_counts?place_id=${placeId}&quality_grade=research&verifiable=true&per_page=500&page=${page}${ICONIC_TAXA_PARAM}${extraParams}`,
        { headers: { "User-Agent": INAT_USER_AGENT } },
      );
      if (res.ok) return res;
    } catch {
      // timed out or network failure: retry
    }
  }
  return null;
}

async function fetchSpeciesCountsPages(placeId: number, extraParams: string): Promise<InatTaxon[] | null> {
  const taxa: InatTaxon[] = [];
  // Hard page cap (30,000 species) guards against looping forever on a bad response.
  for (let page = 1; page <= 60; page++) {
    const res = await fetchOnePage(placeId, page, extraParams);
    // A page that fails all retries fails the whole fetch, so a partial list is never cached
    // as if it were complete.
    if (!res) return null;
    const data = (await res.json()) as {
      total_results: number;
      results: Array<{ count: number; taxon: { id: number; name: string; iconic_taxon_name?: string | null } }>;
    };
    for (const r of data.results)
      taxa.push({ id: r.taxon.id, name: r.taxon.name, count: r.count, iconic: r.taxon.iconic_taxon_name ?? null });
    if (data.results.length < 500 || taxa.length >= data.total_results) break;
  }
  return taxa;
}

// One cache and one in-flight fetch per place, shared by the id-only and id-to-name callers.
async function fetchInatResearchGradeTaxaCached(placeId: number): Promise<InatTaxon[] | null> {
  if (!inatResearchGradeTaxaCache.has(placeId)) {
    inatResearchGradeTaxaCache.set(
      placeId,
      (async () => {
        mkdirSync(INAT_SPECIES_COUNTS_CACHE_DIR, { recursive: true });
        const cachePath = path.join(INAT_SPECIES_COUNTS_CACHE_DIR, `${placeId}.json`);
        const now = new Date().toISOString();

        // Unrecognised cache shapes are treated as absent and regenerated.
        const rawCached = existsSync(cachePath)
          ? (JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SpeciesCountsCacheFile> | number[])
          : null;
        if (rawCached && !Array.isArray(rawCached) && rawCached.fetchedAt && rawCached.taxa) {
          const cached = rawCached as SpeciesCountsCacheFile;
          if (INAT_OFFLINE || Date.now() - Date.parse(cached.fetchedAt) < INAT_CACHE_MAX_AGE_MS) return cached.taxa;
          // Too old: refetch in full, since counts change too.
          try {
            const fresh = await fetchSpeciesCountsPages(placeId, "");
            if (fresh == null) return cached.taxa; // failed: a stale list beats none
            writeFileSync(
              cachePath,
              JSON.stringify({ fetchedAt: now, taxa: fresh, withCounts: true } satisfies SpeciesCountsCacheFile),
            );
            return fresh;
          } catch {
            return cached.taxa;
          }
        }

        try {
          const taxa = await fetchSpeciesCountsPages(placeId, "");
          if (taxa == null) return null;
          writeFileSync(
            cachePath,
            JSON.stringify({ fetchedAt: now, taxa, withCounts: true } satisfies SpeciesCountsCacheFile),
          );
          return taxa;
        } catch {
          return null;
        }
      })(),
    );
  }
  return inatResearchGradeTaxaCache.get(placeId)!;
}

/** Refetches one place's list with observation counts unless its cache already has them.
 *  Returns false when the fetch failed (the old cache, if any, stays). */
export async function refreshPlaceCounts(placeId: number): Promise<boolean> {
  mkdirSync(INAT_SPECIES_COUNTS_CACHE_DIR, { recursive: true });
  const cachePath = path.join(INAT_SPECIES_COUNTS_CACHE_DIR, `${placeId}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SpeciesCountsCacheFile>;
    // Counts change, so a list older than the maximum age is fetched again.
    const fresh =
      INAT_OFFLINE || (cached.fetchedAt != null && Date.now() - Date.parse(cached.fetchedAt) < INAT_CACHE_MAX_AGE_MS);
    if (cached.withCounts && fresh) return true;
  }
  if (INAT_OFFLINE) return false;
  const taxa = await fetchSpeciesCountsPages(placeId, "");
  if (taxa == null) return false;
  writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), taxa, withCounts: true } satisfies SpeciesCountsCacheFile),
  );
  inatResearchGradeTaxaCache.delete(placeId);
  return true;
}

/** A place's cached research-grade counts by taxon id, with no network call; null when the cache
 *  has no counts yet. For rating tiers on photographs. */
export function cachedPlaceCounts(
  placeId: number,
): Map<number, { count: number; iconic: string | null; name: string }> | null {
  const cachePath = path.join(INAT_SPECIES_COUNTS_CACHE_DIR, `${placeId}.json`);
  if (!existsSync(cachePath)) return null;
  const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SpeciesCountsCacheFile>;
  if (!cached.withCounts || !cached.taxa) return null;
  return new Map(cached.taxa.map((t) => [t.id, { count: t.count ?? 0, iconic: t.iconic ?? null, name: t.name }]));
}

// iNaturalist's curated list of taxa introduced in a place. Status varies by place, so each
// place is asked on its own.
const INAT_INTRODUCED_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-introduced-cache");

/** Fetches a place's introduced taxa unless its cached list is younger than the maximum age.
 *  Returns false when the fetch failed (the old cache, if any, stays). */
export async function refreshPlaceIntroduced(placeId: number): Promise<boolean> {
  mkdirSync(INAT_INTRODUCED_CACHE_DIR, { recursive: true });
  const cachePath = path.join(INAT_INTRODUCED_CACHE_DIR, `${placeId}.json`);
  if (existsSync(cachePath)) {
    const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SpeciesCountsCacheFile>;
    if (INAT_OFFLINE || (cached.fetchedAt && Date.now() - Date.parse(cached.fetchedAt) < INAT_CACHE_MAX_AGE_MS))
      return true;
  }
  if (INAT_OFFLINE) return false;
  const taxa = await fetchSpeciesCountsPages(placeId, "&introduced=true");
  if (taxa == null) return false;
  writeFileSync(
    cachePath,
    JSON.stringify({ fetchedAt: new Date().toISOString(), taxa, withCounts: true } satisfies SpeciesCountsCacheFile),
  );
  return true;
}

/** A place's cached introduced taxa (id -> name and introduced-population observation count),
 *  with no network call; null when never fetched. A list includes taxa introduced anywhere
 *  inside the place, so callers compare the count with the taxon's total there. */
export function cachedPlaceIntroduced(placeId: number): Map<number, { name: string; count: number }> | null {
  const cachePath = path.join(INAT_INTRODUCED_CACHE_DIR, `${placeId}.json`);
  if (!existsSync(cachePath)) return null;
  const cached = JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SpeciesCountsCacheFile>;
  return cached.taxa ? new Map(cached.taxa.map((t) => [t.id, { name: t.name, count: t.count ?? 0 }])) : null;
}

export async function fetchInatResearchGradeTaxonIds(placeId: number): Promise<Set<number> | null> {
  const taxa = await fetchInatResearchGradeTaxaCached(placeId);
  return taxa ? new Set(taxa.map((t) => t.id)) : null;
}

/** id -> scientific name, for matching against species with no inat_taxon_id backfilled yet
 * (compute-provinces-inat.ts). */
export async function fetchInatResearchGradeTaxa(placeId: number): Promise<Map<number, string> | null> {
  const taxa = await fetchInatResearchGradeTaxaCached(placeId);
  return taxa ? new Map(taxa.map((t) => [t.id, t.name])) : null;
}

/** Resolves a possibly outdated scientific name to iNat's current active taxon id, using iNat's
 * former-name tracking (`is_active=any`). Requires matched_term to equal the searched name
 * exactly, to avoid unrelated fuzzy hits. Cached per name. */
export async function resolveCurrentInatTaxonId(scientificName: string): Promise<number | null> {
  const onDisk = loadInatCurrentTaxonDiskCache();
  if (Object.prototype.hasOwnProperty.call(onDisk, scientificName)) {
    return onDisk[scientificName];
  }
  if (!inatCurrentTaxonIdCache.has(scientificName)) {
    inatCurrentTaxonIdCache.set(
      scientificName,
      (async () => {
        // Only a successful response is cached. A transient failure must never be recorded as
        // "not found", or the species could be wrongly removed.
        for (let attempt = 0; attempt < PAGE_FETCH_RETRIES; attempt++) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
          await paceInatTaxaRequest();
          try {
            const res = await fetchWithHardTimeout(
              `${INAT_TAXA_API}?q=${encodeURIComponent(scientificName)}&per_page=10&is_active=any&rank=species`,
              { headers: { "User-Agent": INAT_USER_AGENT } },
            );
            if (!res.ok) continue;
            const data = (await res.json()) as {
              results: Array<{
                id: number;
                name: string;
                is_active: boolean;
                matched_term: string | null;
                rank: string;
              }>;
            };
            const exactMatches = data.results.filter(
              (r) => r.matched_term?.toLowerCase() === scientificName.toLowerCase(),
            );
            const result = exactMatches.find((r) => r.is_active)?.id ?? null;
            saveInatCurrentTaxonDiskCache(scientificName, result);
            return result;
          } catch {
            continue;
          }
        }
        return null;
      })(),
    );
  }
  return inatCurrentTaxonIdCache.get(scientificName)!;
}

/** Used to walk up from a region to its country (World -> continent -> country). */
interface RegionAncestryRow {
  id: string;
  name: string;
  parent_id: string | null;
  grandparent_name: string | null;
}

async function fetchRegionAncestryRow(id: string): Promise<RegionAncestryRow | null> {
  const res = await pool.query<RegionAncestryRow>(
    `SELECT r.id, r.name, r.parent_id, gp.name AS grandparent_name
     FROM regions r
     LEFT JOIN regions p ON p.id = r.parent_id
     LEFT JOIN regions gp ON gp.id = p.parent_id
     WHERE r.id = $1`,
    [id],
  );
  return res.rows[0] ?? null;
}

async function findCountryForRegion(regionId: string): Promise<{ id: string; name: string } | null> {
  let currentId: string | null = regionId;
  for (let hops = 0; hops < 10 && currentId; hops++) {
    const row = await fetchRegionAncestryRow(currentId);
    if (!row) return null;
    if (row.grandparent_name === "World") return { id: row.id, name: row.name };
    currentId = row.parent_id;
  }
  return null;
}

/** Catalog species iNaturalist Research Grade data places on a region's checklist. GBIF still
 * supplies occurrence data, but iNat decides membership. Null (not an empty set) when iNat data
 * can't be resolved, so callers keep their existing list. */
export interface RegionInatMatch {
  matchedSpeciesIds: Set<string>;
  /** Every Research Grade taxon id in the place, matched to our catalog or not, so
   * resolveRemovalRescues can spot species iNat has under a different taxon id. */
  rawTaxonIds: Set<number>;
}

export async function matchedSpeciesIdsForRegion(
  regionId: string,
  regionName: string,
): Promise<RegionInatMatch | null> {
  const country = await findCountryForRegion(regionId);
  if (!country) return null; // not a normal country/province (a continent, sea zone, World itself, ...)
  const isCountry = country.id === regionId;
  const countryPlaceId = await resolveInatPlaceId(country.id, country.name, true, null);
  const placeId = isCountry ? countryPlaceId : await resolveInatPlaceId(regionId, regionName, false, countryPlaceId);
  if (placeId == null) return null;

  const taxa = await fetchInatResearchGradeTaxa(placeId);
  if (!taxa || taxa.size === 0) return null;

  const matchedSpeciesIds = new Set<string>();
  const taxonIds = [...taxa.keys()];
  const byIdRes = await pool.query<{ id: string; inat_taxon_id: number }>(
    `SELECT id, inat_taxon_id FROM species WHERE inat_taxon_id = ANY($1) AND is_other_taxa = false`,
    [taxonIds],
  );
  const matchedTaxonIds = new Set<number>();
  for (const row of byIdRes.rows) {
    matchedSpeciesIds.add(row.id);
    matchedTaxonIds.add(row.inat_taxon_id);
  }

  // Same scientific-name fallback + inat_taxon_id backfill as compute-provinces-inat.ts, for
  // species that haven't been matched to an iNat taxon id yet.
  const unmatchedTaxa = [...taxa.entries()].filter(([id]) => !matchedTaxonIds.has(id));
  if (unmatchedTaxa.length > 0) {
    const names = unmatchedTaxa.map(([, name]) => name);
    const byNameRes = await pool.query<{ id: string; scientific_name: string }>(
      `SELECT id, scientific_name FROM species WHERE scientific_name = ANY($1) AND inat_taxon_id IS NULL AND is_other_taxa = false`,
      [names],
    );
    const idByName = new Map(unmatchedTaxa.map(([id, name]) => [name, id]));
    const matchedNames = new Set<string>();
    for (const row of byNameRes.rows) {
      const taxonId = idByName.get(row.scientific_name);
      matchedSpeciesIds.add(row.id);
      matchedNames.add(row.scientific_name);
      if (taxonId) await pool.query(`UPDATE species SET inat_taxon_id = $1 WHERE id = $2`, [taxonId, row.id]);
    }

    // Then by synonym, for species iNat renamed or split. The synonym's iNat id isn't stored on
    // the species, since it isn't that species' id.
    const stillUnmatched = names.filter((n) => !matchedNames.has(n));
    if (stillUnmatched.length > 0) {
      const bySynonymRes = await pool.query<{ species_id: string }>(
        `SELECT ss.species_id FROM species_synonyms ss JOIN species s ON s.id = ss.species_id
          WHERE ss.synonym_name = ANY($1) AND s.is_other_taxa = false`,
        [stillUnmatched],
      );
      for (const row of bySynonymRes.rows) matchedSpeciesIds.add(row.species_id);
    }
  }
  return { matchedSpeciesIds, rawTaxonIds: new Set(taxonIds) };
}

/** Before dropping species iNat doesn't confirm, checks whether each is only listed under an
 * outdated name. Returns the candidates that resolve to a taxon iNat has here (and backfills
 * their inat_taxon_id); everything else is safe to remove. */
export async function resolveRemovalRescues(
  candidates: Array<{ id: string; scientific_name: string }>,
  rawTaxonIds: Set<number>,
): Promise<Set<string>> {
  const rescued = new Set<string>();
  const onDisk = loadInatCurrentTaxonDiskCache();
  for (const candidate of candidates) {
    // Offline and never looked up: it can't be confirmed absent, so it stays.
    if (INAT_OFFLINE && !Object.prototype.hasOwnProperty.call(onDisk, candidate.scientific_name)) {
      rescued.add(candidate.id);
      continue;
    }
    const currentTaxonId = await resolveCurrentInatTaxonId(candidate.scientific_name);
    if (currentTaxonId != null && rawTaxonIds.has(currentTaxonId)) {
      rescued.add(candidate.id);
      await pool.query(`UPDATE species SET inat_taxon_id = $1 WHERE id = $2`, [currentTaxonId, candidate.id]);
    }
  }
  return rescued;
}
