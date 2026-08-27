import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";

const egypt = await pool.query(
  `SELECT id, name, boundary_geojson, external_codes FROM regions WHERE name = 'Egypt'`,
);
const children = await pool.query(
  `SELECT id, name, boundary_geojson, external_codes FROM regions
   WHERE parent_id = $1 AND array_length(external_codes, 1) > 0
   ORDER BY name`,
  [egypt.rows[0].id],
);

const all = [egypt.rows[0], ...children.rows];
console.log(`[recompute-egypt-all] recomputing Egypt + ${children.rows.length} governorates with fixed marine-exclusion logic`);

let done = 0;
for (const region of all) {
  console.log(`[recompute-egypt-all] computing ${region.name}...`);
  try {
    await computeRegionOccurrences(region);
    done++;
    console.log(`[recompute-egypt-all] ${done}/${all.length} done (${region.name})`);
  } catch (err) {
    console.error(`[recompute-egypt-all] FAILED ${region.name}:`, err);
  }
}

console.log(`[recompute-egypt-all] all done. ${done}/${all.length} succeeded.`);
await pool.end();
