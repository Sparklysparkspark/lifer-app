// One-off backfill for regions.subdivision_type (migration 064) — every province/state region
// created before this column existed (drill-down only sets it going forward) has no value yet,
// which would make subdivisionLabelFor fall back to the generic "Provinces" for every already-
// drilled country. Re-reads the same cached Natural Earth admin-1 file the drill-down endpoint
// itself uses and matches each existing child region back to its source feature by country
// ISO3 (the parent's own external_codes[0]) + name — the same two keys drill-down inserts by.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";

interface Admin1Feature {
  properties: { adm0_a3: string; name: string; type?: string };
}

async function main() {
  const dataPath = path.join(process.cwd(), "data/raw/natural-earth/ne_10m_admin_1_states_provinces.geojson");
  const data = JSON.parse(readFileSync(dataPath, "utf-8")) as { features: Admin1Feature[] };

  const res = await pool.query<{ id: string; name: string; country_iso3: string | null }>(
    `SELECT r.id, r.name, p.external_codes[1] AS country_iso3
     FROM regions r
     JOIN regions p ON p.id = r.parent_id
     WHERE r.subdivision_type IS NULL AND p.external_codes IS NOT NULL AND array_length(p.external_codes, 1) = 1`,
  );
  console.log(`[backfill-subdivision-type] ${res.rows.length} region(s) with no subdivision_type yet`);

  let fixed = 0;
  for (const row of res.rows) {
    if (!row.country_iso3) continue;
    const feature = data.features.find((f) => f.properties.adm0_a3 === row.country_iso3 && f.properties.name === row.name);
    if (!feature?.properties.type) continue;
    await pool.query(`UPDATE regions SET subdivision_type = $1 WHERE id = $2`, [feature.properties.type, row.id]);
    fixed++;
  }

  console.log(`[backfill-subdivision-type] done. ${fixed} fixed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
