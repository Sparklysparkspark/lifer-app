// Shared by compute-provinces-bulk.ts (the rescue pass) and flag-vagrant-mismatch-inat.ts (the
// reverse check) — both need the same "resolve this region's iNaturalist place, fetch its
// Research Grade species list" plumbing, just used in opposite directions (rescue a species
// GBIF's own pattern check excluded, vs. flag one GBIF included that iNaturalist has never
// documented here).
//
// Research Grade specifically, not any observation: it requires photo/sound evidence, a
// date+location, a community not-captive/cultivated determination, AND at least two independent
// identifiers agreeing on the species-level ID — a real quality bar, not just "someone submitted
// this." That makes it a meaningfully stronger signal than eBird's own bare presence check (an
// eBird checklist entry for a common species gets zero review; only unusual reports trigger
// expert review) or a single raw GBIF record. Still one-directional in the rescue direction
// though: a real, hard-to-photograph species can genuinely fail to reach two agreeing IDs, so
// ABSENCE from Research Grade is never used to silently exclude anything automatically — see
// flag-vagrant-mismatch-inat.ts for how that absence is instead surfaced for human/web
// verification.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "../db.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");

const INAT_PLACES_API = "https://api.inaturalist.org/v1/places";
const INAT_OBSERVATIONS_API = "https://api.inaturalist.org/v1/observations";
const INAT_TAXA_API = "https://api.inaturalist.org/v1/taxa";
const INAT_USER_AGENT = "lifer-app/0.1 (personal project; region checklist verification)";

// AbortSignal.timeout() alone proved not to be a reliable backstop -- confirmed live: a
// flag-nonnative-obscure-taxa.ts run stalled on a handful of its last few hundred species for
// many minutes with near-zero CPU, an established-but-silent iNat connection, and no timeout
// ever firing, in the exact same way a GBIF backbone fetch elsewhere in this codebase did
// (see data-pipeline's fetch-with-retry.ts for that investigation). Racing the fetch against
// an independent timeout promise, instead of trusting fetch() to honor the abort signal, means
// every caller here moves on and retries even in whatever edge case leaves that signal inert.
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
const inatPlaceIdCache = new Map<string, Promise<number | null>>();
const inatResearchGradeTaxaCache = new Map<number, Promise<InatTaxon[] | null>>();
const inatCurrentTaxonIdCache = new Map<string, Promise<number | null>>();

// Confirmed live: a burst of resolveCurrentInatTaxonId calls fired back-to-back (no pacing)
// starts fast, then degrades hard — 50 requests in 2.4s, but the NEXT 50 took 35s, worsening as
// it went. Retries-with-backoff don't fix this, they make it worse: every throttled request
// adds MORE load to an already-rate-limited window. A small fixed delay BEFORE every request
// keeps this comfortably under iNat's limit from the start, so it never has to recover from
// throttling at all — a predictable ~1 req/sec instead of a bursty, then-crawling mess.
const INAT_TAXA_REQUEST_INTERVAL_MS = 1000;
let lastInatTaxaRequestAt = 0;
async function paceInatTaxaRequest(): Promise<void> {
  const wait = lastInatTaxaRequestAt + INAT_TAXA_REQUEST_INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastInatTaxaRequestAt = Date.now();
}

// A species name's current iNat taxon id (or the confirmed fact that it has none) is the same
// answer no matter which region asks, or how many times — disk-persisted so a re-run (a resumed
// reconcile pass, or the same country re-checked later) never redoes a lookup that already came
// back with a definite answer, success OR failure. Confirmed live: without this, ~94% of a
// removal-candidate list (species genuinely absent from a region) got silently re-verified from
// scratch on every single run, since only SUCCESSFUL rescues were ever persisted anywhere
// (via the species table's own inat_taxon_id column) — a failed check had nowhere durable to
// remember "already looked, not there" and so got redone every time.
const INAT_CURRENT_TAXON_CACHE_PATH = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-current-taxon-cache.json");
let inatCurrentTaxonDiskCache: Record<string, number | null> | null = null;

