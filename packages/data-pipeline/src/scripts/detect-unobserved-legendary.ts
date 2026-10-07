// Marks rare/legendary birds with no observation-type GBIF records at all (only fossil or museum
// specimens) as fully_extinct, catching extinct species GBIF's own extinct flags miss. Limited
// to the top tiers, where a false entry hurts most. Prints the flagged species for review.
import { pool } from "@lifer/core/db.js";
import { fetchWithRetry } from "@lifer/core/species/lazyEnrich.js";

const REAL_BASIS_OF_RECORD = ["HUMAN_OBSERVATION", "OBSERVATION", "MACHINE_OBSERVATION", "LIVING_SPECIMEN"];

async function hasEverBeenObserved(gbifKey: string): Promise<boolean> {
  const basisParams = REAL_BASIS_OF_RECORD.map((b) => `basisOfRecord=${b}`).join("&");
  const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${gbifKey}&${basisParams}&limit=0`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return true; // fail open: a network hiccup shouldn't flag a real species
  const data = (await res.json()) as { count: number };
  return data.count > 0;
}

// Fully extinct species can never be photographed, so they're hidden from listings (unlike
// extinct_in_wild, which captive populations can still make a target). REAL_BASIS_OF_RECORD
// includes LIVING_SPECIMEN, so "never observed" means no living individual on record at all.
async function markFullyExtinct(speciesId: string): Promise<void> {
  await pool.query(`UPDATE species_traits SET fully_extinct = true WHERE species_id = $1`, [speciesId]);
}

async function main() {
  const res = await pool.query<{ id: string; scientific_name: string; common_name: string | null; gbif_key: string; tier: string }>(
    `SELECT s.id, s.scientific_name, s.common_name, s.gbif_key, r.tier
     FROM species s JOIN species_rarity r ON r.species_id = s.id
     WHERE s.taxon_class = 'aves' AND r.tier IN ('rare', 'legendary')
     ORDER BY s.scientific_name`,
  );
  console.log(`[detect-unobserved] ${res.rows.length} epic/legendary birds to check`);

  let done = 0;
  const flagged: string[] = [];
  for (const row of res.rows) {
    const observed = await hasEverBeenObserved(row.gbif_key);
    if (!observed) {
      await markFullyExtinct(row.id);
      flagged.push(`${row.scientific_name} (${row.common_name ?? "no common name"}) [${row.tier}] gbif_key=${row.gbif_key}`);
      console.log(`[FLAGGED] ${row.scientific_name} (${row.common_name ?? "no common name"}) [${row.tier}]`);
    }
    done++;
    if (done % 200 === 0) console.log(`[detect-unobserved] ${done}/${res.rows.length} (${flagged.length} flagged so far)`);
  }

  console.log(`[detect-unobserved] done. ${done} checked, ${flagged.length} never observed alive:`);
  for (const f of flagged) console.log(`  ${f}`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
