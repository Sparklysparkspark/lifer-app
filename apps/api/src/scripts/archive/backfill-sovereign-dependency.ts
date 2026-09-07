// Re-derives regions.is_sovereign_dependency (migration 066) for every country-level region from
// the shared isSovereignDependencyFromType helper (fetch-region-boundary.ts) — unlike the
// original one-off version of this script, this corrects values in BOTH directions, not just
// false->true. Needed because the original naive `SOVEREIGNT !== NAME` comparison wrongly
// flagged 19 real sovereign countries (Dominican Republic, Tanzania, Serbia, Bahamas, Congo,
// Central African Rep., Côte d'Ivoire, Timor-Leste, Bosnia and Herz., Eq. Guinea, N. Cyprus,
// Marshall Is., St. Vin. and Gren., Antigua and Barb., St. Kitts and Nevis, Solomon Is.,
// Micronesia, S. Sudan) as territories, since Natural Earth's NAME field is abbreviated for many
// countries while SOVEREIGNT is always the full name — same country, different strings.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { isSovereignDependencyFromType } from "data-pipeline/src/fetch/fetch-region-boundary.js";

interface Admin0Feature {
  properties: { ADM0_A3: string; TYPE?: string; SOVEREIGNT?: string; NAME?: string };
}

async function main() {
  const dataPath = path.join(process.cwd(), "data/raw/natural-earth/ne_10m_admin_0_countries.geojson");
  const data = JSON.parse(readFileSync(dataPath, "utf-8")) as { features: Admin0Feature[] };
  const isDependencyByIso3 = new Map<string, boolean>();
  for (const f of data.features) {
    if (f.properties.ADM0_A3) isDependencyByIso3.set(f.properties.ADM0_A3, isSovereignDependencyFromType(f.properties));
  }

  const res = await pool.query<{ id: string; name: string; iso3: string; is_sovereign_dependency: boolean }>(
    `SELECT id, name, external_codes[1] AS iso3, is_sovereign_dependency FROM regions
     WHERE parent_id IS NOT NULL AND array_length(external_codes, 1) = 1`,
  );
  console.log(`[backfill-sovereign-dependency] ${res.rows.length} region(s) to check`);

  let fixed = 0;
  for (const row of res.rows) {
    const correct = isDependencyByIso3.get(row.iso3);
    if (correct === undefined || correct === row.is_sovereign_dependency) continue;
    await pool.query(`UPDATE regions SET is_sovereign_dependency = $1 WHERE id = $2`, [correct, row.id]);
    console.log(`[backfill-sovereign-dependency]   ${row.name}: ${row.is_sovereign_dependency} -> ${correct}`);
    fixed++;
  }

  console.log(`[backfill-sovereign-dependency] done. ${fixed} corrected.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
