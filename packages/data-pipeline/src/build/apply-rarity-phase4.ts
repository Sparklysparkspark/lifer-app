// Folds the elusiveness axis (compute-elusiveness.ts) into the composite rarity score and
// re-tiers every species by percentile — done as a full recompute over the whole species
// table, not an incremental patch, because tiers are percentile-based: adding one new axis
// shifts where every cutoff falls, so a partial update would leave the distribution wrong.
import { pool } from "../db.js";
import {
  TIER_THRESHOLDS,
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_ABSOLUTE_TIER_THRESHOLDS,
  FISH_ABSOLUTE_TIER_THRESHOLDS,
  tierForScore,
  getIucnModifier,
  percentileRankScores,
  boostElusivenessForNocturnal,
  boostElusivenessForDensity,
  boostElusivenessForHabitatDensity,
  boostElusivenessForHomeRange,
  MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT,
  type RarityTier,
} from "./compute-rarity-phase1.js";

// Rebalanced toward elusiveness a second time. The old 0.35/0.25/0.4 split created a hard
// ceiling for any genuinely widespread, abundant species — even a maxed-out elusiveness
// score of 1.0 could only contribute 0.4 to the composite, below the 0.50 "uncommon" cutoff,
// so range+abundance's combined 60% weight always voted "common" regardless of real
// detectability evidence (e.g. Pileated Woodpecker). Tier is meant to track photographic
// encounter difficulty, with biological range/abundance as a moderating factor, not the
// dominant one. Elusiveness (which now also carries the real AVONET habitat-density signal)
// is the majority weight; range and abundance split the rest evenly.
const WEIGHTS = { range: 0.2, abundance: 0.2, elusiveness: 0.6 };

// Mammals AND fish have NO range-size source at all: every species in these taxa gets the
// exact same flat 0.5 filler for the range axis, a constant that carries zero real
// information but still eats 0.2 of composite's weight. Dropped entirely for both and
// reallocated onto abundance/elusiveness, which — unlike range — ARE real, differentiating
// axes for these taxa.
//
// Explicit, hand-calibrated splits, NOT derived proportionally from birds' WEIGHTS: that
// derivation ({abundance: 0.25, elusiveness: 0.75} for both) is what caused the mammal/fish
// miscalibration this replaces. Elusiveness can't carry birds'-level weight for these taxa
// because birds' elusiveness axis works only because eBird gives a huge, consistent,
// casual-observer-driven record volume that tracks real encounter difficulty. GBIF's
// mammal/fish records lean far more on museum specimens, camera-trap research, and fisheries
// surveys — volume there reflects research/reporting interest, not how hard an ordinary
// photographer would find the species. Two concrete, real anchor species exposed this:
// Coyote/Striped Skunk/American Bison (all common, human-tolerant, but with genuinely low
// biological population density) landed in the SAME composite band as Wolverine/Puma
// (genuinely elusive) purely because the density boost couldn't distinguish "low density but
// bold/common" from "low density and truly cryptic" — and African Coelacanth (one of the
// hardest fish alive to ever photograph) landed only "uncommon" despite IUCN correctly
// flagging it Critically Endangered, because elusiveness's 0.6 share diluted that
// authoritative signal down to a rounding error. Shifting weight toward abundance
// (IUCN-status-driven, authoritative, not GBIF-record-volume-driven) directly targets both
// failures without needing a better behavioral-difficulty signal that doesn't exist yet for
// either taxon.
const MAMMAL_WEIGHTS = { abundance: 0.2, elusiveness: 0.8 };
// Fish have noticeably better IUCN coverage than mammals (~52% vs. ~70%-but-mostly-
// "least concern"-so-uninformative) and almost no density/nocturnal data to boost with (21
// and 18 of 47,345 species respectively) — so abundance is an even more load-bearing signal
// here than for mammals.
const FISH_WEIGHTS = { abundance: 0.6, elusiveness: 0.4 };

// Abundance blends the official IUCN threat modifier (an authoritative but coarse 7-bucket
// signal — most birds are simply "Least Concern," giving zero differentiation) with a real
// population-size percentile (Callaghan et al. 2021) so species with a genuinely small
// population but no formal at-risk listing still register as scarcer than an abundant one.
// Weighted toward IUCN since it's the more authoritative of the two.
const ABUNDANCE_IUCN_WEIGHT = 0.6;

