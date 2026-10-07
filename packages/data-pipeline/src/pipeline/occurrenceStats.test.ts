import { describe, expect, it, vi } from "vitest";
import {
  fetchIndividually,
  GbifOccurrenceClient,
  GbifRequestError,
  nextWindow,
  packGroups,
  parseFacet,
  parseYearFacet,
  perSpeciesUrl,
  RateLimitStop,
  resolveGroup,
  speciesFacetUrl,
  yearParam,
  type OccurrenceSearch,
  type OccurrenceStats,
  type ResolvedSpecies,
  type SpeciesFacetResult,
} from "./occurrenceStats.js";
import { RateLimitBreaker } from "./rateLimitBreaker.js";

const NOW = 2026;

describe("parsing", () => {
  const data = {
    count: 42,
    facets: [
      {
        field: "SPECIES_KEY",
        counts: [
          { name: "5", count: 30 },
          { name: "7", count: 12 },
          { name: "9", count: 0 },
        ],
      },
      {
        field: "YEAR",
        counts: [
          { name: "1999", count: 2 },
          { name: "2024", count: 1 },
          { name: "1850", count: 39 },
        ],
      },
    ],
  };

  it("reads one facet's counts by key, skipping empty buckets", () => {
    expect([...parseFacet(data, "SPECIES_KEY")]).toEqual([
      [5, 30],
      [7, 12],
    ]);
    expect(parseFacet(data, "ORDER_KEY").size).toBe(0);
    expect(parseFacet({}, "SPECIES_KEY").size).toBe(0);
  });

  it("takes the latest year, not the busiest", () => {
    expect(parseYearFacet(data)).toEqual({ count: 42, lastYear: 2024 });
    expect(parseYearFacet({ count: 3, facets: [{ field: "YEAR", counts: [] }] })).toEqual({ count: 3, lastYear: null });
    expect(parseYearFacet({ count: 0 })).toEqual({ count: 0, lastYear: null });
  });
});

describe("urls", () => {
  it("renders year windows", () => {
    expect(yearParam([2026, 2026])).toBe("2026");
    expect(yearParam([2019, 2022])).toBe("2019,2022");
    expect(yearParam([1, 1949])).toBe("*,1949");
  });

  it("repeats taxonKey and asks for the species facet", () => {
    expect(
      speciesFacetUrl([11, 22], { year: [2020, 2026], withOrderKeys: true, facetLimit: 500, facetOffset: 500 }),
    ).toBe(
      "https://api.gbif.org/v1/occurrence/search?taxonKey=11&taxonKey=22&limit=0&year=2020,2026&facet=speciesKey&facet=orderKey&facetLimit=500&facetOffset=500",
    );
    expect(speciesFacetUrl([3], { year: [1, 10], facetLimit: 10 })).toContain("year=*,10&");
    expect(perSpeciesUrl(9)).toBe(
      "https://api.gbif.org/v1/occurrence/search?taxonKey=9&limit=0&facet=year&facetLimit=1000",
    );
  });
});

describe("decisions", () => {
  it("gallops back from the current year, then halves", () => {
    expect(nextWindow(1, 2026, NOW)).toEqual([2026, 2026]);
    expect(nextWindow(1, 2025, NOW)).toEqual([2024, 2025]);
    expect(nextWindow(1, 2023, NOW)).toEqual([2020, 2023]);
    expect(nextWindow(1, 2019, NOW)).toEqual([2012, 2019]);
    // A known interval narrower than the gallop step is halved.
    expect(nextWindow(2012, 2019, NOW)).toEqual([2016, 2019]);
    expect(nextWindow(2012, 2013, NOW)).toEqual([2013, 2013]);
    expect(nextWindow(5, 5, NOW)).toEqual([5, 5]);
    // Near the bottom it never goes below lo.
    expect(nextWindow(1, 3, NOW)).toEqual([2, 3]);
  });

  it("sends small sets to the per-species call", () => {
    expect(fetchIndividually(10, 1, 2026)).toBe(true);
    expect(fetchIndividually(11, 1, 2026)).toBe(false);
    expect(fetchIndividually(1, 2020, 2021)).toBe(true);
    expect(fetchIndividually(2, 2020, 2021)).toBe(false);
  });
});

