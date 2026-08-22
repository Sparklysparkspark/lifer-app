// Phase-1 rarity per lifer-spec.md §7 MVP shortcut: range size + IUCN status only,
// no elusiveness (that's Phase 4). Tiers assigned by percentile so the distribution
// is deliberate (common 50% / uncommon 25% / rare 15% / epic 8% / legendary 2%).

// "unrated" — species with no IUCN status, no elusiveness crawl match, and no
// density/population/nocturnal signal — is deliberately NOT part of the percentile-quota
// ladder below. A percentile quota has to put ties SOMEWHERE, and this zero-signal group is
// large enough (36% of mammals, 41% of fish) that without this exclusion it gets fanned
// across every tier, including "legendary," by arbitrary DB row order. A species with
// nothing distinguishing it isn't "legendary" or "common" — it's simply unrated, which is a
// more honest state than fabricating a rank out of no data.
export type RarityTier = "common" | "uncommon" | "rare" | "epic" | "legendary" | "unrated";

export const IUCN_MODIFIER: Record<string, number> = {
  "Least Concern": 0,
  "Near Threatened": 0.15,
  Vulnerable: 0.35,
  Endangered: 0.6,
  "Critically Endangered": 0.85,
  "Extinct in the Wild": 1,
  Extinct: 1,
};

// species_traits.iucn_status is stored lowercase across every taxon ("vulnerable",
// "least concern", ...), but IUCN_MODIFIER's own keys are Title Case, so a plain
// `IUCN_MODIFIER[status]` lookup misses on every species and silently falls back to 0 —
// conservation status would never actually influence a tier. This case-insensitive lookup is
// the only sanctioned way to read the map.
const IUCN_MODIFIER_LOWERCASE = new Map(Object.entries(IUCN_MODIFIER).map(([k, v]) => [k.toLowerCase(), v]));
export function getIucnModifier(status: string | null | undefined): number {
  if (!status) return 0;
  return IUCN_MODIFIER_LOWERCASE.get(status.toLowerCase()) ?? 0;
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
  { tier: "epic", cumulativeShare: 0.1 },
  { tier: "rare", cumulativeShare: 0.25 },
  { tier: "uncommon", cumulativeShare: 0.5 },
  { tier: "common", cumulativeShare: 1 },
];

/** percentile in (0, 1], where a smaller percentile means "rarer" (closer to the top of a
 *  descending-composite sort) — shared by the global tier computation and the per-region
 *  "local tier" (see apps/api/src/regions/routes.ts), so both read the exact same buckets. */
export function tierForPercentile(percentile: number): RarityTier {
  return TIER_THRESHOLDS.find((t) => percentile <= t.cumulativeShare)!.tier;
}

