// Inserts a "Central America" organizational region between North America and its Central
// American countries, mirroring how North America/Europe/etc. themselves are purely
// organizational rows (no geometry, no GBIF codes — see this file's own query output: those
// continent rows have boundary_geojson NULL, external_codes empty, has_children false). Users
// think of Central America as its own destination distinct from "North America" broadly (the
// continent groups Canada/US/Mexico/the Caribbean/Central America together with no further
// differentiation otherwise) — this just gives it a real node in the browse tree. Idempotent:
// skips straight to reparenting if the region already exists from a previous run.
import { pool } from "../db.js";

const CENTRAL_AMERICAN_COUNTRIES = ["Belize", "Costa Rica", "El Salvador", "Guatemala", "Honduras", "Nicaragua", "Panama"];

async function main() {
  const naRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = 'North America' AND parent_id IS NOT NULL`);
  const northAmericaId = naRes.rows[0]?.id;
  if (!northAmericaId) {
    console.error("[add-central-america-region] No North America row found");
    process.exit(1);
  }

  let centralAmericaId: string;
  const existing = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = 'Central America' AND parent_id = $1`, [
    northAmericaId,
  ]);
  if (existing.rows[0]) {
    centralAmericaId = existing.rows[0].id;
    console.log(`[add-central-america-region] Central America already exists (${centralAmericaId}), reusing`);
  } else {
    const inserted = await pool.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, external_codes, has_children) VALUES ('Central America', $1, '{}', false) RETURNING id`,
      [northAmericaId],
    );
    centralAmericaId = inserted.rows[0].id;
    console.log(`[add-central-america-region] Created Central America (${centralAmericaId})`);
  }

  const res = await pool.query(
    `UPDATE regions SET parent_id = $1 WHERE name = ANY($2) AND parent_id = $3`,
    [centralAmericaId, CENTRAL_AMERICAN_COUNTRIES, northAmericaId],
  );
  console.log(`[add-central-america-region] Reparented ${res.rowCount} countr(y/ies) under Central America`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
