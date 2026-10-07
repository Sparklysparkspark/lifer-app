import { normalizeIucnStatus, type IucnCode } from "@lifer/shared";

// Phase-1 rarity: range size + IUCN status only, no elusiveness (that's Phase 4). Tiers are
// assigned by percentile (common 50% / occasional 25% / uncommon 15% / rare 8% / legendary 2%).

// "unrated" is for species with no real signal at all (no IUCN status, crawl match, or trait
// data). It sits outside the percentile ladder so large tie blocks aren't fanned across tiers
// by row order.
export type RarityTier = "common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated";

export const IUCN_MODIFIER: Record<IucnCode, number> = {
  LC: 0,
  // Not Evaluated says nothing about the species: no signal, same as no status.
  NE: 0,
  // Data Deficient is a real signal of obscurity: a well-observed species almost always gets a
  // real category. Set below Vulnerable since it reflects uncertainty, not confirmed risk.
  DD: 0.3,
  NT: 0.15,
  // Lower Risk/conservation dependent (1994 criteria) sat between Near Threatened and Vulnerable.
  "LR/cd": 0.15,
  VU: 0.35,
  EN: 0.6,
  CR: 0.85,
  EW: 1,
  EX: 1,
};

// Stored values are codes (migration 129), but a legacy spelling still resolves.
export function getIucnModifier(status: string | null | undefined): number {
  const code = normalizeIucnStatus(status);
  return code ? IUCN_MODIFIER[code] : 0;
}

export interface RarityInput {
  scientificName: string;
  rangeSizeKm2: number | null;
  iucnStatus: string | null;
}

export interface RarityOutput extends RarityInput {
  rangeScore: number;
  abundanceScore: number;
  elusivenessScore: null;
  composite: number;
  tier: RarityTier;
}

export const TIER_THRESHOLDS: Array<{ tier: RarityTier; cumulativeShare: number }> = [
  { tier: "legendary", cumulativeShare: 0.02 },
  { tier: "rare", cumulativeShare: 0.1 },
  { tier: "uncommon", cumulativeShare: 0.25 },
  { tier: "occasional", cumulativeShare: 0.5 },
  { tier: "common", cumulativeShare: 1 },
];

/** percentile in (0, 1], smaller = rarer. Shared by the global tier and the per-region local
 *  tier (see apps/api/src/regions/routes.ts), so both use the same buckets. */
export function tierForPercentile(percentile: number): RarityTier {
  return TIER_THRESHOLDS.find((t) => percentile <= t.cumulativeShare)!.tier;
}

// Absolute composite thresholds rather than a percentile quota: tier tracks how hard a species
// is to photograph, so a species earns its tier on its own score instead of filling a fixed
// number of slots. Calibrated on an anchor ladder of well-known birds from common to legendary.
// Birds only: other taxa lack a range axis, so their composites aren't comparable.
export const BIRD_ABSOLUTE_TIER_THRESHOLDS: Array<{ tier: RarityTier; minScore: number }> = [
  { tier: "legendary", minScore: 0.6 },
  { tier: "rare", minScore: 0.555 },
  { tier: "uncommon", minScore: 0.42 },
  { tier: "occasional", minScore: 0.32 },
  { tier: "common", minScore: 0 },
];

// Mammals: calibrated on an anchor ladder of well-known mammals after the MAMMAL_WEIGHTS and
// density-weight rebalances (see apply-rarity-phase4.ts). Known limit: nothing in the data
// separates low-density-but-bold species from low-density elusive ones.
export const MAMMAL_ABSOLUTE_TIER_THRESHOLDS: Array<{ tier: RarityTier; minScore: number }> = [
  { tier: "legendary", minScore: 0.75 },
  { tier: "rare", minScore: 0.73 },
  { tier: "uncommon", minScore: 0.7 },
  { tier: "occasional", minScore: 0.66 },
  { tier: "common", minScore: 0 },
];

// Fish: FISH_WEIGHTS leans on IUCN abundance (see apply-rarity-phase4.ts), which gives a
// well-shaped distribution. Calibrated on anchor species from common pond fish to coelacanths.
export const FISH_ABSOLUTE_TIER_THRESHOLDS: Array<{ tier: RarityTier; minScore: number }> = [
  { tier: "legendary", minScore: 0.68 },
  { tier: "rare", minScore: 0.5 },
  { tier: "uncommon", minScore: 0.35 },
  { tier: "occasional", minScore: 0.2 },
  { tier: "common", minScore: 0 },
];

export function tierForScore(score: number, thresholds: Array<{ tier: RarityTier; minScore: number }>): RarityTier {
  return thresholds.find((t) => score >= t.minScore)!.tier;
}

// GBIF record counts can't see failed searches, so cryptic nocturnal species look common.
// Nocturnality (EltonTraits) boosts elusiveness proportionally toward 1.0, scaled by the
// remaining headroom, and species are re-ranked on the boosted score before tiering.
const NOCTURNAL_ELUSIVENESS_BOOST = 0.4;

/** boostAmount in [0,1]: 0 = no change, 1 = pushed all the way to "hardest to detect". Every
 *  elusiveness boost shares this headroom-scaled shape. */
export function boostTowardHarderToDetect(score: number, boostAmount: number): number {
  return score + (1 - score) * boostAmount;
}

export function boostElusivenessForNocturnal(score: number, nocturnal: boolean | null): number {
  if (!nocturnal) return score;
  return boostTowardHarderToDetect(score, NOCTURNAL_ELUSIVENESS_BOOST);
}

