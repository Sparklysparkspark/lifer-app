// A purely informational extinct_in_wild tag never removes anything on its own (see
// detect-implausible-regions.ts's comment — a real reintroduction population, e.g. Spix's
// Macaw, can make a species both extinct-in-the-wild AND a legitimate target). But combining
// extinct_in_wild with the near-single-record-outlier signal (local_tier epic/legendary AND
// local_frequency <= 2, in THIS specific region) is a much safer basis for removal than either
// alone: a genuine reintroduction population accumulates real, recurring records over time and
// would never look like a near-single-record outlier, so this rule can't touch it. Only removes
// the REGION_SPECIES row (that one region's checklist entry) — never the species itself, never
// other regions where the same species has real, non-outlier presence.
import { pool } from "../db.js";

async function main() {
  const res = await pool.query<{
    region_species_id: string;
    scientific_name: string;
    common_name: string | null;
    region_name: string;
    local_tier: string;
    local_frequency: number;
  }>(
    `SELECT rs.species_id || ':' || rs.region_id AS region_species_id, s.scientific_name, s.common_name,
            r.name AS region_name, rs.local_tier, rs.local_frequency
     FROM region_species rs
     JOIN species s ON s.id = rs.species_id
     JOIN species_traits t ON t.species_id = s.id
     JOIN regions r ON r.id = rs.region_id
     WHERE t.extinct_in_wild = true AND rs.local_tier IN ('epic', 'legendary') AND rs.local_frequency <= 2`,
  );
  console.log(`[purge-implausible-extinct] ${res.rows.length} region_species rows match (extinct_in_wild + near-single-record-outlier)`);
  for (const row of res.rows) {
    console.log(
      `  removing: ${row.scientific_name} (${row.common_name ?? "no common name"}) from ${row.region_name} ` +
        `[${row.local_tier}, ${row.local_frequency} records]`,
    );
  }

  if (res.rows.length === 0) {
    await pool.end();
    return;
  }

  const delRes = await pool.query(
    `DELETE FROM region_species rs
     USING species s, species_traits t
     WHERE rs.species_id = s.id AND t.species_id = s.id
       AND t.extinct_in_wild = true AND rs.local_tier IN ('epic', 'legendary') AND rs.local_frequency <= 2`,
  );
  console.log(`[purge-implausible-extinct] removed ${delRes.rowCount} region_species rows.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
