// Regression coverage for a case-sensitivity bug: species_traits.iucn_status is stored
// lowercase across every taxon, but IUCN_MODIFIER's own keys are Title Case. A plain
// `IUCN_MODIFIER[status]` lookup silently missed on every species (e.g. American Black Bear
// landing "epic" despite Least Concern status); getIucnModifier is the only sanctioned way
// to read the map specifically to keep this from regressing.
import { describe, expect, it } from "vitest";
import {
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT,
  boostElusivenessForDensity,
  boostElusivenessForHabitatDensity,
  boostElusivenessForNocturnal,
  boostTowardHarderToDetect,
  computeRarityPhase1,
  getIucnModifier,
  percentileRankScores,
  tierForScore,
} from "./compute-rarity-phase1.js";

describe("getIucnModifier", () => {
  it("matches regardless of case (the actual DB storage format is lowercase)", () => {
    expect(getIucnModifier("least concern")).toBe(0);
    expect(getIucnModifier("Least Concern")).toBe(0);
    expect(getIucnModifier("vulnerable")).toBe(0.35);
    expect(getIucnModifier("Vulnerable")).toBe(0.35);
    expect(getIucnModifier("CRITICALLY ENDANGERED")).toBe(0.85);
  });

  it("returns 0 for null/undefined/unknown status rather than throwing", () => {
    expect(getIucnModifier(null)).toBe(0);
    expect(getIucnModifier(undefined)).toBe(0);
    expect(getIucnModifier("not a real status")).toBe(0);
  });
});

describe("percentileRankScores", () => {
  it("gives the smallest value the highest score (rarest) and the largest the lowest", () => {
    const scores = percentileRankScores([
      { idx: 0, value: 100 },
      { idx: 1, value: 1 },
      { idx: 2, value: 50 },
    ]);
    expect(scores.get(1)).toBe(1); // smallest -> rarest
    expect(scores.get(0)).toBe(0); // largest -> most common
    expect(scores.get(2)).toBeCloseTo(0.5);
  });

  it("does not blow up on a single value", () => {
    const scores = percentileRankScores([{ idx: 0, value: 42 }]);
    expect(scores.get(0)).toBe(0.5);
  });
});

describe("boostTowardHarderToDetect / nocturnal / density boosts", () => {
  it("boostTowardHarderToDetect scales by remaining headroom, never exceeding 1", () => {
    expect(boostTowardHarderToDetect(0.5, 0)).toBe(0.5);
    expect(boostTowardHarderToDetect(0.5, 1)).toBe(1);
    expect(boostTowardHarderToDetect(0.9, 0.4)).toBeCloseTo(0.94);
  });

  it("boostElusivenessForNocturnal only boosts actually-nocturnal species", () => {
    expect(boostElusivenessForNocturnal(0.5, true)).toBeGreaterThan(0.5);
    expect(boostElusivenessForNocturnal(0.5, false)).toBe(0.5);
    expect(boostElusivenessForNocturnal(0.5, null)).toBe(0.5);
  });

  it("boostElusivenessForDensity leaves the score untouched when density is unknown", () => {
    expect(boostElusivenessForDensity(0.5, null)).toBe(0.5);
    expect(boostElusivenessForDensity(0.5, 1)).toBeGreaterThan(0.5);
    expect(boostElusivenessForDensity(0.5, 0)).toBe(0.5);
  });

  it("boostElusivenessForDensity defaults to the shared (bird) weight, but accepts an override", () => {
    // Mammals get a stronger density boost than birds (still below full strength — see
    // MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT's own comment: a full 1.0 weight let population
    // density alone override real photographic difficulty, e.g. Coyote/Bison scoring as hard
    // as Wolverine purely from both having low biological density).
    const defaultBoost = boostElusivenessForDensity(0.5, 1);
    const strongerBoost = boostElusivenessForDensity(0.5, 1, MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT);
    expect(strongerBoost).toBeGreaterThan(defaultBoost);
    expect(strongerBoost).toBeCloseTo(0.5 + 0.5 * MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT);
  });

  it("boostElusivenessForHabitatDensity boosts dense-habitat species more than open-habitat ones", () => {
    // Matches real AVONET data: dense closed-canopy species (Pileated Woodpecker, Northern
    // Goshawk, Steller's Jay) sit at Habitat.Density=1; open-habitat species (American
    // Robin) sit at 3.
    const dense = boostElusivenessForHabitatDensity(0.5, 1);
    const semiOpen = boostElusivenessForHabitatDensity(0.5, 2);
    const open = boostElusivenessForHabitatDensity(0.5, 3);
    expect(dense).toBeGreaterThan(semiOpen);
    expect(semiOpen).toBeGreaterThan(open);
    expect(open).toBe(0.5); // fully open habitat -> no boost at all
  });

  it("boostElusivenessForHabitatDensity leaves the score untouched when habitat data is unknown", () => {
    expect(boostElusivenessForHabitatDensity(0.5, null)).toBe(0.5);
  });
});

describe("computeRarityPhase1", () => {
  it("a Critically Endangered species with a small range outranks (rarer than) a Least Concern species with a huge range", () => {
    const [endangered, common] = computeRarityPhase1([
      { scientificName: "Rare Thing", rangeSizeKm2: 100, iucnStatus: "critically endangered" },
      { scientificName: "Common Thing", rangeSizeKm2: 10_000_000, iucnStatus: "least concern" },
    ]);
    expect(endangered.composite).toBeGreaterThan(common.composite);
  });

  it("defaults missing range data to mid-pack (0.5) rather than reading as legendary", () => {
    const [noRange] = computeRarityPhase1([{ scientificName: "Unknown Range", rangeSizeKm2: null, iucnStatus: null }]);
    expect(noRange.rangeScore).toBe(0.5);
  });

  it("preserves input order in the output regardless of internal sort-by-composite", () => {
    const inputs = [
      { scientificName: "A", rangeSizeKm2: 500, iucnStatus: "vulnerable" },
      { scientificName: "B", rangeSizeKm2: 5, iucnStatus: "critically endangered" },
      { scientificName: "C", rangeSizeKm2: 50_000, iucnStatus: "least concern" },
    ];
    const results = computeRarityPhase1(inputs);
    expect(results.map((r) => r.scientificName)).toEqual(["A", "B", "C"]);
  });
});

describe("tierForScore / BIRD_ABSOLUTE_TIER_THRESHOLDS", () => {
  it("assigns a tier purely by the score's own value, not by rank among peers", () => {
    expect(tierForScore(0.65, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("legendary");
    expect(tierForScore(0.57, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("epic");
    expect(tierForScore(0.5, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("rare");
    expect(tierForScore(0.4, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("uncommon");
    expect(tierForScore(0.2, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("common");
  });

  it("is exact at threshold boundaries (>= not >)", () => {
    expect(tierForScore(0.6, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("legendary");
    expect(tierForScore(0.599999, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("epic");
  });

  it("a species can reach the top tier regardless of how many other species also clear the bar", () => {
    // The whole point of switching away from percentile quotas: unlike tierForPercentile,
    // this never depends on a comparison pool's size or composition.
    const allHighScores = [0.9, 0.91, 0.92, 0.93, 0.95];
    for (const score of allHighScores) {
      expect(tierForScore(score, BIRD_ABSOLUTE_TIER_THRESHOLDS)).toBe("legendary");
    }
  });
});
