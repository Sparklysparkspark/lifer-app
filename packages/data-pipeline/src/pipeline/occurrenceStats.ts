// Bulk GBIF occurrence stats for fetch-occurrence-stats.ts: each species' global record count and
// most recent record year, as one per-species call (taxonKey=K&facet=year) would give them, but
// for many species per request.
//
// How it stays equal to the per-species call:
// - Counts: occurrence/search with the species' keys as repeated taxonKey parameters (OR) and
//   facet=speciesKey. A record's speciesKey is the accepted species it belongs to, so a species'
//   facet count covers its own records, its subspecies' and its synonyms', which is exactly what
//   taxonKey=K counts. A key that is itself a synonym (or not a species) never shows up under its
//   own key: its records count towards the accepted species. Those keys are found with one more
//   query over the keys missing from the facet: if it has no records at all they really have
//   none; otherwise it is split until each such key gets the per-species call.
// - Last year: a species' last year is the top of the most recent year window it has records in.
//   Windows start at the current year and double in size going back (most species were recorded
//   this year or last), then halve to the exact year. Each window is one request for a whole set
//   of species. Small sets go to the per-species call, which is cheaper by then.
// - Big groups (more species than fit in one URL) are queried by their GBIF order key(s) instead,
//   learnt from the count query's facet=orderKey, so one request covers the whole group. Only
//   species seen in an order listing with no year filter are resolved through it.
import { RateLimitBreaker } from "./rateLimitBreaker.js";

export const GBIF_OCCURRENCE_SEARCH = "https://api.gbif.org/v1/occurrence/search";
/** Lowest year a window can start at; rendered as an open range ("*,hi"). */
export const MIN_YEAR = 1;
/** Species keys per request: about 3.4k characters of URL at 200, well inside GBIF's limit. */
export const DEFAULT_BATCH_SIZE = 200;
/** A facet page; GBIF answered 100,000 for all of Gastropoda (99,124 species) in one request. */
const FACET_PAGE = 50_000;
/** More order keys than this and a group is queried by species keys only. */
const MAX_GROUP_KEYS = 20;

export interface OccurrenceStats {
  count: number;
  lastYear: number | null;
}

export interface SpeciesFacetResult {
  total: number;
  species: Map<number, number>;
  orderKeys: Map<number, number>;
}

/** What the resolver needs from GBIF; GbifOccurrenceClient is the real one, tests pass fakes. */
export interface OccurrenceSearch {
  speciesFacet(
    taxonKeys: number[],
    opts?: { year?: [number, number]; withOrderKeys?: boolean },
  ): Promise<SpeciesFacetResult>;
  perSpecies(gbifKey: number): Promise<OccurrenceStats>;
}

interface GbifSearchResponse {
  count?: number;
  facets?: Array<{ field: string; counts: Array<{ name: string; count: number }> }>;
}

/** One facet's counts by numeric key. GBIF names facet fields in upper snake case (SPECIES_KEY). */
export function parseFacet(data: GbifSearchResponse, field: string): Map<number, number> {
  const out = new Map<number, number>();
  const facet = data.facets?.find((f) => f.field === field);
  for (const c of facet?.counts ?? []) {
    const key = Number(c.name);
    if (Number.isFinite(key) && c.count > 0) out.set(key, c.count);
  }
  return out;
}

/** The per-species call's answer: total records and the latest year with any. */
export function parseYearFacet(data: GbifSearchResponse): OccurrenceStats {
  const years = [...parseFacet(data, "YEAR").keys()];
  return { count: data.count ?? 0, lastYear: years.length > 0 ? Math.max(...years) : null };
}

export function yearParam([lo, hi]: [number, number]): string {
  return lo <= MIN_YEAR ? `*,${hi}` : lo === hi ? `${lo}` : `${lo},${hi}`;
}

export function speciesFacetUrl(
  taxonKeys: number[],
  opts: { year?: [number, number]; withOrderKeys?: boolean; facetLimit: number; facetOffset?: number },
): string {
  const params = new URLSearchParams();
  for (const k of taxonKeys) params.append("taxonKey", String(k));
  params.set("limit", "0");
  if (opts.year) params.set("year", yearParam(opts.year));
  params.append("facet", "speciesKey");
  if (opts.withOrderKeys) params.append("facet", "orderKey");
  params.set("facetLimit", String(opts.facetLimit));
  if (opts.facetOffset) params.set("facetOffset", String(opts.facetOffset));
  return `${GBIF_OCCURRENCE_SEARCH}?${params.toString().replaceAll("%2C", ",").replaceAll("%2A", "*")}`;
}

export function perSpeciesUrl(gbifKey: number): string {
  return `${GBIF_OCCURRENCE_SEARCH}?taxonKey=${gbifKey}&limit=0&facet=year&facetLimit=1000`;
}

