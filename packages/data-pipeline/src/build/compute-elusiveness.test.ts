// Each taxon group must be ranked only against itself: bird record volumes dwarf mammal volumes,
// so a combined ranking would put every mammal near elusiveness 1.0. Drives computeElusiveness
// with fabricated counts (birds: huge volume; mammals: tiny, one common, one rare).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { computeVagrantCountries } from "./compute-elusiveness.js";

function square(lon: number, lat: number, size: number): [number, number][] {
  return [
    [lon, lat],
    [lon + size, lat],
    [lon + size, lat + size],
    [lon, lat + size],
    [lon, lat],
  ];
}

vi.mock("../fetch/fetch-region-boundary.js", () => ({
  fetchAllCountries: vi.fn(),
}));
vi.mock("./build-region-species.js", () => ({
  fetchSpeciesCountsForRegion: vi.fn(),
  MIN_RECORDS: 30,
  FISH_MIN_RECORDS: 30,
  FISH_YEARS_WINDOW: null,
  RECENT_YEARS_WINDOW: 15,
}));

const BIRD_A = 1; // common bird
const BIRD_B = 2; // rare bird
const MAMMAL_COMMON = 100; // genuinely common mammal, tiny GBIF volume vs. birds
const MAMMAL_RARE = 101; // genuinely rare mammal

describe("computeElusiveness", () => {
  beforeEach(async () => {
    const { fetchAllCountries } = await import("../fetch/fetch-region-boundary.js");
    const { fetchSpeciesCountsForRegion } = await import("./build-region-species.js");

    vi.mocked(fetchAllCountries).mockResolvedValue([{ iso3: "USA", iso2: "US" } as never]);

    vi.mocked(fetchSpeciesCountsForRegion).mockImplementation(async (_code, taxonKeys = []) => {
      // Birds: record volume orders of magnitude above mammals.
      if (taxonKeys.includes(999)) {
        return [
          { gbifKey: BIRD_A, recordCount: 50_000 },
          { gbifKey: BIRD_B, recordCount: 100 },
        ];
      }
      // Mammals: tiny volume, but MAMMAL_COMMON is clearly the more common of the two.
      if (taxonKeys.includes(998)) {
        return [
          { gbifKey: MAMMAL_COMMON, recordCount: 6_000 },
          { gbifKey: MAMMAL_RARE, recordCount: 50 },
        ];
      }
      return [];
    });
  });

  it("ranks each taxon group only against itself, not pooled with other groups' volume", async () => {
    const { computeElusiveness } = await import("./compute-elusiveness.js");
    const result = await computeElusiveness([
      { taxonKeys: [999], minRecords: 30, yearsWindow: 15 },
      { taxonKeys: [998], minRecords: 10, yearsWindow: 15 },
    ]);

    // The common mammal ranks as more common than the rare one despite having far fewer records
    // than either bird. Ranked against birds, both mammals would cluster near 1.0.
    const commonMammalScore = result.byGbifKey.get(MAMMAL_COMMON)!;
    const rareMammalScore = result.byGbifKey.get(MAMMAL_RARE)!;
    expect(commonMammalScore).toBeLessThan(rareMammalScore);
    // An absolute threshold too: the common mammal must read as easy to detect.
    expect(commonMammalScore).toBeLessThan(0.5);

    const commonBirdScore = result.byGbifKey.get(BIRD_A)!;
    const rareBirdScore = result.byGbifKey.get(BIRD_B)!;
    expect(commonBirdScore).toBeLessThan(rareBirdScore);
  });

  it("flags a species present in exactly one country as endemic", async () => {
    const { fetchAllCountries } = await import("../fetch/fetch-region-boundary.js");
    vi.mocked(fetchAllCountries).mockResolvedValue([
      { iso3: "USA", iso2: "US" } as never,
      { iso3: "CAN", iso2: "CA" } as never,
    ]);
    const { fetchSpeciesCountsForRegion } = await import("./build-region-species.js");
    vi.mocked(fetchSpeciesCountsForRegion).mockImplementation(async (code, taxonKeys = []) => {
      if (!taxonKeys.includes(998)) return [];
      if (code === "USA") return [{ gbifKey: MAMMAL_COMMON, recordCount: 6_000 }, { gbifKey: MAMMAL_RARE, recordCount: 50 }];
      return [{ gbifKey: MAMMAL_COMMON, recordCount: 5_500 }]; // MAMMAL_RARE absent from Canada
    });

    const { computeElusiveness } = await import("./compute-elusiveness.js");
    const result = await computeElusiveness([{ taxonKeys: [998], minRecords: 10, yearsWindow: 15 }]);

    expect(result.endemicCountryIso3ByGbifKey.get(MAMMAL_RARE)).toBe("USA");
    expect(result.endemicCountryIso3ByGbifKey.has(MAMMAL_COMMON)).toBe(false);
  });
});

