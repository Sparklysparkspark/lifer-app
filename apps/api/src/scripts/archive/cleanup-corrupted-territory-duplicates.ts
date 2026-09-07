// Confirmed live: several overseas territories (France's Guyane française, Guadeloupe,
// Martinique, Mayotte; Grenada's Carriacou & Petite Martinique; many more worldwide) exist as a
// corrupted row parented directly under a continent, with a raw WKT polygon string sitting in
// external_codes instead of a real code — external_codes should only ever hold real ISO-style
// codes, so this signature alone (continent-parented + external_codes[0] starting with
// "POLYGON(") is corruption on its own, independent of whether a legitimate duplicate happens to
// already exist elsewhere (confirmed live on a real install: some installs have the real
// province-level row too — from an earlier country drill-down — others don't yet, since
// drill-down only ever happens lazily when a user actually opens that country's province list;
// either way this row is fake and safe to delete — the normal drill-down flow recreates the real
// one correctly the next time someone views that country). Neither fetchAllCountries() nor the
// normal province drill-down writes malformed external_codes like this, so the exact origin is
// unclear.
import { pool } from "../db.js";

async function main() {
  const res = await pool.query<{
    id: string;
    name: string;
    continent_name: string;
  }>(`
    SELECT r.id, r.name, continent.name AS continent_name
    FROM regions r
    JOIN regions continent ON continent.id = r.parent_id
    JOIN regions world ON world.id = continent.parent_id AND world.name = 'World'
    WHERE r.external_codes[1] LIKE 'POLYGON(%'
  `);

  console.log(`[cleanup-territory-dupes] found ${res.rows.length} corrupted row(s)`);
  for (const row of res.rows) {
    console.log(`  "${row.name}" under continent "${row.continent_name}" (id ${row.id})`);
  }

  if (res.rows.length === 0) {
    await pool.end();
    return;
  }

  const idsToDelete = res.rows.map((r) => r.id);
  const speciesCheck = await pool.query<{ region_id: string; count: string }>(
    `SELECT region_id, count(*) FROM region_species WHERE region_id = ANY($1) GROUP BY region_id`,
    [idsToDelete],
  );
  if (speciesCheck.rows.length > 0) {
    console.log(
      `[cleanup-territory-dupes] REFUSING to delete — ${speciesCheck.rows.length} of these rows have real ` +
        `region_species data attached (never expected for a fake row): ${JSON.stringify(speciesCheck.rows)}`,
    );
    await pool.end();
    return;
  }

  const deleteRes = await pool.query(`DELETE FROM regions WHERE id = ANY($1)`, [idsToDelete]);
  console.log(`[cleanup-territory-dupes] deleted ${deleteRes.rowCount} corrupted duplicate row(s)`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
