// One-time pass: re-fetches every enriched species' common name using
// fetch-gbif-vernacular.ts's now-fixed selection logic (GBIF's own `preferred` flag, then a
// cross-source frequency/length tiebreak — see that file's own comments on why the old plain
// first-result fallback picked names like "Maylan" over "Spotted Eagle Ray"), and updates any
// that changed. Existing species were seeded before this fix landed, so their stored
// common_name reflects the old, worse selection until this runs once.
import { pool } from "../db.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";

async function main() {
  const res = await pool.query<{ id: string; gbif_key: string; scientific_name: string; common_name: string | null }>(
    `SELECT id, gbif_key, scientific_name, common_name FROM species WHERE enriched_at IS NOT NULL ORDER BY scientific_name`,
  );
  console.log(`[backfill-common-names] ${res.rows.length} enriched species to check`);

  let changed = 0;
  let checked = 0;
  for (const row of res.rows) {
    checked++;
    let fresh: string | null;
    try {
      fresh = await fetchCommonName(Number(row.gbif_key));
    } catch (err) {
      console.error(`[backfill-common-names] FAILED ${row.scientific_name}:`, err);
      continue;
    }
    if (fresh && fresh !== row.common_name) {
      await pool.query(`UPDATE species SET common_name = $1 WHERE id = $2`, [fresh, row.id]);
      console.log(`[backfill-common-names] ${row.scientific_name}: "${row.common_name ?? "(none)"}" -> "${fresh}"`);
      changed++;
    }
    if (checked % 500 === 0) console.log(`[backfill-common-names] ${checked}/${res.rows.length} checked, ${changed} changed so far`);
  }
  console.log(`[backfill-common-names] done. ${checked} checked, ${changed} changed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