describe("packGroups", () => {
  it("keeps big groups apart and packs small ones up to a batch", () => {
    const g = (name: string, n: number) => Array.from({ length: n }, (_, i) => `${name}${i}`);
    const packed = packGroups([g("a", 3), g("b", 10), g("c", 4), g("d", 2), g("e", 5), g("f", 1)], 6);
    expect(packed).toEqual([g("b", 10), g("a", 3), [...g("c", 4), ...g("d", 2)], [...g("e", 5), ...g("f", 1)]]);
    expect(packGroups([], 6)).toEqual([]);
    expect(packed.flat()).toHaveLength(25);
  });
});

// A small stand-in for GBIF's index. Each record set belongs to a name usage (`key`); a synonym
// or subspecies usage has `species` set to the accepted species its records count towards.
// taxonKey=K matches records of K, of usages whose species is K, and of K's order, as GBIF does.
interface Usage {
  key: number;
  species?: number;
  order: number;
  years: Record<number, number>;
  undated?: number;
}

class FakeGbif implements OccurrenceSearch {
  facetCalls = 0;
  singleCalls = 0;
  constructor(private readonly usages: Usage[]) {}

  private matching(taxonKeys: number[]) {
    const set = new Set(taxonKeys);
    return this.usages.filter((u) => set.has(u.key) || (u.species != null && set.has(u.species)) || set.has(u.order));
  }

  async speciesFacet(
    taxonKeys: number[],
    opts: { year?: [number, number]; withOrderKeys?: boolean } = {},
  ): Promise<SpeciesFacetResult> {
    this.facetCalls++;
    const out: SpeciesFacetResult = { total: 0, species: new Map(), orderKeys: new Map() };
    for (const u of this.matching(taxonKeys)) {
      let n = 0;
      for (const [y, c] of Object.entries(u.years)) {
        if (!opts.year || (Number(y) >= opts.year[0] && Number(y) <= opts.year[1])) n += c;
      }
      if (!opts.year) n += u.undated ?? 0;
      if (n === 0) continue;
      out.total += n;
      const sk = u.species ?? u.key;
      out.species.set(sk, (out.species.get(sk) ?? 0) + n);
      if (opts.withOrderKeys) out.orderKeys.set(u.order, (out.orderKeys.get(u.order) ?? 0) + n);
    }
    return out;
  }

  /** What one taxonKey=K&facet=year call answers. */
  truth(key: number): OccurrenceStats {
    let count = 0;
    let lastYear: number | null = null;
    for (const u of this.matching([key])) {
      for (const [y, c] of Object.entries(u.years)) {
        count += c;
        if (c > 0) lastYear = Math.max(lastYear ?? 0, Number(y));
      }
      count += u.undated ?? 0;
    }
    return { count, lastYear };
  }

  async perSpecies(key: number): Promise<OccurrenceStats> {
    this.singleCalls++;
    return this.truth(key);
  }
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 2 ** 32;
    return s / 2 ** 32;
  };
}

/** Mostly recent species, some silent for decades, some 1800s-only, some without records. */
function randomWorld(seed: number, n: number): Usage[] {
  const r = rng(seed);
  const usages: Usage[] = [];
  for (let i = 0; i < n; i++) {
    const key = 1000 + i;
    const roll = r();
    const order = r() < 0.8 ? 1 : 2;
    let last: number;
    if (roll < 0.08) {
      usages.push({ key, order, years: {} });
      continue;
    } else if (roll < 0.6) last = NOW - Math.floor(r() * 3);
    else if (roll < 0.85) last = 1950 + Math.floor(r() * 70);
    else last = 1780 + Math.floor(r() * 170);
    const years: Record<number, number> = { [last]: 1 + Math.floor(r() * 5) };
    for (let j = 0; j < 5; j++) years[last - Math.floor(r() * 80)] = 1 + Math.floor(r() * 50);
    usages.push({ key, order, years, undated: r() < 0.1 ? 3 : 0 });
  }
  return usages;
}

async function run(keys: number[], gbif: OccurrenceSearch, batchSize: number) {
  const resolved = new Map<number, ResolvedSpecies>();
  const failed: number[] = [];
  await resolveGroup(keys, gbif, {
    now: NOW,
    batchSize,
    onResolved: (r) => {
      expect(resolved.has(r.gbifKey)).toBe(false);
      resolved.set(r.gbifKey, r);
    },
    onFailed: (f) => failed.push(f.gbifKey),
  });
  return { resolved, failed };
}

