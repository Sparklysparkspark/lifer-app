// regions/routes.ts's computeRegionOccurrences used to hardcode isVagrant=false for every fish
// species, unconditionally (see that file's own comment on why: the strict bird recurrence
// check, tuned around 3+ distinct years, wrongly flagged real small-island reef residents
// vagrant since their land-polygon record counts rarely span that many years). That blanket
// exemption meant a fish with 1-2 total GBIF records ever, anywhere in a region's history, sailed
// onto its checklist as a non-vagrant "legendary" resident with zero signal marking it as
// implausible — confirmed for real: a Falklands/Argentina skate and a Borneo-endemic minnow both
// showed up as "legendary" Canada residents on exactly one or two all-time records.
//
// This is a pure data-correction pass over already-computed region_species rows — no live GBIF
// call needed, since local_frequency (the region's own all-time record count for that species)
// is already stored from whenever the checklist itself was built. Re-runnable/idempotent: only
// touches rows that don't already match the corrected value, across every region, not just one
// country — the same floor now applied by regions/routes.ts for any FUTURE checklist computation
// (see FISH_VAGRANT_MIN_RECORDS there), applied here retroactively to what's already computed.
import { pool } from "../db.js";

const FISH_VAGRANT_MIN_RECORDS = 3;

async function main() {
  const toFlag = await pool.query<{ scientific_name: string; region_name: string; local_frequency: number }>(
    `SELECT s.scientific_name, r.name AS region_name, rs.local_frequency
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     JOIN regions r ON r.id = rs.region_id
     WHERE s.taxon_class = 'actinopterygii' AND rs.local_frequency < $1 AND rs.is_vagrant = false
     ORDER BY r.name, s.scientific_name`,
    [FISH_VAGRANT_MIN_RECORDS],
  );
  console.log(`[fix-fish-vagrancy] ${toFlag.rows.length} region_species rows to flag vagrant (fish, <${FISH_VAGRANT_MIN_RECORDS} all-time records)`);
  for (const row of toFlag.rows) {
    console.log(`  ${row.region_name}: ${row.scientific_name} (${row.local_frequency} record${row.local_frequency === 1 ? "" : "s"})`);
  }

  const res = await pool.query(
    `UPDATE region_species rs SET is_vagrant = true
     FROM species s
     WHERE rs.species_id = s.id AND s.taxon_class = 'actinopterygii' AND rs.local_frequency < $1 AND rs.is_vagrant = false`,
    [FISH_VAGRANT_MIN_RECORDS],
  );
  console.log(`[fix-fish-vagrancy] done. ${res.rowCount} rows updated.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