// A species absent from every one of the ~227 well-sampled countries' facets isn't a
// neutral unknown — never once clearing a real-world citizen-science reporting threshold
// ANYWHERE is itself evidence it's hard to detect (many bats fall into this category). For a
// life-list app specifically, where tier tracks how hard a species would be to find and
// photograph, that's a more honest default than mid-pack — a purely percentile-based
// fallback would otherwise leave species like Wolverine at "uncommon" even with real density
// data maxing out its elusiveness, since ~36% of all wild mammals tie at exactly the same
// "no data at all" composite, inflating the apparent size of the common/uncommon pool. Kept
// below 1.0 — it's an inference, not a confirmed severe rarity, so a species with real data
// showing genuine extreme scarcity can still outrank it.
const NO_CRAWL_DATA_ELUSIVENESS_DEFAULT = 0.75;

// Extracted so the default-vs-real-data branch (and the bigint gotcha below) is independently
// unit-testable without needing the whole-table DB recompute this file otherwise requires.
// species.gbif_key is a bigint column — node-postgres returns bigint as a STRING at runtime
// regardless of the TS type, so this Map (keyed by real numbers) misses every lookup unless
// Number() is applied here — without it, every bird ends up with exactly the 0.5 fallback
// (all 14,641 would have elusiveness_score === 0.5 with zero exceptions).
export function resolveRawElusivenessScore(elusivenessByGbifKey: Map<number, number>, gbifKey: number | string): number {
  return elusivenessByGbifKey.get(Number(gbifKey)) ?? NO_CRAWL_DATA_ELUSIVENESS_DEFAULT;
}