describe("resolveGroup", () => {
  it.each([
    [1, 300, 50],
    [2, 300, 500],
    [3, 120, 7],
    [4, 40, 200],
  ])(
    "matches the per-species call for every species (seed %i, %i species, batches of %i)",
    async (seed, n, batchSize) => {
      const world = randomWorld(seed, n);
      const gbif = new FakeGbif(world);
      const keys = world.map((u) => u.key);
      const { resolved, failed } = await run(keys, gbif, batchSize);
      expect(failed).toEqual([]);
      expect(resolved.size).toBe(keys.length);
      for (const k of keys) expect([k, resolved.get(k)!.stats]).toEqual([k, gbif.truth(k)]);
    },
  );

  it("uses far fewer requests than one per species", async () => {
    const world = randomWorld(9, 1000);
    const gbif = new FakeGbif(world);
    await run(
      world.map((u) => u.key),
      gbif,
      200,
    );
    expect(gbif.facetCalls + gbif.singleCalls).toBeLessThan(250);
  });

  it("queries a big group by its order key once it outgrows a batch", async () => {
    const world = randomWorld(5, 400).map((u) => ({ ...u, order: 77 }));
    const gbif = new FakeGbif(world);
    const spy = vi.spyOn(gbif, "speciesFacet");
    const { resolved } = await run(
      world.map((u) => u.key),
      gbif,
      100,
    );
    expect(spy.mock.calls.some(([keys]) => keys.length === 1 && keys[0] === 77)).toBe(true);
    for (const u of world) expect(resolved.get(u.key)!.stats).toEqual(gbif.truth(u.key));
  });

  it("stores species without records as 0 with no year", async () => {
    const world: Usage[] = [
      { key: 1, order: 5_000_000, years: { 2025: 3 } },
      ...[2, 3, 4, 5].map((key) => ({ key, order: 5_000_000, years: {} })),
    ];
    const { resolved } = await run([1, 2, 3, 4, 5], new FakeGbif(world), 200);
    expect(resolved.get(3)).toEqual({ gbifKey: 3, stats: { count: 0, lastYear: null }, method: "none" });
  });

  it("gives a synonym its own records, even next to its accepted species", async () => {
    // 20 is a synonym of 10: taxonKey=10 counts 20's records too, taxonKey=20 only its own.
    const world: Usage[] = [
      { key: 10, order: 5_000_000, years: { 2026: 100, 1990: 5 } },
      { key: 20, species: 10, order: 5_000_000, years: { 1901: 6 } },
      { key: 30, species: 40, order: 5_000_000, years: { 2001: 2 } }, // synonym of a species not in the run
      ...[50, 51, 52, 53].map((key) => ({ key, order: 5_000_000, years: {} })),
    ];
    const gbif = new FakeGbif(world);
    const keys = [10, 20, 30, 50, 51, 52, 53];
    const { resolved } = await run(keys, gbif, 200);
    expect(resolved.get(10)!.stats).toEqual({ count: 111, lastYear: 2026 });
    expect(resolved.get(20)).toEqual({ gbifKey: 20, stats: { count: 6, lastYear: 1901 }, method: "single" });
    expect(resolved.get(30)!.stats).toEqual({ count: 2, lastYear: 2001 });
    expect(resolved.get(52)!.method).toBe("none");
  });

  it("gives a species with only undated records no year", async () => {
    const world: Usage[] = Array.from({ length: 30 }, (_, i): Usage => ({
      key: i + 1,
      order: 5_000_000,
      years: i < 25 ? { 2026: 1 } : {},
      undated: 4,
    }));
    const gbif = new FakeGbif(world);
    const { resolved } = await run(
      world.map((u) => u.key),
      gbif,
      200,
    );
    expect(resolved.get(28)!.stats).toEqual({ count: 4, lastYear: null });
    expect(resolved.get(3)!.stats).toEqual({ count: 5, lastYear: 2026 });
  });

  it("gives no year to many undated species resolved in bulk, down to the oldest window", async () => {
    const world: Usage[] = Array.from({ length: 80 }, (_, i): Usage => ({
      key: i + 1,
      order: 5_000_000,
      years: i < 40 ? {} : i < 60 ? { 3: 1 } : { 1: 2 },
      undated: 4,
    }));
    const gbif = new FakeGbif(world);
    const { resolved } = await run(
      world.map((u) => u.key),
      gbif,
      200,
    );
    expect(gbif.singleCalls).toBe(0);
    for (const u of world) expect(resolved.get(u.key)!.stats).toEqual(gbif.truth(u.key));
  });

  it("fails the species a request was about and carries on", async () => {
    const world = randomWorld(3, 60);
    const gbif = new FakeGbif(world);
    const real = gbif.speciesFacet.bind(gbif);
    let calls = 0;
    gbif.speciesFacet = async (keys, opts) => {
      if (++calls === 2) throw new GbifRequestError("HTTP 503", true);
      return real(keys, opts);
    };
    const { resolved, failed } = await run(
      world.map((u) => u.key),
      gbif,
      200,
    );
    expect(failed.length).toBeGreaterThan(0);
    expect(resolved.size + failed.length).toBe(60);
    for (const [k, r] of resolved) expect(r.stats).toEqual(gbif.truth(k));
  });

  it("lets a rate-limit stop through", async () => {
    const gbif = new FakeGbif(randomWorld(3, 10));
    gbif.speciesFacet = async () => {
      throw new RateLimitStop();
    };
    await expect(run([1000, 1001, 1002], gbif, 200)).rejects.toBeInstanceOf(RateLimitStop);
  });
});

