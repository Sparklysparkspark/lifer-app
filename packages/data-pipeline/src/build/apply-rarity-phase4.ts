// Folds the elusiveness axis (compute-elusiveness.ts) into the composite rarity score and
// re-tiers every species. Always a full recompute over the species table, never a partial patch.
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
  boostElusivenessForCamouflage,
  CAMOUFLAGED_FISH_FAMILIES,
  MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT,
  type RarityTier,
} from "./compute-rarity-phase1.js";

// Tier tracks photographic encounter difficulty, so elusiveness is the majority weight and range
// and abundance moderate it. With a lower elusiveness weight, widespread species could never
// leave "common" however hard they are to detect.
const WEIGHTS = { range: 0.2, abundance: 0.2, elusiveness: 0.6 };

// Mammals and fish have no range source, so the range axis is dropped for them. Hand-calibrated,
// not derived from the bird weights: GBIF record volume for these taxa reflects research and
// survey effort more than encounter difficulty, so abundance (IUCN-driven) carries more weight.
const MAMMAL_WEIGHTS = { abundance: 0.2, elusiveness: 0.8 };
// Fish have better IUCN coverage than mammals and almost no density or nocturnal data, so
// abundance matters even more.
const FISH_WEIGHTS = { abundance: 0.6, elusiveness: 0.4 };
// For camouflaged fish families, IUCN status carries no difficulty signal and FISH_WEIGHTS would
// cap the composite below the epic cutoff, so the camouflage-boosted elusiveness leads instead.
const CAMOUFLAGED_FISH_WEIGHTS = { abundance: 0.2, elusiveness: 0.8 };
// Reptiles and amphibians: elusiveness plus IUCN abundance, no range axis. Tiered against the fish
// thresholds, the same ones their local tiers use (compute-provinces-bulk.ts).
const HERP_WEIGHTS = { abundance: 0.4, elusiveness: 0.6 };
const HERP_TAXON_CLASSES = new Set(["squamata", "testudines", "amphibia"]);

// Abundance blends the coarse IUCN modifier (most species are Least Concern) with a population
// size percentile (Callaghan et al. 2021), weighted toward IUCN.
const ABUNDANCE_IUCN_WEIGHT = 0.6;

// A species absent from every well-sampled country's facets is itself evidence it's hard to
// detect, so it defaults above mid-pack. Kept below 1.0 since it's an inference, not a measurement.
const NO_CRAWL_DATA_ELUSIVENESS_DEFAULT = 0.75;

// species.gbif_key is bigint, which node-postgres returns as a string, so Number() is required
// or every lookup misses and falls back to the default.
export function resolveRawElusivenessScore(elusivenessByGbifKey: Map<number, number>, gbifKey: number | string): number {
  return elusivenessByGbifKey.get(Number(gbifKey)) ?? NO_CRAWL_DATA_ELUSIVENESS_DEFAULT;
}

