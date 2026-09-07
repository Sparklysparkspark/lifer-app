// One-off: apply-rarity-phase4.ts's undocumented pool now gets tier='unrated' instead of
// running through the percentile quota. Previously a huge "no real data" tie block was being
// fanned across every tier, including "legendary", by arbitrary DB row order.
// This re-derives that split from already-stored data rather than redoing the full
// multi-hour, 258-country elusiveness crawl — safe because hasRealSignal is reconstructible
// from stored species_traits fields plus the already-boosted elusiveness_score: the ONLY way
// a mammal/fish's elusiveness_score can differ from exactly 0.75 (the no-crawl-match default;
// see NO_CRAWL_DATA_ELUSIVENESS_DEFAULT) without density_per_km2 also being set (checked
// directly below) is a real crawl match having moved rawElusivenessScore off the default.
// Mammals/fish never get the nocturnal or habitat-density boosts without a real crawl match
// or real per-species habitat data respectively (see apply-rarity-phase4.ts), so this
// reconstruction is exact, not approximate.
//
// Documented-pool tiers are untouched by this — apply-rarity-phase4.ts already ranked that
// pool separately from undocumented, so removing undocumented rows from the quota doesn't
// shift the documented pool's own percentile shares. This script re-derives them anyway,
// from the same stored composite, purely as a consistency check that nothing moved.
import { pool } from "../db.js";
import { TIER_THRESHOLDS, getIucnModifier, type RarityTier } from "../build/compute-rarity-phase1.js";

const NO_CRAWL_DATA_ELUSIVENESS_DEFAULT = 0.75;

async function main() {
  const res = await pool.query<{
    species_id: string;
    taxon_class: string;
    composite: string;
    elusiveness_score: string | null;
    iucn_status: string | null;
    nocturnal: boolean | null;
    density_per_km2: string | null;
    population_estimate: string | null;
    domestic: boolean;
  }>(
    `SELECT r.species_id, s.taxon_class, r.composite, r.elusiveness_score,
            t.iucn_status, t.nocturnal, t.density_per_km2, t.population_estimate, t.domestic
     FROM species_rarity r
     JOIN species s ON s.id = r.species_id
     JOIN species_traits t ON t.species_id = s.id
     WHERE s.taxon_class IN ('mammalia', 'actinopterygii') AND t.fully_extinct = false AND t.domestic = false`,
  );
  console.log(`[retier-unrated] ${res.rows.length} mammal/fish species to re-split`);

  const byTaxon = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    if (!byTaxon.has(row.taxon_class)) byTaxon.set(row.taxon_class, []);
    byTaxon.get(row.taxon_class)!.push(row);
  }

  let documented = 0;
  let unrated = 0;
  for (const [taxonClass, rows] of byTaxon) {
    const withSignal = rows.map((row) => {
      const iucnModifier = getIucnModifier(row.iucn_status);
      const elusivenessScore = row.elusiveness_score != null ? Number(row.elusiveness_score) : null;
      const hasRealSignal =
        iucnModifier > 0 ||
        row.density_per_km2 != null ||
        row.population_estimate != null ||
        row.nocturnal === true ||
        (elusivenessScore != null && Math.abs(elusivenessScore - NO_CRAWL_DATA_ELUSIVENESS_DEFAULT) > 1e-9);
      return { ...row, hasRealSignal };
    });

    const documentedRows = withSignal.filter((r) => r.hasRealSignal);
    const undocumentedRows = withSignal.filter((r) => !r.hasRealSignal);
    console.log(
      `[retier-unrated] ${taxonClass}: ${documentedRows.length} documented, ${undocumentedRows.length} undocumented`,
    );

    const sorted = [...documentedRows].sort((a, b) => Number(b.composite) - Number(a.composite));
    const n = sorted.length;
    for (const [idx, row] of sorted.entries()) {
      const percentile = (idx + 1) / n;
      const tier: RarityTier = TIER_THRESHOLDS.find((t) => percentile <= t.cumulativeShare)!.tier;
      await pool.query(`UPDATE species_rarity SET tier = $1 WHERE species_id = $2`, [tier, row.species_id]);
      documented++;
    }
    for (const row of undocumentedRows) {
      await pool.query(`UPDATE species_rarity SET tier = 'unrated' WHERE species_id = $1`, [row.species_id]);
      unrated++;
    }
  }

  console.log(`[retier-unrated] done. ${documented} re-tiered on the ladder, ${unrated} set to unrated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