describe("GbifOccurrenceClient", () => {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers });
  const noSleep = async () => {};

  it("pages a facet until a short page", async () => {
    const page = (keys: number[]) => ({
      count: 9,
      facets: [{ field: "SPECIES_KEY", counts: keys.map((k) => ({ name: String(k), count: 1 })) }],
    });
    const full = Array.from({ length: 50_000 }, (_, i) => i + 1);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(page(full)))
      .mockResolvedValueOnce(json(page([50_001])));
    const client = new GbifOccurrenceClient({ fetch: fetchMock, intervalMs: 0, sleep: noSleep });
    const res = await client.speciesFacet([5]);
    expect(res.species.size).toBe(50_001);
    expect(fetchMock.mock.calls[1][0]).toContain("facetOffset=50000");
    expect(client.requests).toBe(2);
  });

  it("backs off on 429 using Retry-After and retries 5xx", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "7" }))
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ count: 3, facets: [{ field: "YEAR", counts: [{ name: "2001", count: 3 }] }] }));
    const client = new GbifOccurrenceClient({
      fetch: fetchMock,
      intervalMs: 0,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(await client.perSpecies(1)).toEqual({ count: 3, lastYear: 2001 });
    expect(sleeps).toEqual([7000, 2000]);
    expect(client.rateLimited).toBe(1);
  });

  it("throws a non-transient error for a 4xx and a transient one after repeated 5xx", async () => {
    const client400 = new GbifOccurrenceClient({
      fetch: vi.fn().mockResolvedValue(json({}, 400)),
      intervalMs: 0,
      sleep: noSleep,
    });
    await expect(client400.perSpecies(1)).rejects.toMatchObject({ transient: false });
    const client500 = new GbifOccurrenceClient({
      fetch: vi.fn().mockResolvedValue(json({}, 500)),
      intervalMs: 0,
      sleep: noSleep,
      maxAttempts: 3,
    });
    await expect(client500.perSpecies(1)).rejects.toMatchObject({ transient: true });
    expect(client500.requests).toBe(3);
  });

  it("stops the run once most recent requests were refused", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => json({}, 429));
    const client = new GbifOccurrenceClient({
      fetch: fetchMock,
      intervalMs: 0,
      sleep: noSleep,
      breaker: new RateLimitBreaker(4, 0.5),
      maxAttempts: 2,
    });
    // The first species uses up its retries (2 refusals) and fails; the next one trips the breaker.
    await expect(client.perSpecies(1)).rejects.toBeInstanceOf(GbifRequestError);
    await expect(client.perSpecies(2)).rejects.toBeInstanceOf(RateLimitStop);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps its pace between requests", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => json({ count: 0 }));
    const client = new GbifOccurrenceClient({
      fetch: fetchMock,
      intervalMs: 1000,
      sleep: async (ms) => void sleeps.push(ms),
    });
    await client.perSpecies(1);
    await client.perSpecies(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(900);
  });
});
