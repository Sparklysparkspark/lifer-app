// One-time pass: recompute every region that already has a cached occurrence checklist
// (occurrence_computed_at set) from before a fix to recurrence-based rare-resident detection
// landed, so they pick up the newly-rescued sparse residents instead of waiting for someone to
// view that region again.
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";

async function main() {
  const res = await pool.query(
    `SELECT id, name, boundary_geojson, external_codes FROM regions WHERE occurrence_computed_at IS NOT NULL ORDER BY name`,
  );
  console.log(`[recompute-stale-regions] ${res.rows.length} regions to recompute`);

  let done = 0;
  for (const region of res.rows) {
    const before = await pool.query(`SELECT count(*) FROM region_species WHERE region_id = $1`, [region.id]);
    try {
      await computeRegionOccurrences(region);
    } catch (err) {
      console.error(`[recompute-stale-regions] FAILED ${region.name}:`, err);
      continue;
    }
    const after = await pool.query(`SELECT count(*) FROM region_species WHERE region_id = $1`, [region.id]);
    done++;
    console.log(
      `[recompute-stale-regions] ${done}/${res.rows.length} ${region.name}: ${before.rows[0].count} -> ${after.rows[0].count} species`,
    );
  }
  console.log(`[recompute-stale-regions] done.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
