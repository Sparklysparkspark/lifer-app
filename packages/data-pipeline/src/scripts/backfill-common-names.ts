// Re-fetches every enriched species' common name and alias list using fetch-gbif-vernacular.ts's
// selection logic (consensus, `preferred` flag, length tiebreak, plus every other English name
// including those on synonym keys). Updates common_name and fills common_name_aliases.
import { pool } from "../db.js";
import { fetchCommonNameWithAliases } from "../fetch/fetch-gbif-vernacular.js";

async function main() {
  const res = await pool.query<{
    id: string;
    gbif_key: string;
    scientific_name: string;
    common_name: string | null;
    common_name_aliases: string[] | null;
  }>(`SELECT id, gbif_key, scientific_name, common_name, common_name_aliases FROM species WHERE enriched_at IS NOT NULL ORDER BY scientific_name`);
  console.log(`[backfill-common-names] ${res.rows.length} enriched species to check`);

  let changed = 0;
  let checked = 0;
  for (const row of res.rows) {
    checked++;
    let fresh: { primary: string; aliases: string[] } | null;
    try {
      fresh = await fetchCommonNameWithAliases(Number(row.gbif_key));
    } catch (err) {
      console.error(`[backfill-common-names] FAILED ${row.scientific_name}:`, err);
      continue;
    }
    if (!fresh) continue;
    const aliasesChanged = JSON.stringify([...fresh.aliases].sort()) !== JSON.stringify([...(row.common_name_aliases ?? [])].sort());
    const nameChanged = fresh.primary !== row.common_name;
    if (nameChanged || aliasesChanged) {
      await pool.query(`UPDATE species SET common_name = $1, common_name_aliases = $2 WHERE id = $3`, [
        fresh.primary,
        fresh.aliases.length > 0 ? fresh.aliases : null,
        row.id,
      ]);
      if (nameChanged) console.log(`[backfill-common-names] ${row.scientific_name}: "${row.common_name ?? "(none)"}" -> "${fresh.primary}"`);
      if (aliasesChanged) console.log(`[backfill-common-names]   aliases: [${fresh.aliases.join(", ")}]`);
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
