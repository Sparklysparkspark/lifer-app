// Regression coverage for the cross-taxon volume bug: American Black
// Bear, with 62,920 real global GBIF records, was landing elusiveness_score=0.7 ("hard to
// detect") because birds and mammals were once combined into ONE ranked group per country. Bird
// record volumes dwarf mammal volumes even for genuinely common mammals, so every mammal was
// effectively measured on a bird-scale yardstick. This test drives computeElusiveness with
// fabricated per-country counts standing in for real GBIF data (birds: huge volume; mammals:
// tiny volume, one clearly common, one clearly rare) and asserts each taxon group is ranked
// only against itself.
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
      // Birds: huge record volume, dwarfing mammals by orders of magnitude — exactly the
      // real-world shape that caused the original bug when both groups were ranked together.
      if (taxonKeys.includes(999)) {
        return [
          { gbifKey: BIRD_A, recordCount: 50_000 },
          { gbifKey: BIRD_B, recordCount: 100 },
        ];
      }
      // Mammals: tiny volume in absolute terms, but MAMMAL_COMMON is still the clearly more
      // common of the two mammals present.
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

    // The mammal with 2,000 records is the MORE COMMON of the two mammals (lower
    // elusiveness) even though it has far fewer raw records than either bird — if the bug
    // regressed, mammals would be scored relative to birds' huge volume and both mammals
    // would incorrectly cluster near elusiveness 1.0.
    const commonMammalScore = result.byGbifKey.get(MAMMAL_COMMON)!;
    const rareMammalScore = result.byGbifKey.get(MAMMAL_RARE)!;
    expect(commonMammalScore).toBeLessThan(rareMammalScore);
    // A real regression threshold, not just a relative check: the common mammal must read
    // as genuinely easy to detect, not "elusive because birds exist."
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
  // Two countries far apart (>500km) in every case below — distance alone is never the
  // discriminator being tested here, concentration is.
  const CORE_RINGS = [square(0, 0, 1)];
  const OTHER_RINGS = [square(20, 0, 1)];

  it("flags a scattered escapee population far from a concentrated real core", () => {
    // Real numbers from the confirmed live case: Black-Cheeked Lovebird, wild only in Zambia
    // (176 records / 405km bbox, concentration ≈0.435) with more raw records from South African
    // cage-bird escapees (387 records / 1386km bbox, concentration ≈0.279 — about 64% of
    // Zambia's, clearly below the "is this really a second real population" bar).
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
    // A species with two genuinely separate native populations far apart (a real disjunct
    // range) — the second country's own concentration is close to the core's, not radically
    // worse, which is what a real population (wherever it is) actually looks like.
    const counts = new Map([
      ["USA", 10_000],
      ["MEX", 4_000],
    ]);
    const bboxKm = new Map([
      ["USA", 500], // concentration = 20
      ["MEX", 250], // concentration = 16 (80% of core — well above the 0.7 ratio bar)
    ]);
    const rings = new Map([
      ["USA", CORE_RINGS],
      ["MEX", OTHER_RINGS],
    ]);
    const vagrant = computeVagrantCountries(counts, bboxKm, rings, new Map());
    expect(vagrant.size).toBe(0);
  });

  it("skips vagrant detection entirely once a species spans too many countries", () => {
    // A species genuinely present in dozens of countries (a cosmopolitan or long-distance
    // migratory species — Rock Pigeon, Barn Swallow, Osprey, real confirmed cases) has no single
    // "core" at all; forcing a one-core model onto it flagged its entire real range as fake in
    // production. 20 countries, only one on the far side of the world from a manufactured
    // "core" — without this gate that one country would be flagged despite being entirely real.
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