// Absolute composite-value thresholds, not a fixed PERCENTILE quota (top 2%/8%/15%/25%/50%,
// above): a fixed quota forces exactly those shares regardless of the real score
// distribution's shape, so a species with a genuinely earned, high composite could still
// miss "rare" purely because enough OTHER species also cleared a similar bar, and a real
// one-off mega-rarity effect couldn't move a tier if the quota was already full. Tier is
// meant to track how hard a species is to photograph, not to fill a fixed number of slots,
// so a species should earn its tier on its own merit rather than compete for one.
//
// First calibrated to roughly match the old percentile quota's shape (common ~77%, uncommon
// ~12%, rare ~8%, epic ~3%, legendary ~0.6%) as a safe baseline, but that baseline was still
// too common-skewed: genuine rare-visitor/hard-to-see birds were still landing as
// common/uncommon. Shifted down ~0.05 across the board: common ~68%, uncommon ~15.5%, rare
// ~9%, epic ~5.5%, legendary ~1.6% (14,153 wild species). Birds specifically, not mammals —
// mammals have no real range-size source at all (every mammal gets the same flat 0.5 filler
// for that axis — see build-seed-mammals.ts), so their composite scale isn't comparable to
// birds' and needs its own calibration.
//
// Recalibrated a second time: a 5-species BC-only anchor ladder produced technically-correct
// local ordering but a globally meaningless distribution (31.5% of ALL birds landed
// "legendary"). Percentiles should VALIDATE thresholds, not determine them, but a
// wildly-skewed global share is itself evidence the cutoffs don't mean what the tier name
// says — so this was recalibrated against a much broader ~34-species global anchor set
// (House Sparrow/Mallard/Robin through Boreal Owl/California Condor/Harpy Eagle/Great
// Philippine Eagle), using the real gaps in their actual composite scores as the cutoffs,
// THEN checked against the full 14,550-bird distribution (common ~65% / uncommon ~14% / rare
// ~14% / epic ~4% / legendary ~3% — within the target smell-test bands). Two disclosed
// near-ties survive this calibration, not threshold artifacts but real signal gaps: Great
// Gray Owl vs. Black-backed Woodpecker (genuinely scarce/localized vs.
// hard-to-see-despite-widespread aren't yet distinguished), and Great Tit vs. Pileated
// Woodpecker (dense-canopy-but-readily-visits-feeders isn't distinguished from
// dense-canopy-and-genuinely-hard-to-see — AVONET's Habitat.Density alone conflates the two).
export const BIRD_ABSOLUTE_TIER_THRESHOLDS: Array<{ tier: RarityTier; minScore: number }> = [
  { tier: "legendary", minScore: 0.6 },
  { tier: "epic", minScore: 0.555 },
  { tier: "rare", minScore: 0.42 },
  { tier: "uncommon", minScore: 0.32 },
  { tier: "common", minScore: 0 },
];

// Mammals — same treatment as birds: a fixed percentile-quota system forces exactly
// 50/25/15/8/2% shares onto the documented pool regardless of what the real scores mean,
// which produced genuinely backwards results (Snow Leopard landing "common," Coyote/Striped
// Skunk/American Bison landing "epic"). Calibrated against a real anchor ladder checked in
// the DB after MAMMAL_WEIGHTS/MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT were rebalanced (see
// apply-rarity-phase4.ts): Coyote 0.632/Puma 0.636 (common/uncommon border — see below),
// White-tailed Deer 0.612, Gray Wolf 0.651, American Black Bear 0.691, Wolverine 0.763
// (anchor: a genuinely elusive species that belongs at "legendary"), Giant Panda 0.807,
// Tiger 0.887, Black Rhinoceros 0.905.
//
// Two disclosed, real limitations survive this calibration, same spirit as birds' own
// near-ties: (1) Coyote and Puma land in the SAME composite band (0.63-0.64) because nothing
// in the available data (IUCN status: both effectively "least concern"; density_per_km2:
// both genuinely low) distinguishes "low density but human-tolerant/bold" from "low density
// and genuinely elusive" — that would need real behavioral data (diel activity pattern,
// synanthropy) this pipeline doesn't have. Both land "uncommon" here, which undersells Puma's
// real difficulty but doesn't overclaim Coyote's. (2) Snow Leopard has NO species_traits
// signal at all in our DB (its GBIF-backbone name, "Uncia uncia," doesn't match Wikidata's
// modern taxonomic placement "Panthera uncia" — a real, disclosed synonym-matching gap, not a
// weight problem) and lands "common" purely on a middling raw elusiveness percentile. A
// species-name synonym-resolution pass would fix this; out of scope for this rebalance.
//
// Re-calibrated after adding the home-range boost + CASUAL_OBSERVATION_BASIS_OF_RECORD
// filter — both shifted the whole composite scale upward, so the earlier cutoffs
// (0.55/0.65/0.72/0.75) let White-tailed Deer cross into "rare." Re-anchored against the same
// ladder: Eastern Gray Squirrel 0.552/Red Fox 0.608/Moose 0.650/White-tailed Deer 0.658 stay
// common; Coyote 0.677/Puma 0.688/Gray Wolf 0.696 uncommon; American Black Bear 0.708/Bobcat
// 0.726 rare; Striped Skunk 0.734/American Bison 0.745 epic; Wolverine 0.754 (anchor) through
// Black Rhinoceros 0.925 legendary.
export const MAMMAL_ABSOLUTE_TIER_THRESHOLDS: Array<{ tier: RarityTier; minScore: number }> = [
  { tier: "legendary", minScore: 0.75 },
  { tier: "epic", minScore: 0.73 },
  { tier: "rare", minScore: 0.7 },
  { tier: "uncommon", minScore: 0.66 },
  { tier: "common", minScore: 0 },
];

