import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";

const r = await pool.query(
  `SELECT id, boundary_geojson, external_codes FROM regions WHERE id = '381695c2-865b-4842-8771-9d46d8a567e9'`,
);
const region = r.rows[0];
console.log("Recomputing Canada with current thresholds/floor logic...");
await computeRegionOccurrences(region);
console.log("Done.");
await pool.end();
