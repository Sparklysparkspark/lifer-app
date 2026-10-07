// Computes the fish and marine mammal checklist of every sea zone that has none yet
// (occurrence_computed_at NULL): the step after data-pipeline's replace-sea-zones.ts, which
// leaves the new zones empty. Nothing else in the refresh computes sea zones. Each zone commits on
// its own, so rerunning after an interruption continues with the zones still missing.
//
// Usage: npx tsx src/scripts/compute-sea-zones.ts [--apply] [--zones="North Sea,Red Sea"] [--recompute]
//   without --apply   lists the zones it would compute
//   --zones=          only these zones
//   --recompute       compute these zones again even if they have a checklist
import { pool } from "@lifer/core/db.js";
import { ensureSeaZoneComputed } from "@lifer/core/regions/compute/seaZones.js";

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const recompute = args.includes("--recompute");
  const zonesArg = args.find((a) => a.startsWith("--zones="))?.slice("--zones=".length);
  const names = zonesArg
    ? zonesArg
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : null;

  const res = await pool.query<{ id: string; name: string; wkt: string }>(
    `SELECT id, name, wkt FROM sea_zones
     WHERE ($1::boolean OR occurrence_computed_at IS NULL) AND ($2::text[] IS NULL OR name = ANY($2))
     ORDER BY name`,
    [recompute, names],
  );
  if (names) {
    const missing = names.filter((n) => !res.rows.some((r) => r.name === n));
    if (missing.length > 0) console.warn(`[compute-sea-zones] not found or already computed: ${missing.join(", ")}`);
  }
  console.log(`[compute-sea-zones] ${res.rows.length} zone(s) to compute`);
  if (!apply) {
    for (const z of res.rows) console.log(`  ${z.name}`);
    console.log("[compute-sea-zones] dry run; rerun with --apply");
    await pool.end();
    return;
  }

  // Sequential: GBIF's rate limit is tight enough that parallel workers mostly fail with 429s.
  let done = 0;
  let failed = 0;
  for (const zone of res.rows) {
    const started = Date.now();
    try {
      await ensureSeaZoneComputed(zone.id, zone.wkt, false);
      done++;
      const count = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM sea_zone_species WHERE sea_zone_id = $1`,
        [zone.id],
      );
      console.log(
        `[compute-sea-zones] ${done + failed}/${res.rows.length} ${zone.name}: ${count.rows[0].n} species in ${Math.round((Date.now() - started) / 1000)}s`,
      );
    } catch (err) {
      failed++;
      console.error(`[compute-sea-zones] FAILED ${zone.name}:`, err);
    }
  }
  console.log(`[compute-sea-zones] done. ${done} computed, ${failed} failed.`);
  await pool.end();
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