function loadInatCurrentTaxonDiskCache(): Record<string, number | null> {
  if (inatCurrentTaxonDiskCache) return inatCurrentTaxonDiskCache;
  if (existsSync(INAT_CURRENT_TAXON_CACHE_PATH)) {
    try {
      inatCurrentTaxonDiskCache = JSON.parse(readFileSync(INAT_CURRENT_TAXON_CACHE_PATH, "utf8")) as Record<string, number | null>;
      return inatCurrentTaxonDiskCache;
    } catch {
      // Fall through to a fresh cache — a corrupt file is no worse than a missing one.
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

/** Resolves and caches (regions.inat_place_id) this region's iNaturalist place id — lazy, one
 * lookup ever per region rather than a separate up-front backfill, same reasoning as
 * ebird_region_code's own up-front seeding vs. this column's on-demand fill. iNaturalist's
 * admin_level values are multiples of 10 (0 = country, 10 = state/province, 20 = county) —
 * confirmed live against Canada (0) and British Columbia (10). Filtering on it (plus, for
 * provinces, requiring the country's OWN already-resolved place id among ancestor_place_ids)
 * avoids the same name-collision trap other region-matching code in this codebase already
 * guards against (e.g. a "Georgia" query returning the US state instead of the country). */
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
        const existing = await pool.query<{ inat_place_id: number | null }>(`SELECT inat_place_id FROM regions WHERE id = $1`, [regionId]);
        if (existing.rows[0]?.inat_place_id != null) return existing.rows[0].inat_place_id;
        // Same shared pacing gate as resolveCurrentInatTaxonId, and for the same reason: several
        // concurrent callers (flag-nonnative-obscure-taxa.ts's per-species workers, each walking
        // its own list of countries) hitting this endpoint unpaced reproduced the exact
        // burst-then-crawl degradation already diagnosed above, just against places/autocomplete
        // instead of taxa search.
        await paceInatTaxaRequest();
        try {
          const res = await fetchWithHardTimeout(`${INAT_PLACES_API}/autocomplete?q=${encodeURIComponent(regionName)}&per_page=20`, {
            headers: { "User-Agent": INAT_USER_AGENT },
          });
          if (!res.ok) return null;
          const data = (await res.json()) as { results: InatPlaceCandidate[] };
          const wantLevel = isCountry ? 0 : 10;
          const candidates = data.results.filter(
            (p) =>
              p.admin_level === wantLevel &&
              (isCountry || (countryInatPlaceId != null && (p.ancestor_place_ids ?? []).includes(countryInatPlaceId))),
          );
          // Prefer an exact name match over the first fuzzy autocomplete hit — confirmed live:
          // "Samoa" was resolving to "American Samoa" (both admin_level 0, "Samoa" query matches
          // both), silently poisoning every province lookup for the real Samoa afterward since
          // none of their ancestor_place_ids chains include American Samoa's id. This same
          // fuzzy-first-match trap likely affects any other name that's a substring/prefix of a
          // similarly-named place (Congo/DR Congo, Georgia, Guinea, Sudan, Korea, ...).
          const match =
            candidates.find((p) => p.display_name.split(",")[0].trim().toLowerCase() === regionName.trim().toLowerCase()) ??
            candidates[0];
          if (!match) return null;
          await pool.query(`UPDATE regions SET inat_place_id = $1 WHERE id = $2`, [match.id, regionId]);
          return match.id;
        } catch {
          return null;
        }
      })(),
    );
  }
  return inatPlaceIdCache.get(cacheKey)!;
}

// Paginated species_counts fetch (500/page, iNaturalist's own max) filtered to Research Grade
// and verifiable — the full cross-taxon species list ever reliably documented in this place.
// Disk-cached as { fetchedAt, taxonIds } rather than a bare array: once a place has a cached
// snapshot, every later call only asks iNat "anything NEW recorded since fetchedAt" (via
// created_d1, an ordinary observation-search filter species_counts still honors) and merges the
// result in, rather than re-pulling a whole province's cross-taxon species list from scratch
// every time. A full checklist is species that have EVER occurred here; once iNat has confirmed
// one, there's no reason to ask again — only "has anything NEW shown up" is worth re-checking.
const INAT_SPECIES_COUNTS_CACHE_DIR = path.join(REPO_ROOT, "packages/data-pipeline/data/inat-species-counts-cache");