// Fish — same treatment. Fish have much better IUCN coverage than mammals (~52%, and mostly
// not the uninformative "least concern" majority mammals have) and almost no density/
// nocturnal data to dilute it, so FISH_WEIGHTS leans on abundance even more than mammals do
// (see apply-rarity-phase4.ts) — and it shows in a genuinely well-shaped distribution rather
// than needing a wide "legendary" band the way mammals did. Calibrated against African
// Coelacanth (0.697 — one of the hardest fish alive to ever photograph, correctly separated
// from Brown Coelacanth's 0.510 by its Critically Endangered vs. lower-concern IUCN status),
// White Sturgeon (0.270, a real but attainable target), and common bait/pond fish (Bluegill,
// Largemouth Bass, Common Carpet Shark, Walleye Surfperch, all under 0.10).
export const FISH_ABSOLUTE_TIER_THRESHOLDS: Array<{ tier: RarityTier; minScore: number }> = [
  { tier: "legendary", minScore: 0.68 },
  { tier: "epic", minScore: 0.5 },
  { tier: "rare", minScore: 0.35 },
  { tier: "uncommon", minScore: 0.2 },
  { tier: "common", minScore: 0 },
];

export function tierForScore(score: number, thresholds: Array<{ tier: RarityTier; minScore: number }>): RarityTier {
  return thresholds.find((t) => score >= t.minScore)!.tier;
}

// Raw GBIF record-count ranking can't distinguish "genuinely easy to find" from "hard to
// find but disproportionately reported by dedicated observers who only log the successes" —
// several classically cryptic owl species land as "common" under raw record counts despite
// real field difficulty, because GBIF has no record of the countless unsuccessful attempts.
// Nocturnality (EltonTraits-sourced, real per-species data already
// in this pipeline, not a hand-curated guess) is a legitimate, systematic reason a species
// is harder to detect, so it gets folded in as a proportional boost to the elusiveness
// score itself — pushed toward "harder to detect" (1.0), scaled by how much room is left,
// rather than an arbitrary flat bonus. Species get RE-RANKED by their boosted score before
// tiers are assigned (not just nudged post-tiering), so the intended 50/25/15/8/2 share
// still means something — it can shift slightly (a nocturnal species displacing a
// non-nocturnal one at a tier boundary is the whole point), just not collapse.
const NOCTURNAL_ELUSIVENESS_BOOST = 0.4;

/** boostAmount in [0,1]: 0 = no change, 1 = pushed all the way to "hardest to detect." Both
 *  the nocturnal boost (below) and the population-density boost (real per-species population
 *  data ÷ range size, which distinguishes a low-density-despite-wide-range species like the
 *  Pileated Woodpecker from an abundant one — something neither range nor raw GBIF record
 *  volume alone can capture) share this same headroom-scaled shape. */
export function boostTowardHarderToDetect(score: number, boostAmount: number): number {
  return score + (1 - score) * boostAmount;
}

export function boostElusivenessForNocturnal(score: number, nocturnal: boolean | null): number {
  if (!nocturnal) return score;
  return boostTowardHarderToDetect(score, NOCTURNAL_ELUSIVENESS_BOOST);
}

// Density's boost is proportional to how low the density actually is (a continuous
// densityRarityScore, 0=high density, 1=lowest density among the comparison set) rather
// than nocturnal's flat on/off amount, scaled by the same cap so it can't dominate the
// nocturnal signal.
export const DENSITY_ELUSIVENESS_BOOST_WEIGHT = 0.4;