describe("computeVagrantCountries", () => {
  // Two countries far apart (>500km) in every case below: concentration is what's being tested.
  const CORE_RINGS = [square(0, 0, 1)];
  const OTHER_RINGS = [square(20, 0, 1)];

  it("flags a scattered escapee population far from a concentrated real core", () => {
    // A single-country wild population plus a larger, scattered escapee population elsewhere whose
    // concentration is well under the core's.
    const counts = new Map([
      ["ZMB", 176],
      ["ZAF", 387],
    ]);
    const bboxKm = new Map([
      ["ZMB", 405],
      ["ZAF", 1386],
    ]);
    const rings = new Map([
      ["ZMB", CORE_RINGS],
      ["ZAF", OTHER_RINGS],
    ]);
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.has("ZAF")).toBe(true);
  });

  it("does NOT flag a second real, similarly-concentrated disjunct population", () => {
    // Two genuinely separate native populations: the second country's concentration is close to
    // the core's, as a real population's would be.
    const counts = new Map([
      ["USA", 10_000],
      ["MEX", 4_000],
    ]);
    const bboxKm = new Map([
      ["USA", 500], // concentration = 20
      ["MEX", 250], // concentration = 16 (80% of core, well above the 0.7 ratio bar)
    ]);
    const rings = new Map([
      ["USA", CORE_RINGS],
      ["MEX", OTHER_RINGS],
    ]);
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.size).toBe(0);
  });

  it("skips vagrant detection entirely once a species spans too many countries", () => {
    // A species present in dozens of countries has no single core; without the country-count gate
    // the one far-away country would be flagged despite being entirely real.
    const counts = new Map<string, number>();
    const bboxKm = new Map<string, number>();
    const rings = new Map<string, [number, number][][]>();
    for (let i = 0; i < 19; i++) {
      const code = `C${i}`;
      counts.set(code, 100);
      bboxKm.set(code, 50);
      rings.set(code, [square(i, 40, 1)]); // clustered together, near the "core"
    }
    counts.set("FAR", 100);
    bboxKm.set("FAR", 50);
    rings.set("FAR", OTHER_RINGS); // far from every other country in the set
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.size).toBe(0);
  });
});

describe("elusivenessFromRanks", () => {
  it("centers on where the species lives, not on countries with the most records overall", async () => {
    const { elusivenessFromRanks } = await import("./compute-elusiveness.js");
    // Common at home (rank 0.1, 90,000 records), a few escaped pets abroad (rank 0.95, 12 records).
    const entries = [
      { iso3: "CRI", percentile: 0.1, speciesRecords: 90_000 },
      { iso3: "USA", percentile: 0.95, speciesRecords: 12 },
    ];
    expect(elusivenessFromRanks(entries, undefined)).toBeCloseTo(0.1, 2);
  });

  it("leaves escapee and vagrant countries out", async () => {
    const { elusivenessFromRanks } = await import("./compute-elusiveness.js");
    const entries = [
      { iso3: "CRI", percentile: 0.2, speciesRecords: 500 },
      { iso3: "GBR", percentile: 1, speciesRecords: 500 },
    ];
    expect(elusivenessFromRanks(entries, new Set(["GBR"]))).toBeCloseTo(0.2);
  });

  it("uses every country when all of them look like vagrant ones", async () => {
    const { elusivenessFromRanks } = await import("./compute-elusiveness.js");
    const entries = [{ iso3: "GBR", percentile: 0.8, speciesRecords: 10 }];
    expect(elusivenessFromRanks(entries, new Set(["GBR"]))).toBeCloseTo(0.8);
  });
});

describe("mergeByGbifKey", () => {
  it("adds up the records of names that stand for one species and keeps the widest spread", async () => {
    const { mergeByGbifKey } = await import("./compute-elusiveness.js");
    const merged = mergeByGbifKey([
      { gbifKey: 1, recordCount: 30, bboxDiagonalKm: 100 },
      { gbifKey: 2, recordCount: 5, bboxDiagonalKm: 10 },
      { gbifKey: 1, recordCount: 12, bboxDiagonalKm: 400 },
    ]);
    expect(merged).toEqual([
      { gbifKey: 1, recordCount: 42, bboxDiagonalKm: 400 },
      { gbifKey: 2, recordCount: 5, bboxDiagonalKm: 10 },
    ]);
  });
});
