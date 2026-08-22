// One-off: re-queries Wikidata for every species with NO iucn_status on file, using the
// synonym-aware query fixed in fetch-wikidata.ts. That fix addressed a gap found with the
// Snow Leopard: GBIF's backbone name "Uncia uncia" matched a Wikidata item with no IUCN
// statement at all, while the real "vulnerable" status lived on a separate item under
// "Panthera uncia," linked only via P1420 "taxon synonym". This script reports how many
// species across every taxon the synonym-aware query recovers real data for, to confirm the
// gap wasn't specific to Snow Leopard.
import { pool } from "../db.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";

async function main() {
  const res = await pool.query<{ species_id: string; scientific_name: string; taxon_class: string }>(
    `SELECT s.id AS species_id, s.scientific_name, s.taxon_class
     FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE t.iucn_status IS NULL AND t.fully_extinct = false`,
  );
  console.log(`[backfill-iucn] ${res.rows.length} species with no iucn_status on file`);

  const byName = new Map(res.rows.map((r) => [r.scientific_name, r]));
  const names = [...byName.keys()];

  const wikidataRows = await fetchWikidataForSpecies(names);
  console.log(`[backfill-iucn] wikidata responded for ${wikidataRows.length} name(s)`);

  let recovered = 0;
  const recoveredByTaxon = new Map<string, number>();
  for (const row of wikidataRows) {
    if (!row.iucnStatus) continue;
    const match = byName.get(row.scientificName);
    if (!match) continue;
    await pool.query(`UPDATE species_traits SET iucn_status = $1 WHERE species_id = $2`, [row.iucnStatus, match.species_id]);
    recovered++;
    recoveredByTaxon.set(match.taxon_class, (recoveredByTaxon.get(match.taxon_class) ?? 0) + 1);
  }

  console.log(`[backfill-iucn] recovered iucn_status for ${recovered} species that previously had none:`);
  for (const [taxon, count] of recoveredByTaxon) console.log(`  ${taxon}: ${count}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