// INVARIANT: elusivenessByGbifKey must be the raw, pre-boost score from computeElusiveness.
// This function applies the boosts and writes the boosted value, so feeding stored
// elusiveness_score back in double-applies them. To reapply, call computeElusiveness() again.
export async function applyElusiveness(
  elusivenessByGbifKey: Map<number, number>,
  endemicCountryIso3ByGbifKey: Map<number, string> = new Map(),
): Promise<void> {
  // Range score is recomputed from species_traits rather than trusted from species_rarity, so a
  // rerun fixes already-loaded rows. Extinct species are excluded: they can't be photographed and
  // would skew the tier boundaries.
  const res = await pool.query(
    `SELECT s.id, s.gbif_key, s.taxon_class, s.family, t.range_size_km2, t.iucn_status, t.nocturnal, t.population_estimate, t.density_per_km2, t.home_range_km2, t.habitat_density, t.domestic
     FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE t.fully_extinct = false`,
  );
  const rows = res.rows as Array<{
    id: string;
    gbif_key: number;
    taxon_class: string;
    family: string | null;
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

  // Domestic species are forced to "common": their record volume measures farm-animal photos,
  // and ranking them would skew wild species' percentiles.
  const domesticRows = rows.filter((r) => r.domestic);
  const wildRows = rows.filter((r) => !r.domestic);
  for (const row of domesticRows) {
    tiered.push({ id: row.id, rangeScore: 0, abundanceScore: 0, elusivenessScore: 0, composite: 0, tier: "common" });
  }

  // Ranked per taxon_class, so one taxon's missing data (large tie blocks at the default
  // composite) can't distort another taxon's tiers.
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

    // Population size feeds an abundance percentile and, divided by range, a density signal that
    // boosts elusiveness, separating sparse wide-ranging species from abundant ones.
    const validPopulationIndexes = taxonRows
      .map((row, idx) => ({ idx, value: row.population_estimate != null ? Number(row.population_estimate) : null }))
      .filter((e): e is { idx: number; value: number } => e.value != null && e.value > 0);
    const populationScoreByIdx = percentileRankScores(validPopulationIndexes);

    const validDensityIndexes = taxonRows
      .map((row, idx) => {
        // Prefer COMBINE's measured density_per_km2 (mammals); fall back to population/range, which
        // only exists for birds.
        const combineDensity = row.density_per_km2 != null ? Number(row.density_per_km2) : null;
        const population = row.population_estimate != null ? Number(row.population_estimate) : null;
        const range = row.range_size_km2 != null ? Number(row.range_size_km2) : null;
        const derivedDensity = population != null && range != null && range > 0 ? population / range : null;
        const density = combineDensity ?? derivedDensity;
        return { idx, value: density };
      })
      .filter((e): e is { idx: number; value: number } => e.value != null);
    // percentileRankScores gives 1.0 to the smallest value, i.e. lowest density gets the biggest boost.
    const densityScoreByIdx = percentileRankScores(validDensityIndexes);

    // Home range (COMBINE, mammals) is distinct from density: how much ground one individual covers,
    // which drives how likely one is to pass a fixed observer. Largest home range should get the
    // biggest boost, so values are negated before ranking.
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
      // The nocturnal boost only applies on top of a real crawl measurement, never the inferred
      // default, so two guesses don't stack into an extreme. Density isn't gated: it's a real
      // per-species measurement.
      const hasRealElusivenessMeasurement = elusivenessByGbifKey.has(Number(row.gbif_key));
      const nocturnalBoosted = hasRealElusivenessMeasurement
        ? boostElusivenessForNocturnal(rawElusivenessScore, row.nocturnal)
        : rawElusivenessScore;
      // Camouflage is a coarse family flag, gated the same way as nocturnal.
      const camouflageBoosted = hasRealElusivenessMeasurement
        ? boostElusivenessForCamouflage(nocturnalBoosted, row.family)
        : nocturnalBoosted;
      const isMammal = row.taxon_class === "mammalia";
      const isFish = row.taxon_class === "actinopterygii";
      const densityBoostWeight = isMammal ? MAMMAL_DENSITY_ELUSIVENESS_BOOST_WEIGHT : undefined;
      const densityBoosted = boostElusivenessForDensity(camouflageBoosted, densityScoreByIdx.get(idx) ?? null, densityBoostWeight);
      // Home range and habitat density are real per-species measurements, applied regardless of crawl status.
      const homeRangeBoosted = boostElusivenessForHomeRange(densityBoosted, homeRangeScoreByIdx.get(idx) ?? null);
      const elusivenessScore = boostElusivenessForHabitatDensity(homeRangeBoosted, row.habitat_density);
      // Mammals, fish and herps skip the constant-filler range axis (see MAMMAL_WEIGHTS).
      const isCamouflagedFish = isFish && !!row.family && CAMOUFLAGED_FISH_FAMILIES.has(row.family);
      const fishWeights = isCamouflagedFish ? CAMOUFLAGED_FISH_WEIGHTS : FISH_WEIGHTS;
      const isHerp = HERP_TAXON_CLASSES.has(row.taxon_class);
      const composite = isMammal
        ? MAMMAL_WEIGHTS.abundance * abundanceScore + MAMMAL_WEIGHTS.elusiveness * elusivenessScore
        : isFish
          ? fishWeights.abundance * abundanceScore + fishWeights.elusiveness * elusivenessScore
          : isHerp
            ? HERP_WEIGHTS.abundance * abundanceScore + HERP_WEIGHTS.elusiveness * elusivenessScore
            : WEIGHTS.range * rangeScore + WEIGHTS.abundance * abundanceScore + WEIGHTS.elusiveness * elusivenessScore;
      // Species with no real signal are ranked apart (as "unrated" below) so a huge undocumented pool
      // can't crowd well-documented species. "Least concern" and nocturnal=false don't count as
      // signal, since they don't move the score.
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

    // Birds use absolute composite thresholds: a species earns its tier on its own score, not a rank.
    if (taxonRows[0]?.taxon_class === "aves") {
      for (const row of withElusiveness) {
        tiered.push({ ...row, tier: tierForScore(row.composite, BIRD_ABSOLUTE_TIER_THRESHOLDS) });
      }
      continue;
    }

    // Species with no real signal are 'unrated' rather than fanned across tiers by row order.
    const documented = withElusiveness.filter((r) => r.hasRealSignal);
    const undocumented = withElusiveness.filter((r) => !r.hasRealSignal);
    for (const row of undocumented) {
      tiered.push({ ...row, tier: "unrated" });
    }

    // Mammals, fish and herps also use absolute thresholds.
    const taxonClass = taxonRows[0]?.taxon_class;
    if (taxonClass === "mammalia" || taxonClass === "actinopterygii" || HERP_TAXON_CLASSES.has(taxonClass ?? "")) {
      const thresholds = taxonClass === "mammalia" ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS : FISH_ABSOLUTE_TIER_THRESHOLDS;
      for (const row of documented) {
        tiered.push({ ...row, tier: tierForScore(row.composite, thresholds) });
      }
      continue;
    }

    // Fallback for any other taxon (none seeded today): the percentile-quota system.
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
      // Introduced countries aren't written here: the distance heuristic misfires on native ranges.
      // species_nonnative_countries comes from iNaturalist (apps/api/src/scripts/apply-introduced-flags.ts).
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