/**
 * The next year window to ask about for species whose last year is in [lo, hi]: the newest
 * part of it, as many years as hi is behind `now` (so 1, 2, 4, 8... going back from now), but
 * never more than half the interval, so a known interval is halved.
 */
export function nextWindow(lo: number, hi: number, now: number): [number, number] {
  const size = Math.max(1, Math.min(now - hi + 1, Math.ceil((hi - lo + 1) / 2)));
  return [Math.max(lo, hi - size + 1), hi];
}

/** Whether a set is cheaper to finish with one per-species call each than by halving windows. */
export function fetchIndividually(size: number, lo: number, hi: number): boolean {
  return size < Math.log2(hi - lo + 2);
}

export class RateLimitStop extends Error {
  constructor() {
    super("GBIF keeps refusing requests (HTTP 429)");
  }
}

export class GbifRequestError extends Error {
  constructor(
    message: string,
    /** True for network errors and 5xx: worth trying again on a later run. */
    readonly transient: boolean,
  ) {
    super(message);
  }
}

export interface GbifClientOptions {
  fetch?: typeof fetch;
  /** Minimum time between request starts. */
  intervalMs?: number;
  breaker?: RateLimitBreaker;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/** GBIF occurrence search with a fixed pace, 429 back-off and a breaker that stops the run. */
export class GbifOccurrenceClient implements OccurrenceSearch {
  requests = 0;
  rateLimited = 0;
  private lastStart = 0;
  private readonly fetchFn: typeof fetch;
  private readonly intervalMs: number;
  private readonly breaker: RateLimitBreaker;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxAttempts: number;

  constructor(opts: GbifClientOptions = {}) {
    this.fetchFn = opts.fetch ?? fetch;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.breaker = opts.breaker ?? new RateLimitBreaker(20, 0.5);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxAttempts = opts.maxAttempts ?? 5;
  }

  async getJson(url: string): Promise<GbifSearchResponse> {
    let lastError = "";
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const wait = this.lastStart + this.intervalMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.lastStart = Date.now();
      this.requests++;
      let res: Response;
      try {
        res = await this.fetchFn(url);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        this.rateLimited++;
        lastError = "HTTP 429";
        if (this.breaker.record(true)) throw new RateLimitStop();
        const retryAfter = Number(res.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** attempt);
        continue;
      }
      this.breaker.record(false);
      if (res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new GbifRequestError(`HTTP ${res.status} for ${url}`, false);
      return (await res.json()) as GbifSearchResponse;
    }
    throw new GbifRequestError(`${lastError || "gave up"} for ${url}`, true);
  }

  async speciesFacet(
    taxonKeys: number[],
    opts: { year?: [number, number]; withOrderKeys?: boolean } = {},
  ): Promise<SpeciesFacetResult> {
    const out: SpeciesFacetResult = { total: 0, species: new Map(), orderKeys: new Map() };
    for (let offset = 0; ; offset += FACET_PAGE) {
      const data = await this.getJson(
        speciesFacetUrl(taxonKeys, { ...opts, facetLimit: FACET_PAGE, facetOffset: offset }),
      );
      out.total = data.count ?? 0;
      const page = parseFacet(data, "SPECIES_KEY");
      for (const [k, v] of page) out.species.set(k, v);
      for (const [k, v] of parseFacet(data, "ORDER_KEY")) out.orderKeys.set(k, v);
      if (page.size < FACET_PAGE) return out;
    }
  }

