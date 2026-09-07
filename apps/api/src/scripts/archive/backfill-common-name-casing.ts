// One-off backfill for fish common names that are all lowercase (e.g. "panda" for Corydoras
// panda). Fish common names mostly come from Catalogue of Life via GBIF's vernacularNames API
// (no Clements/IOC-style curated, pre-cased source the way birds have), and CoL stores plenty
// of its own English vernacular names in plain lowercase. fetch-gbif-vernacular.ts now
// title-cases on fetch (fixes future builds); this fixes what's already loaded without
// re-fetching, since the raw text is already sitting in the DB.
import { pool } from "../db.js";

function toTitleCase(name: string): string {
  return name.replace(/(^|[\s-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

async function main() {
  const res = await pool.query<{ id: string; common_name: string }>(
    `SELECT id, common_name FROM species WHERE common_name = lower(common_name) AND common_name ~ '[a-z]'`,
  );
  console.log(`[backfill-casing] ${res.rows.length} species with an all-lowercase common name`);

  let updated = 0;
  for (const row of res.rows) {
    const fixed = toTitleCase(row.common_name);
    if (fixed !== row.common_name) {
      await pool.query(`UPDATE species SET common_name = $1 WHERE id = $2`, [fixed, row.id]);
      updated++;
    }
  }
  console.log(`[backfill-casing] done. ${updated} species updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