interface InatTaxon {
  id: number;
  name: string;
}

interface SpeciesCountsCacheFile {
  fetchedAt: string;
  taxa: InatTaxon[];
}

// A single page failure (rate limiting, a transient 5xx) used to be read as "no more pages" and
// silently returned whatever had been fetched so far — confirmed live: running several of these
// scripts concurrently rate-limited Taiwan's fetch after page 2, silently truncating a real
// ~19,500-species result down to 1,000 with no error surfaced anywhere. Retried with backoff
// instead — a transient failure now delays that one page, not the whole place's result.
const PAGE_FETCH_RETRIES = 4;

// iNaturalist's own coarse "iconic taxon" groupings — every one of Lifer's own (much
// finer-grained) taxon classes falls under one of these. Confirmed live: leaving this filter off
// entirely pulls literally every kingdom (plants, fungi, insects, arachnids, ...) — a
// biodiverse country's real Research Grade total can run well past 30,000, which is exactly the
// hard page cap below, so an unfiltered fetch risks silently truncating before it ever reaches
// the vertebrate/marine species this catalog actually tracks. Restricting to just these cuts a
// country like Canada from ~36,600 taxa down to ~4,200 (9 pages instead of 74) with no loss of
// coverage — Mollusca/Animalia are broad enough to include every marine invertebrate group Lifer
// catalogs (corals, echinoderms, crustaceans, ...), and nothing outside this list has ever been
// a real catalog species (see is_other_taxa for the one deliberate exception — user-added
// species via Settings' any-taxa search — which this checklist-fill path never touches anyway).
const RELEVANT_ICONIC_TAXA = ["Aves", "Mammalia", "Reptilia", "Amphibia", "Actinopterygii", "Mollusca", "Animalia"];
const ICONIC_TAXA_PARAM = RELEVANT_ICONIC_TAXA.map((t) => `&iconic_taxa[]=${t}`).join("");

async function fetchOnePage(placeId: number, page: number, extraParams: string): Promise<Response | null> {
  for (let attempt = 0; attempt < PAGE_FETCH_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt)); // 2s, 4s, 8s
    try {
      // A bare `fetch` with no timeout hung indefinitely, zero CPU, zero log output, when
      // iNaturalist's API accepted the connection but never responded — confirmed live, blocking
      // this file's single-threaded caller (compute-provinces-bulk.ts) for over an hour with no
      // way to tell it apart from a real deadlock elsewhere. fetchWithHardTimeout (see its own
      // comment above) turns that silent hang into a loud, retried failure instead -- plain
      // AbortSignal.timeout alone reproduced the exact same silent-hang symptom again later.
      const res = await fetchWithHardTimeout(
        `${INAT_OBSERVATIONS_API}/species_counts?place_id=${placeId}&quality_grade=research&verifiable=true&per_page=500&page=${page}${ICONIC_TAXA_PARAM}${extraParams}`,
        { headers: { "User-Agent": INAT_USER_AGENT } },
      );
      if (res.ok) return res;
    } catch {
      // timed out or a network-level failure — fall through to the backoff/retry above
    }
  }
  return null;
}

async function fetchSpeciesCountsPages(placeId: number, extraParams: string): Promise<InatTaxon[] | null> {
  const taxa: InatTaxon[] = [];
  // A hard page cap (60 * 500 = 30,000 species) rather than trusting total_results blindly —
  // protects against a malformed/huge response looping forever; no real place has anywhere near
  // this many Research Grade species across all taxa (and an incremental "what's new" query
  // never comes close to this either).
  for (let page = 1; page <= 60; page++) {
    const res = await fetchOnePage(placeId, page, extraParams);
    // Exhausted all retries mid-fetch (a real, confirmed failure mode: another process hammering
    // iNat's API concurrently — e.g. a species-enrichment pass — can keep every retry rate-limited
    // for the whole backoff window). This USED TO return whatever partial pages it had gathered
    // so far as if that were the complete result — the caller (and the on-disk cache) had no way
    // to tell "this is genuinely every species" from "gave up 1 of 74 pages in" apart. Confirmed
    // live: Canada silently cached as 500 species instead of its real ~30,000+ this way, and
    // every later "reconcile against this checklist" pass would have wrongly treated that as
    // ground truth. Returning null on a mid-fetch failure (same as the zero-pages case) means the
    // caller skips writing to cache entirely and the next attempt starts over from page 1, rather
    // than a bad partial result getting entombed as permanent "truth".
    if (!res) return null;
    const data = (await res.json()) as { total_results: number; results: Array<{ taxon: { id: number; name: string } }> };
    for (const r of data.results) taxa.push({ id: r.taxon.id, name: r.taxon.name });
    if (data.results.length < 500 || taxa.length >= data.total_results) break;
  }
  return taxa;
}