// INVARIANT: elusivenessByGbifKey must always be the RAW, pre-boost percentile score
// straight out of computeElusiveness's own crawl. This function applies the
// nocturnal/density boosts itself (below); the value it WRITES to
// species_rarity.elusiveness_score is already fully boosted. A one-off script that tries to
// skip re-crawling by reading that already-boosted stored value back out and passing it in
// here as elusivenessByGbifKey will double-apply the boost — this has happened in practice
// when a mammal-only recovery script reused birds'/fish's stored scores as input. There is
// no persisted raw/pre-boost value to safely reuse — the only correct way to reapply this
// axis is a fresh call to computeElusiveness().
export async function applyElusiveness(
  elusivenessByGbifKey: Map<number, number>,
  endemicCountryIso3ByGbifKey: Map<number, string> = new Map(),
): Promise<void> {
  // Range score is recomputed fresh from species_traits here rather than trusted from the
  // stored species_rarity.range_score — that stored value could still carry the old, broken
  // "ratio against the single largest range" formula (see compute-rarity-phase1.ts) from
  // whichever build originally wrote it. Re-deriving it here means one rerun of this script
  // fixes already-loaded species too, not just future builds.
  // fully_extinct species are excluded from the ranking pool entirely, not just hidden from
  // listings — an extinct species can't be photographed, so it has no place in a
  // photographic-difficulty ranking. Leaving them in would also skew where the real tier
  // boundaries fall for genuinely photographable species, since a species with zero real
  // observations gets the "probably hard to find" default, which can push its composite
  // artificially high.
  const res = await pool.query(
    `SELECT s.id, s.gbif_key, s.taxon_class, t.range_size_km2, t.iucn_status, t.nocturnal, t.population_estimate, t.density_per_km2, t.home_range_km2, t.habitat_density, t.domestic
     FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE t.fully_extinct = false`,
  );
  const rows = res.rows as Array<{
    id: string;
    gbif_key: number;
    taxon_class: string;
    range_size_km2: string | null;
    iucn_status: string | null;
    nocturnal: boolean | null;
    population_estimate: string | null;
    density_per_km2: string | null;
    home_range_km2: string | null;
    habitat_density: number | null;
    domestic: boolean;
  }>;

  const tiered: Array<{ id: string; rangeScore: number; abundanceScore: number; elusivenessScore: number; composite: number; tier: RarityTier }> = [];

  // Domestic species (cattle, goats, sheep, etc.) never enter the ranking pool below — their
  // GBIF record volume measures how often people photograph farm animals, not real rarity,
  // so ranking them against wild species (or letting them skew wild species' percentiles)
  // would be meaningless either direction. Forced to a fixed "common" tier instead.
  const domesticRows = rows.filter((r) => r.domestic);
  const wildRows = rows.filter((r) => !r.domestic);
  for (const row of domesticRows) {
    tiered.push({ id: row.id, rangeScore: 0, abundanceScore: 0, elusivenessScore: 0, composite: 0, tier: "common" });
  }

  // Percentile-ranked BY TAXON, not globally across every species regardless of taxon.
  // Mammals/fish currently have no range or elusiveness data at all, so 71,781 of 82,865
  // species (87%!) share the exact same "everything missing" default composite (0.375).
  // Ranked globally, that one giant tie-block would span clean across multiple tier
  // boundaries, and depending on arbitrary DB row order within the tie, it would silently
  // eat the entire "uncommon" tier and over-inflate "epic" — for BIRDS specifically, even
  // though birds themselves mostly have real data. Scoping both the
  // range percentile and the final tier percentile to each taxon_class means birds are only
  // ever compared against other birds with comparably real data, so one taxon's missing
  // data can't distort another's tiers. (Mammals/fish still mostly tie with each other for
  // now, since neither axis has real source data for them yet — a real, disclosed gap, not
  // hidden by this fix, just no longer able to leak into birds.)
  const byTaxon = new Map<string, typeof wildRows>();
  for (const row of wildRows) {
    if (!byTaxon.has(row.taxon_class)) byTaxon.set(row.taxon_class, []);
    byTaxon.get(row.taxon_class)!.push(row);
  }

  for (const taxonRows of byTaxon.values()) {
    const validRangeIndexes = taxonRows
      .map((row, idx) => ({ idx, value: row.range_size_km2 != null ? Number(row.range_size_km2) : null }))
      .filter((e): e is { idx: number; value: number } => e.value != null && e.value > 0);
    const rangeScoreByIdx = percentileRankScores(validRangeIndexes);

    // Real population size (Callaghan et al. 2021) feeds two things: a population-size
    // percentile blended into abundance below, and — divided by range — a genuine
    // population-DENSITY signal that boosts elusiveness the same way nocturnality does.
    // This is what distinguishes a species like the Pileated Woodpecker (wide range, real
    // population data showing it's genuinely sparse per unit area) from an abundant
    // species with a similar range — a distinction neither range nor raw GBIF record
    // volume alone can make.
    const validPopulationIndexes = taxonRows
      .map((row, idx) => ({ idx, value: row.population_estimate != null ? Number(row.population_estimate) : null }))
      .filter((e): e is { idx: number; value: number } => e.value != null && e.value > 0);
    const populationScoreByIdx = percentileRankScores(validPopulationIndexes);

    const validDensityIndexes = taxonRows
      .map((row, idx) => {
        // Real per-species population DENSITY, not derived from range at all.
        // population_estimate/range_size_km2 are Callaghan/AVONET fields that only exist
        // for birds, so a density signal derived purely from those two fields would never
        // fire for a single mammal. COMBINE's own density_per_km2 (fetched and stored since
        // Phase 8) is the direct signal needed for mammals — Wolverine's 0.008/km² is
        // genuinely one of the lowest of any mammal, real quantified support for "you will
        // basically never be near one," which raw GBIF record-count elusiveness alone
        // doesn't capture for a species with a huge, well-sampled range. Falls back to the
        // birds-only derived density when COMBINE has nothing (fish/reptiles/etc. have
        // neither source).
        const combineDensity = row.density_per_km2 != null ? Number(row.density_per_km2) : null;
        const population = row.population_estimate != null ? Number(row.population_estimate) : null;
        const range = row.range_size_km2 != null ? Number(row.range_size_km2) : null;
        const derivedDensity = population != null && range != null && range > 0 ? population / range : null;
        const density = combineDensity ?? derivedDensity;
        return { idx, value: density };
      })
      .filter((e): e is { idx: number; value: number } => e.value != null);
    // percentileRankScores gives 1.0 to the SMALLEST value — exactly "lowest density," which
    // is what should get the biggest elusiveness boost, so no inversion needed here.
    const densityScoreByIdx = percentileRankScores(validDensityIndexes);

    // Home range size (COMBINE, mammals): extracted and stored since Phase 8 but not
    // previously wired into rarity. A real, DIFFERENT signal from density — density measures
    // "how many individuals share a unit area," home range measures "how much ground one
    // individual covers," which is what actually determines how likely a fixed-location
    // observer (a photographer at a trailhead, a backyard, a known lookout) is to have one
    // wander past. This is the separation the density-only signal can't make: Puma's home
    // range (129.89 km²) dwarfs Coyote's (18.88 km²) even though both have similarly low
    // population density — Coyote covers less ground per individual and tolerates
    // human-adjacent habitat, so it's genuinely more likely to be encountered despite the
    // misleadingly-similar density figure. Wolverine's 343.27 km² is the largest in this
    // anchor set, consistent with it being the hardest of the group. Largest home range
    // should get the BIGGEST boost — the opposite direction from density's "smallest value
    // wins" — so values are negated before ranking rather than inverting the shared
    // percentileRankScores helper itself.
    const validHomeRangeIndexes = taxonRows
      .map((row, idx) => ({ idx, value: row.home_range_km2 != null ? -Number(row.home_range_km2) : null }))
      .filter((e): e is { idx: number; value: number } => e.value != null);
    const homeRangeScoreByIdx = percentileRankScores(validHomeRangeIndexes);

    const withElusiveness = taxonRows.map((row, idx) => {
      const rangeScore = rangeScoreByIdx.get(idx) ?? 0.5;
      const iucnModifier = getIucnModifier(row.iucn_status);
      const populationScore = populationScoreByIdx.get(idx) ?? null;
      const abundanceScore =
        populationScore != null
          ? ABUNDANCE_IUCN_WEIGHT * iucnModifier + (1 - ABUNDANCE_IUCN_WEIGHT) * populationScore
          : iucnModifier;
      const rawElusivenessScore = resolveRawElusivenessScore(elusivenessByGbifKey, row.gbif_key);
      // The nocturnal boost is gated on a real crawl-based measurement existing, rather than
      // applying unconditionally on top of NO_CRAWL_DATA_ELUSIVENESS_DEFAULT's own inferred
      // 0.75. Applying it unconditionally let an undocumented mammal known only to be
      // nocturnal (a near-universal, weak trait — true for a huge fraction of mammals) reach
      // 0.75 + 0.25*0.4 = 0.85, HIGHER than Wolverine's real, density-measured 0.7948.
      // Stacking a boost on top of an already-inferred placeholder compounds two guesses into
      // an unjustified extreme, and leaves no room for a genuinely-measured species to stand
      // out. Density is NOT gated the same way — COMBINE's density_per_km2 is a specific,
      // real, comparatively rare per-species measurement (not a near-universal trait like
      // nocturnality), so a real density boost is legitimate evidence even for a species the
      // crawl never found.
      const hasRealElusivenessMeasurement = elusivenessByGbifKey.has(Number(row.gbif_key));
      const nocturnalBoosted = hasRealElusivenessMeasurement
        ? boostElusivenessForNocturnal(rawElusivenessScore, row.nocturnal)
        : rawElusivenessScore;
      const isMammal = row.taxon_class === "mammalia";
      const isFish = row.taxon_class === "actinopterygii";
      const densityBoostWeight = isMammal ? MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT : undefined;
      const densityBoosted = boostElusivenessForDensity(nocturnalBoosted, densityScoreByIdx.get(idx) ?? null, densityBoostWeight);
      // Real COMBINE home-range data (mammals only, sparse coverage), applied regardless of
      // crawl status — a specific per-species measurement, not a near-universal weak trait.
      const homeRangeBoosted = boostElusivenessForHomeRange(densityBoosted, homeRangeScoreByIdx.get(idx) ?? null);
      // Real AVONET habitat-cover data (birds only), applied regardless of crawl status — a
      // specific per-species measurement, not a near-universal weak trait like nocturnality.
      const elusivenessScore = boostElusivenessForHabitatDensity(homeRangeBoosted, row.habitat_density);
      // Mammals and fish both skip the range axis entirely (see MAMMAL_WEIGHTS/FISH_WEIGHTS'
      // own comment — it's a constant 0.5 filler for every species in either taxon, zero real
      // information, wasting weight that abundance/elusiveness could otherwise use) rather
      // than including it and silently capping every species' composite below what a real,
      // extreme measurement should be able to reach.
      const composite = isMammal
        ? MAMMAL_WEIGHTS.abundance * abundanceScore + MAMMAL_WEIGHTS.elusiveness * elusivenessScore
        : isFish
          ? FISH_WEIGHTS.abundance * abundanceScore + FISH_WEIGHTS.elusiveness * elusivenessScore
          : WEIGHTS.range * rangeScore + WEIGHTS.abundance * abundanceScore + WEIGHTS.elusiveness * elusivenessScore;
      // A species with at least one real per-species signal that actually MOVES its score
      // away from the complete-unknown baseline is fundamentally different from one we know
      // nothing about — even after bumping the "never cleared the crawl" default toward
      // "probably hard to find" (see NO_CRAWL_DATA_ELUSIVENESS_DEFAULT's own comment),
      // lumping thousands of totally undocumented species into the SAME ranking pool as
      // well-documented ones would let that huge population crowd right up against
      // genuinely-verified species instead of just being individually
      // plausible-but-unconfirmed. Ranked separately below so neither pool can distort the
      // other. Deliberately narrower than "any field is
      // non-null": an IUCN status of exactly "least concern" scores identically to no status
      // at all (getIucnModifier gives both 0), and nocturnal=false changes nothing either —
      // counting those as "signal" would just reintroduce a smaller version of the same
      // tie-block one level down, inside the documented pool.
      const hasRealSignal =
        (row.iucn_status != null && iucnModifier > 0) ||
        elusivenessByGbifKey.has(Number(row.gbif_key)) ||
        row.density_per_km2 != null ||
        row.home_range_km2 != null ||
        row.population_estimate != null ||
        row.range_size_km2 != null ||
        row.nocturnal === true;
      return { id: row.id, rangeScore, abundanceScore, elusivenessScore, composite, hasRealSignal };
    });

    // Birds: absolute composite thresholds (see BIRD_ABSOLUTE_TIER_THRESHOLDS's own comment
    // — a species earns its tier on its own score, not a fixed-quota rank). No documented/
    // undocumented pool split needed here either — that split existed specifically to stop
    // the huge "no real data" mammal population from crowding a PERCENTILE ranking; an
    // absolute threshold has no such crowding problem since every species is judged against
    // a fixed bar, not against how many peers also cleared it.
    if (taxonRows[0]?.taxon_class === "aves") {
      for (const row of withElusiveness) {
        tiered.push({ ...row, tier: tierForScore(row.composite, BIRD_ABSOLUTE_TIER_THRESHOLDS) });
      }
      continue;
    }

    // Species with no real signal at all never get a fabricated rank. Without this
    // exclusion, the 36% of mammals and 41% of fish that tie at the exact same "no data"
    // composite would get fanned across every tier, including "legendary," by arbitrary DB
    // row order — instead they're 'unrated' regardless of which taxon this is or which
    // tiering system it uses below.
    const documented = withElusiveness.filter((r) => r.hasRealSignal);
    const undocumented = withElusiveness.filter((r) => !r.hasRealSignal);
    for (const row of undocumented) {
      tiered.push({ ...row, tier: "unrated" });
    }

    // Mammals and fish: same absolute-threshold treatment as birds now (see
    // MAMMAL_ABSOLUTE_TIER_THRESHOLDS/FISH_ABSOLUTE_TIER_THRESHOLDS' own comments) — a
    // species earns its tier on its own calibrated score, not a fixed-quota rank forced onto
    // whatever the real distribution happens to look like.
    const taxonClass = taxonRows[0]?.taxon_class;
    if (taxonClass === "mammalia" || taxonClass === "actinopterygii") {
      const thresholds = taxonClass === "mammalia" ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS : FISH_ABSOLUTE_TIER_THRESHOLDS;
      for (const row of documented) {
        tiered.push({ ...row, tier: tierForScore(row.composite, thresholds) });
      }
      continue;
    }

    // Any other taxon (none currently seeded, kept as a safe fallback) — the original
    // percentile-quota system, documented pool only.
    const sorted = [...documented].sort((a, b) => b.composite - a.composite);
    const n = sorted.length;
    for (const [idx, row] of sorted.entries()) {
      const percentile = (idx + 1) / n;
      const tier: RarityTier = TIER_THRESHOLDS.find((t) => percentile <= t.cumulativeShare)!.tier;
      tiered.push({ ...row, tier });
    }
  }

  const iso3ById = new Map(rows.map((r) => [r.id, endemicCountryIso3ByGbifKey.get(Number(r.gbif_key)) ?? null]));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of tiered) {
      await client.query(
        `UPDATE species_rarity SET range_score = $1, abundance_score = $2, elusiveness_score = $3,
                                    composite = $4, tier = $5, computed_at = now()
         WHERE species_id = $6`,
        [row.rangeScore, row.abundanceScore, row.elusivenessScore, row.composite, row.tier, row.id],
      );
      await client.query(`UPDATE species_traits SET endemic_country_iso3 = $1 WHERE species_id = $2`, [
        iso3ById.get(row.id) ?? null,
        row.id,
      ]);
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  console.log(`[rarity-phase4] re-tiered ${tiered.length} species with elusiveness folded in.`);
}
