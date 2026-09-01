// One-off backfill for regions.sovereignty_group (migration 065) — every country seeded before
// this column existed has no value yet. Re-reads the same cached Natural Earth admin-0 file
// build-regions.ts itself reads and matches each existing country region back to its source
// feature by external_codes[0] (ADM0_A3), the same key that's already unique per country.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";

interface Admin0Feature {
  properties: { ADM0_A3: string; SOV_A3?: string };
}

async function main() {
  const dataPath = path.join(process.cwd(), "data/raw/natural-earth/ne_10m_admin_0_countries.geojson");
  const data = JSON.parse(readFileSync(dataPath, "utf-8")) as { features: Admin0Feature[] };
  const sovByIso3 = new Map<string, string>();
  for (const f of data.features) {
    if (f.properties.ADM0_A3 && f.properties.SOV_A3) sovByIso3.set(f.properties.ADM0_A3, f.properties.SOV_A3);
  }

  const res = await pool.query<{ id: string; iso3: string }>(
    `SELECT id, external_codes[1] AS iso3 FROM regions
     WHERE sovereignty_group IS NULL AND parent_id IS NOT NULL AND array_length(external_codes, 1) = 1`,
  );
  console.log(`[backfill-sovereignty-group] ${res.rows.length} region(s) with no sovereignty_group yet`);

  let fixed = 0;
  for (const row of res.rows) {
    const sov = sovByIso3.get(row.iso3);
    if (!sov) continue;
    await pool.query(`UPDATE regions SET sovereignty_group = $1 WHERE id = $2`, [sov, row.id]);
    fixed++;
  }

  console.log(`[backfill-sovereignty-group] done. ${fixed} fixed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