  async perSpecies(gbifKey: number): Promise<OccurrenceStats> {
    return parseYearFacet(await this.getJson(perSpeciesUrl(gbifKey)));
  }
}

export type ResolveMethod = "bulk" | "none" | "single";

export interface ResolvedSpecies {
  gbifKey: number;
  stats: OccurrenceStats;
  /** bulk: from faceted queries; none: GBIF has no records; single: the per-species call. */
  method: ResolveMethod;
}

export interface FailedSpecies {
  gbifKey: number;
  error: GbifRequestError;
}

export interface ResolveOptions {
  now: number;
  batchSize?: number;
  onResolved: (r: ResolvedSpecies) => void;
  onFailed: (f: FailedSpecies) => void;
}

/**
 * Turns per-order groups into the sets resolveGroup runs on. A group of at least a batch keeps
 * to itself (it may be big enough to query by order key); smaller ones are packed together up to
 * a batch, since a handful of species costs about as much as a full batch.
 */
export function packGroups<T>(groups: T[][], batchSize: number): T[][] {
  const out: T[][] = [];
  let pack: T[] = [];
  for (const group of groups) {
    if (group.length >= batchSize) {
      out.push(group);
      continue;
    }
    if (pack.length + group.length > batchSize) {
      out.push(pack);
      pack = [];
    }
    pack.push(...group);
  }
  if (pack.length > 0) out.push(pack);
  return out;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Resolves one group of species keys (ideally one taxonomic order). Results stream out through
 * onResolved/onFailed. A request that fails for good fails the species it was about; a
 * RateLimitStop is thrown to the caller.
 */
export async function resolveGroup(keys: number[], search: OccurrenceSearch, opts: ResolveOptions): Promise<void> {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const { now } = opts;
  const found = new Map<number, number>();
  const orderKeys = new Set<number>();

  const fail = (ks: number[], err: unknown) => {
    if (err instanceof RateLimitStop || !(err instanceof GbifRequestError)) throw err;
    for (const gbifKey of ks) opts.onFailed({ gbifKey, error: err });
  };

  const single = async (k: number) => {
    try {
      opts.onResolved({ gbifKey: k, stats: await search.perSpecies(k), method: "single" });
    } catch (err) {
      fail([k], err);
    }
  };

  // Keys absent from a count facet: none of them has records of its own, unless it is a synonym
  // (or a subspecies) whose records counted towards another species.
  const settleMissing = async (missing: number[]): Promise<void> => {
    if (missing.length === 0) return;
    if (missing.length <= 2) {
      for (const k of missing) await single(k);
      return;
    }
    let total: number;
    try {
      total = (await search.speciesFacet(missing)).total;
    } catch (err) {
      return fail(missing, err);
    }
    if (total === 0) {
      for (const k of missing) opts.onResolved({ gbifKey: k, stats: { count: 0, lastYear: null }, method: "none" });
      return;
    }
    const half = Math.ceil(missing.length / 2);
    await settleMissing(missing.slice(0, half));
    await settleMissing(missing.slice(half));
  };

  for (const batch of chunk(keys, batchSize)) {
    let res: SpeciesFacetResult;
    try {
      res = await search.speciesFacet(batch, { withOrderKeys: true });
    } catch (err) {
      fail(batch, err);
      continue;
    }
    for (const k of res.orderKeys.keys()) orderKeys.add(k);
    const missing: number[] = [];
    for (const k of batch) {
      const count = res.species.get(k);
      if (count) found.set(k, count);
      else missing.push(k);
    }
    await settleMissing(missing);
  }

  // `dated`: every species in the set has a record in [lo, hi]. Otherwise some may have no dated
  // record at all, which is what is left when the interval runs out.
  const refine = async (set: number[], lo: number, hi: number, dated: boolean, via: number[] | null): Promise<void> => {
    if (set.length === 0) return;
    if (lo > hi) {
      for (const k of set)
        opts.onResolved({ gbifKey: k, stats: { count: found.get(k)!, lastYear: null }, method: "bulk" });
      return;
    }
    if (dated && lo === hi) {
      for (const k of set)
        opts.onResolved({ gbifKey: k, stats: { count: found.get(k)!, lastYear: lo }, method: "bulk" });
      return;
    }
    if (fetchIndividually(set.length, lo, hi)) {
      for (const k of set) await single(k);
      return;
    }
    const groupKeys = via && set.length > batchSize ? via : null;
    if (!groupKeys && set.length > batchSize) {
      for (const part of chunk(set, batchSize)) await refine(part, lo, hi, dated, null);
      return;
    }
    // First split off species with no dated record at all, which the windows would only find at
    // the very bottom.
    const window: [number, number] = dated || lo > MIN_YEAR ? nextWindow(lo, hi, now) : [MIN_YEAR, hi];
    let res: SpeciesFacetResult;
    try {
      res = await search.speciesFacet(groupKeys ?? set, { year: window });
    } catch (err) {
      return fail(set, err);
    }
    const upper = set.filter((k) => res.species.has(k));
    const lower = set.filter((k) => !res.species.has(k));
    await refine(upper, window[0], window[1], true, groupKeys);
    await refine(lower, lo, window[0] - 1, dated, groupKeys);
  };

  const withRecords = [...found.keys()];
  let covered = withRecords;
  let uncovered: number[] = [];
  let via: number[] | null = null;
  if (withRecords.length > batchSize && orderKeys.size > 0 && orderKeys.size <= MAX_GROUP_KEYS) {
    via = [...orderKeys];
    try {
      const listing = (await search.speciesFacet(via)).species;
      covered = withRecords.filter((k) => listing.has(k));
      uncovered = withRecords.filter((k) => !listing.has(k));
    } catch (err) {
      if (err instanceof RateLimitStop || !(err instanceof GbifRequestError)) throw err;
      via = null;
    }
  }
  await refine(covered, MIN_YEAR, now, false, via);
  await refine(uncovered, MIN_YEAR, now, false, null);
}
