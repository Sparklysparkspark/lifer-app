import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";

const egypt = await pool.query(`SELECT id FROM regions WHERE name = 'Egypt'`);
const children = await pool.query(
  `SELECT id, name, boundary_geojson, external_codes FROM regions
   WHERE parent_id = $1 AND occurrence_computed_at IS NULL AND array_length(external_codes, 1) > 0
   ORDER BY name`,
  [egypt.rows[0].id],
);
console.log(`[compute-egypt-subregions] ${children.rows.length} governorates to compute`);

let done = 0;
for (const region of children.rows) {
  console.log(`[compute-egypt-subregions] computing ${region.name}...`);
  try {
    await computeRegionOccurrences(region);
    done++;
    console.log(`[compute-egypt-subregions] ${done}/${children.rows.length} done (${region.name})`);
  } catch (err) {
    console.error(`[compute-egypt-subregions] FAILED ${region.name}:`, err);
  }
}

console.log(`[compute-egypt-subregions] all done. ${done}/${children.rows.length} succeeded.`);
await pool.end();