// Shared by fetchInatResearchGradeTaxonIds (the rescue/flag passes, id-only) and
// fetchInatResearchGradeTaxa (compute-provinces-inat.ts's province-fill pass, which also needs
// each taxon's scientific name to match species with no inat_taxon_id backfilled yet) — one
// cache, one in-flight fetch per place, regardless of which shape a caller actually needs.
async function fetchInatResearchGradeTaxaCached(placeId: number): Promise<InatTaxon[] | null> {
  if (!inatResearchGradeTaxaCache.has(placeId)) {
    inatResearchGradeTaxaCache.set(
      placeId,
      (async () => {
        mkdirSync(INAT_SPECIES_COUNTS_CACHE_DIR, { recursive: true });
        const cachePath = path.join(INAT_SPECIES_COUNTS_CACHE_DIR, `${placeId}.json`);
        const now = new Date().toISOString();

        // Array.isArray/missing-.taxa guards against older cache formats (a bare array, or
        // {fetchedAt, taxonIds} from before names were cached) — treated as absent so it
        // regenerates fresh rather than crashing on a shape this code no longer expects.
        const rawCached = existsSync(cachePath) ? (JSON.parse(readFileSync(cachePath, "utf8")) as Partial<SpeciesCountsCacheFile> | number[]) : null;
        if (rawCached && !Array.isArray(rawCached) && rawCached.fetchedAt && rawCached.taxa) {
          const cached = rawCached as SpeciesCountsCacheFile;
          const sinceDate = cached.fetchedAt.slice(0, 10); // created_d1 wants YYYY-MM-DD
          try {
            const newTaxa = await fetchSpeciesCountsPages(placeId, `&created_d1=${sinceDate}`);
            if (newTaxa == null) return cached.taxa; // incremental check failed — stale cache is still better than nothing
            const byId = new Map(cached.taxa.map((t) => [t.id, t]));
            for (const t of newTaxa) byId.set(t.id, t);
            const merged = [...byId.values()];
            writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, taxa: merged } satisfies SpeciesCountsCacheFile));
            return merged;
          } catch {
            return cached.taxa;
          }
        }

        try {
          const taxa = await fetchSpeciesCountsPages(placeId, "");
          if (taxa == null) return null;
          writeFileSync(cachePath, JSON.stringify({ fetchedAt: now, taxa } satisfies SpeciesCountsCacheFile));
          return taxa;
        } catch {
          return null;
        }
      })(),
    );
  }
  return inatResearchGradeTaxaCache.get(placeId)!;
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

/** Resolves a (possibly outdated) scientific name to iNat's CURRENT active taxon id, via iNat's
 * own synonym/former-name tracking — confirmed live: searching `?q=Charadrius pecuarius&
 * is_active=any` surfaces BOTH the inactive taxon under that exact old name AND the current
 * taxon it was renamed into (Anarhynchus pecuarius, after a real 2020s genus split), linked by
 * iNat's own taxonomy, not a guess on our part. This is what lets a species whose scientific
 * name our catalog hasn't caught up to yet resolve correctly instead of reading as "iNat has
 * never heard of this" just because the exact string no longer matches anything active.
 * Case-insensitively require the found taxon's OWN matched_term to equal the name we searched
 * (not just a fuzzy/partial hit) before trusting it — a rank filter alone isn't enough insurance
 * against pulling in an unrelated same-word match. Cached per name: a species' correct current
 * taxon id is the same fact regardless of which country's checklist happens to be asking, so
 * this only ever needs resolving once per species, not once per country it's rechecked in. */
