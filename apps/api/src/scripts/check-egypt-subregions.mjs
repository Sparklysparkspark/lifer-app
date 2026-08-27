import { pool } from "../db.js";
const egypt = await pool.query(`SELECT id, name, has_children FROM regions WHERE name = 'Egypt'`);
console.log("Egypt:", egypt.rows[0]);

const children = await pool.query(
  `SELECT id, name, external_codes, occurrence_computed_at FROM regions WHERE parent_id = $1 ORDER BY name`,
  [egypt.rows[0].id],
);
console.log(`${children.rows.length} sub-regions:`);
console.table(children.rows.map((r) => ({
  name: r.name,
  hasExternalCodes: (r.external_codes?.length ?? 0) > 0,
  externalCodes: r.external_codes,
  occurrence_computed_at: r.occurrence_computed_at,
})));
await pool.end();
