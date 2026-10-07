// The worldwide rarity tier (species_rarity.tier): how hard a species is to find and photograph
// where it's easiest. That's its best local tier across the countries where it's native (vagrant
// and introduced rows don't count), one step harder when its whole range is tiny, since a species
// that only lives on one small island is a trip in itself however easy it is once there.
//
// Built from the local tiers (compute-local-tiers.ts), so the two can't disagree, and with no
// ranking against other species, which would make species in under-reported regions read rare.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/compute-global-tiers.ts [--apply]
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { TIER_ORDER, type TierExplain, type TierValue } from "@lifer/shared";
import { tierGroupForTaxonClass } from "../build/local-tier-model.js";

/** A whole range smaller than this (km²) makes a species a trip in itself. */
export const SMALL_RANGE_KM2 = 20_000;

export interface GlobalTier {
  speciesId: string;
  tier: TierValue | null;
  reason: string;
  explain: TierExplain | null;
}

export async function computeGlobalTiers(): Promise<GlobalTier[]> {
  const res = await pool.query<{
    species_id: string;
    taxon_class: string | null;
    domestic: boolean | null;
    range_size_km2: string | null;
    best_tier: string | null;
    best_country: string | null;
    best_explain: TierExplain | null;
  }>(
    `WITH countries AS (
       SELECT c.id, c.name FROM regions c JOIN regions cont ON cont.id = c.parent_id JOIN regions w ON w.id = cont.parent_id AND w.parent_id IS NULL
     ),
     native AS (
       SELECT DISTINCT ON (rs.species_id) rs.species_id, rs.local_tier, c.name, rs.tier_explain
       FROM region_species rs JOIN countries c ON c.id = rs.region_id
       WHERE rs.local_tier IS NOT NULL AND NOT rs.is_vagrant AND COALESCE(rs.tier_reason, 'rated') IN ('rated', 'inherited')
       ORDER BY rs.species_id,
                array_position(ARRAY['common','occasional','uncommon','rare','legendary'], rs.local_tier),
                rs.live_recent_records DESC NULLS LAST
     )
     SELECT s.id AS species_id, s.taxon_class, t.domestic, t.range_size_km2,
            n.local_tier AS best_tier, n.name AS best_country, n.tier_explain AS best_explain
     FROM species s
     LEFT JOIN species_traits t ON t.species_id = s.id
     LEFT JOIN native n ON n.species_id = s.id
     WHERE NOT s.is_other_taxa`,
  );
  return res.rows.map((r) => {
    const group = tierGroupForTaxonClass(r.taxon_class);
    if (!group) return { speciesId: r.species_id, tier: null, reason: "untiered_group", explain: null };
    if (r.domestic) return { speciesId: r.species_id, tier: null, reason: "domestic", explain: null };
    if (!r.best_tier) return { speciesId: r.species_id, tier: null, reason: "no_data", explain: null };
    const base = r.best_tier as TierValue;
    const range = r.range_size_km2 != null ? Number(r.range_size_km2) : null;
    const smallRange = range != null && range > 0 && range < SMALL_RANGE_KM2;
    const tier = TIER_ORDER[Math.min(TIER_ORDER.length - 1, TIER_ORDER.indexOf(base) + (smallRange ? 1 : 0))];
    const explain: TierExplain = {
      v: 1,
      group,
      rate: r.best_explain?.rate ?? null,
      records: r.best_explain?.records ?? null,
      effort: r.best_explain?.effort ?? null,
      source: r.best_explain?.source ?? null,
      base,
      steps: smallRange ? [{ kind: "small_range", rangeKm2: range! }] : [],
      guard: false,
      season: null,
      easiestIn: r.best_country,
    };
    return { speciesId: r.species_id, tier, reason: "rated", explain };
  });
}

async function writeGlobalTiers(tiers: GlobalTier[]) {
  const BATCH = 5000;
  for (let i = 0; i < tiers.length; i += BATCH) {
    const b = tiers.slice(i, i + BATCH);
    // species_rarity.tier has no NULL: an unrated species is 'unrated', with the reason alongside.
    await pool.query(
      // The old percentile scores (range_score, abundance_score, composite) are required columns;
      // a species new to the catalog starts them at 0, and they no longer decide anything.
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier, tier_reason, tier_explain, computed_at)
       SELECT id, 0, 0, 0, COALESCE(tier, 'unrated'), reason, explain::jsonb, now()
       FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[]) AS v(id, tier, reason, explain)
       ON CONFLICT (species_id) DO UPDATE SET tier = EXCLUDED.tier, tier_reason = EXCLUDED.tier_reason,
         tier_explain = EXCLUDED.tier_explain, computed_at = EXCLUDED.computed_at`,
      [
        b.map((t) => t.speciesId),
        b.map((t) => t.tier),
        b.map((t) => t.reason),
        b.map((t) => (t.explain ? JSON.stringify(t.explain) : null)),
      ],
    );
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const tiers = await computeGlobalTiers();
  const spread = new Map<string, number>();
  for (const t of tiers) spread.set(t.tier ?? `(${t.reason})`, (spread.get(t.tier ?? `(${t.reason})`) ?? 0) + 1);
  console.log(
    `[global-tiers] ${tiers.length} species: ${[...spread]
      .sort()
      .map(([k, n]) => `${k} ${n}`)
      .join(", ")}`,
  );
  if (apply) {
    await writeGlobalTiers(tiers);
    console.log("[global-tiers] applied");
  } else console.log("[global-tiers] preview only (pass --apply)");
  await pool.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