// Mammals originally got a stronger density boost than birds (1.0, vs. birds' 0.4), to solve
// the "range+abundance's ceiling caps every mammal's composite" problem that existed BEFORE
// mammals had their own MAMMAL_WEIGHTS split (see apply-rarity-phase4.ts). That full-strength
// weight became its own bug once that split existed: population DENSITY (biological
// individuals/km²) and PHOTOGRAPHIC encounter difficulty aren't the same axis — a habitat
// generalist that tolerates humans (Coyote, American Bison, Striped Skunk) can have
// genuinely low density yet be trivially easy to see, while weighting density at full
// strength pushed exactly those species' elusiveness near the ceiling right alongside truly
// cryptic species (Wolverine, Puma), collapsing the separation between "backyard-common" and
// "bucket-list rare" mammals into the same composite band. Brought back in line with birds'
// weight — density is now a real signal among several, not the dominant one.
export const MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT = 0.7;

export function boostElusivenessForDensity(
  score: number,
  densityRarityScore: number | null,
  weight: number = DENSITY_ELUSIVENESS_BOOST_WEIGHT,
): number {
  if (densityRarityScore == null) return score;
  return boostTowardHarderToDetect(score, densityRarityScore * weight);
}

// Species like the Pileated Woodpecker have real population and real range but live spread
// through dense closed-canopy forest and are famously "heard before seen" — a distinct kind
// of hard-to-detect that raw GBIF record volume, nocturnality, and population density none
// of them capture. AVONET's real Habitat.Density field (1=dense/closed canopy, 3=open —
// Pileated Woodpecker, Northern Goshawk, and Steller's Jay all sit at 1; American Robin at
// 3) is the direct signal for this. Same weight scale as nocturnal's 0.4 boost.
export const HABITAT_DENSITY_ELUSIVENESS_BOOST_WEIGHT = 0.4;

export function boostElusivenessForHabitatDensity(score: number, habitatDensity: number | null): number {
  if (habitatDensity == null) return score;
  // 1 (dense) -> 1.0 boost amount, 2 -> 0.5, 3 (open) -> 0.
  const boostAmount = (3 - habitatDensity) / 2;
  return boostTowardHarderToDetect(score, boostAmount * HABITAT_DENSITY_ELUSIVENESS_BOOST_WEIGHT);
}

// COMBINE's home_range_km2 was extracted since Phase 8 but never wired into rarity. It's a
// genuinely different signal from density — density is "individuals per unit area," home
// range is "ground one individual covers" — which is what actually predicts whether a
// fixed-location observer will have one wander past. This separates cases density alone
// can't: Puma's 129.89 km² home range vs. Coyote's 18.88 km² despite both having similarly
// low population density (Coyote just covers much less ground per individual and tolerates
// human-adjacent habitat). Same weight scale as nocturnal/habitat-density's 0.4 boost — a
// real per-species measurement, but sparse enough coverage (COMBINE doesn't have it for
// every mammal, and it doesn't exist at all for non-mammal taxa) that it shouldn't dominate
// the way density's mammal-specific weight does.
export const HOME_RANGE_ELUSIVENESS_BOOST_WEIGHT = 0.4;

export function boostElusivenessForHomeRange(score: number, homeRangeRarityScore: number | null): number {
  if (homeRangeRarityScore == null) return score;
  return boostTowardHarderToDetect(score, homeRangeRarityScore * HOME_RANGE_ELUSIVENESS_BOOST_WEIGHT);
}

// Percentile rank against every OTHER entry with a known value, not a linear ratio against
// the single largest value in the dataset. A ratio against the max is broken for range size:
// one outlier near-global-range species (e.g. a pantropical seabird) compresses everyone
// else's score toward the low/"common" end regardless of how genuinely widespread they are.
// That's exactly how Mallard (39.7M km² range, one of the most widespread ducks on Earth)
// ended up with a rangeScore of 0.71 — reading as "smallish" despite being enormous. Same
// fix already applied to the elusiveness axis (see compute-elusiveness.ts) — shared here
// since apply-rarity-phase4.ts also needs it to recompute range scores fresh instead of
// trusting whatever was stored before this fix.
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
    // Missing range data defaults to mid-pack (0.5) rather than accidentally scoring as
    // legendary.
    const rangeScore = rangeScoreByIdx.get(idx) ?? 0.5;
    const iucnModifier = getIucnModifier(input.iucnStatus);
    // Abundance isn't separately sourced in Phase 1 — IUCN status is the closest proxy we have.
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