// Curated, since no trait dataset flags cryptic fish. Camouflaged, site-faithful species get
// shown to many divers at known spots, so GBIF volume overstates how easy they are to find
// yourself. Same magnitude as the nocturnal boost: a coarse family-level trait.
export const CAMOUFLAGE_ELUSIVENESS_BOOST = 0.4;

// Families known among divers for extreme camouflage or site fidelity: frogfish,
// seahorses/pipefish/seadragons, ghost pipefish, stonefish, scorpionfish and seamoths.
export const CAMOUFLAGED_FISH_FAMILIES = new Set([
  "Antennariidae",
  "Syngnathidae",
  "Solenostomidae",
  "Synanceiidae",
  "Scorpaenidae",
  "Pegasidae",
]);

export function boostElusivenessForCamouflage(score: number, family: string | null): number {
  if (!family || !CAMOUFLAGED_FISH_FAMILIES.has(family)) return score;
  return boostTowardHarderToDetect(score, CAMOUFLAGE_ELUSIVENESS_BOOST);
}

// Density's boost scales with how low the density is (0 = high, 1 = lowest in the comparison
// set), capped by the same weight as nocturnal.
export const DENSITY_ELUSIVENESS_BOOST_WEIGHT = 0.4;

// Mammals get a stronger density weight than birds, but not full strength: population density
// isn't encounter difficulty, and at full weight human-tolerant low-density species landed
// alongside truly cryptic ones.
export const MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT = 0.7;

export function boostElusivenessForDensity(
  score: number,
  densityRarityScore: number | null,
  weight: number = DENSITY_ELUSIVENESS_BOOST_WEIGHT,
): number {
  if (densityRarityScore == null) return score;
  return boostTowardHarderToDetect(score, densityRarityScore * weight);
}

// Birds of dense closed-canopy forest are "heard before seen", which record volume, nocturnality
// and density don't capture. AVONET's Habitat.Density (1 = dense, 3 = open) is the signal.
export const HABITAT_DENSITY_ELUSIVENESS_BOOST_WEIGHT = 0.4;

export function boostElusivenessForHabitatDensity(score: number, habitatDensity: number | null): number {
  if (habitatDensity == null) return score;
  // 1 (dense) -> 1.0 boost amount, 2 -> 0.5, 3 (open) -> 0.
  const boostAmount = (3 - habitatDensity) / 2;
  return boostTowardHarderToDetect(score, boostAmount * HABITAT_DENSITY_ELUSIVENESS_BOOST_WEIGHT);
}

// Home range (COMBINE, mammals) is distinct from density: how much ground one individual
// covers, which predicts whether one wanders past a fixed observer. Sparse coverage, so it
// keeps the standard 0.4 weight.
export const HOME_RANGE_ELUSIVENESS_BOOST_WEIGHT = 0.4;

export function boostElusivenessForHomeRange(score: number, homeRangeRarityScore: number | null): number {
  if (homeRangeRarityScore == null) return score;
  return boostTowardHarderToDetect(score, homeRangeRarityScore * HOME_RANGE_ELUSIVENESS_BOOST_WEIGHT);
}

// A species concentrated in one small hotspot needs travel to see even with many records, while
// a common species' records are spread across the region. Compares a species' occurrence
// bbox diagonal (relative to the region's) against other species in the same region.
export const DISTRIBUTION_ELUSIVENESS_BOOST_WEIGHT = 0.4;

export function boostElusivenessForDistribution(score: number, distributionRarityScore: number | null): number {
  if (distributionRarityScore == null) return score;
  return boostTowardHarderToDetect(score, distributionRarityScore * DISTRIBUTION_ELUSIVENESS_BOOST_WEIGHT);
}

// Percentile rank against the other entries with a known value, not a ratio against the max,
// which lets one near-global outlier compress everyone else toward "common". Shared with
// apply-rarity-phase4.ts, which recomputes range scores with it.
export function percentileRankScores(values: Array<{ idx: number; value: number }>): Map<number, number> {
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const scoreByIdx = new Map<number, number>();
  const n = sorted.length;
  sorted.forEach((entry, rank) => {
    // rank 0 = smallest value -> score 1 (rarest/most elusive); largest value -> score 0.
    scoreByIdx.set(entry.idx, n > 1 ? 1 - rank / (n - 1) : 0.5);
  });
  return scoreByIdx;
}

export function computeRarityPhase1(inputs: RarityInput[]): RarityOutput[] {
  const validIndexes = inputs
    .map((input, idx) => ({ idx, value: input.rangeSizeKm2 }))
    .filter((e): e is { idx: number; value: number } => e.value != null && e.value > 0);
  const rangeScoreByIdx = percentileRankScores(validIndexes);

  const withComposite = inputs.map((input, idx) => {
    // Missing range data defaults to mid-pack (0.5) rather than scoring as legendary.
    const rangeScore = rangeScoreByIdx.get(idx) ?? 0.5;
    const iucnModifier = getIucnModifier(input.iucnStatus);
    // Abundance isn't separately sourced in Phase 1; IUCN status is the closest proxy we have.
    const abundanceScore = iucnModifier;
    const composite = 0.6 * rangeScore + 0.4 * iucnModifier;

    return { ...input, rangeScore, abundanceScore, elusivenessScore: null as null, composite };
  });

  const sorted = [...withComposite].sort((a, b) => b.composite - a.composite);
  const n = sorted.length;
  const tiered = sorted.map((row, idx) => {
    const percentile = (idx + 1) / n;
    const tier = TIER_THRESHOLDS.find((t) => percentile <= t.cumulativeShare)!.tier;
    return { ...row, tier };
  });

  // Restore original input order.
  const byName = new Map(tiered.map((r) => [r.scientificName, r]));
  return inputs.map((i) => byName.get(i.scientificName)!);
}
