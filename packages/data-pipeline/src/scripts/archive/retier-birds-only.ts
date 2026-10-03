// One-off: re-derives bird tiers from the stored composite after a threshold-only change to
// BIRD_ABSOLUTE_TIER_THRESHOLDS, avoiding the full elusiveness crawl. Only touches
// taxon_class='aves'.
import { pool } from "../db.js";
import { BIRD_ABSOLUTE_TIER_THRESHOLDS, tierForScore } from "../build/compute-rarity-phase1.js";

async function main() {
  const res = await pool.query<{ species_id: string; composite: string }>(
    `SELECT r.species_id, r.composite FROM species_rarity r
     JOIN species s ON s.id = r.species_id WHERE s.taxon_class = 'aves'`,
  );
  console.log(`[retier-birds] ${res.rows.length} birds to re-tier`);
  let updated = 0;
  for (const row of res.rows) {
    const tier = tierForScore(Number(row.composite), BIRD_ABSOLUTE_TIER_THRESHOLDS);
    await pool.query(`UPDATE species_rarity SET tier = $1 WHERE species_id = $2`, [tier, row.species_id]);
    updated++;
  }
  console.log(`[retier-birds] done. ${updated} updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