export async function resolveCurrentInatTaxonId(scientificName: string): Promise<number | null> {
  const onDisk = loadInatCurrentTaxonDiskCache();
  if (Object.prototype.hasOwnProperty.call(onDisk, scientificName)) {
    return onDisk[scientificName];
  }
  if (!inatCurrentTaxonIdCache.has(scientificName)) {
    inatCurrentTaxonIdCache.set(
      scientificName,
      (async () => {
        // Same retry-with-backoff as fetchOnePage above (PAGE_FETCH_RETRIES) — this result gets
        // permanently cached (both in-memory AND on disk, see saveInatCurrentTaxonDiskCache's own
        // comment) the moment this promise resolves, so a transient failure (a network hiccup, a
        // 429 from something else on this same run hitting iNat concurrently) must never be
        // allowed to silently resolve to "not found" and get treated as confirmation this species
        // is safe to remove. Only a real, fully-retried lookup that genuinely finds nothing
        // counts as "not found".
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
              results: Array<{ id: number; name: string; is_active: boolean; matched_term: string | null; rank: string }>;
            };
            const exactMatches = data.results.filter((r) => r.matched_term?.toLowerCase() === scientificName.toLowerCase());
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

/** Walks up from any region to whichever ancestor is a country (exactly two levels below
 * World: World -> continent -> country) — same shape compute-provinces-inat.ts's own
 * findCountry uses, just resolved via direct queries instead of an in-memory region map, since
 * this is called once per region rather than once per a whole batch of provinces. */
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

/** The iNaturalist-Research-Grade-backed answer to "which catalog species actually belong on
 * this region's checklist" — the single membership authority computeRegionOccurrences defers
 * to (see that function's own comment): a GBIF sweep still supplies the occurrence/rarity DATA
 * for whichever species land here, but no longer decides membership by itself. Returns null
 * (rather than an empty set) whenever iNat data genuinely can't be resolved for this
 * region — a place-lookup failure or a transient API error — so a caller can fall back to its
 * prior behavior instead of wrongly emptying a real checklist over a lookup hiccup. */
export interface RegionInatMatch {
  matchedSpeciesIds: Set<string>;
  /** Every taxon id iNat has Research Grade records for in this place, matched to our catalog
   * or not — a removal-candidate check (resolveRemovalRescues below) needs this to tell "iNat
   * really has never heard of this species here" apart from "iNat has it, just under a taxon id
   * our catalog hasn't linked to this exact species row yet". */
  rawTaxonIds: Set<number>;
}

export async function matchedSpeciesIdsForRegion(regionId: string, regionName: string): Promise<RegionInatMatch | null> {
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
    for (const row of byNameRes.rows) {
      const taxonId = idByName.get(row.scientific_name);
      matchedSpeciesIds.add(row.id);
      if (taxonId) await pool.query(`UPDATE species SET inat_taxon_id = $1 WHERE id = $2`, [taxonId, row.id]);
    }
  }
  return { matchedSpeciesIds, rawTaxonIds: new Set(taxonIds) };
}

/** The safety check the removal side of a reconcile pass now requires: before actually dropping
 * a species iNat's checklist doesn't confirm, checks whether that's genuinely true or just an
 * artifact of a scientific name our catalog hasn't caught up to yet (see
 * resolveCurrentInatTaxonId's own comment — the Charadrius/Anarhynchus plover split is a real,
 * confirmed case of exactly this). Returns the subset of candidates that resolve to a taxon iNat
 * DOES have here, and backfills each rescued species' inat_taxon_id to the resolved id so this
 * same lookup never has to happen again for it in any other region. Everything NOT returned
 * here has been genuinely checked and found absent — safe to remove. */
export async function resolveRemovalRescues(
  candidates: Array<{ id: string; scientific_name: string }>,
  rawTaxonIds: Set<number>,
): Promise<Set<string>> {
  const rescued = new Set<string>();
  for (const candidate of candidates) {
    const currentTaxonId = await resolveCurrentInatTaxonId(candidate.scientific_name);
    if (currentTaxonId != null && rawTaxonIds.has(currentTaxonId)) {
      rescued.add(candidate.id);
      await pool.query(`UPDATE species SET inat_taxon_id = $1 WHERE id = $2`, [currentTaxonId, candidate.id]);
    }
  }
  return rescued;
}
