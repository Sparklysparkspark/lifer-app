// One-off check: a species can have zero real GBIF "extinct" flag AND no matching
// constituent-dataset filter (the two mechanisms fetch-gbif-backbone.ts already checks) while
// still having zero real observation-type occurrence records ever. Dinornis novaezealandiae,
// the North Island Giant Moa, is one example: 81 fossil/museum specimen records, 0
// HUMAN_OBSERVATION/OBSERVATION/MACHINE_OBSERVATION/LIVING_SPECIMEN records. That's a
// different, more general signal than either existing extinct filter: no one has ever seen
// this species alive, GBIF metadata notwithstanding. Scoped to epic/legendary birds only (not
// all 14,550), since a false positive in those top tiers is most costly to user trust and the
// check is cheap enough to run against just that subset. Reports candidates for review, same
// "never auto-delete" philosophy as detect-implausible-regions.ts.
import { pool } from "../db.js";
import { fetchWithRetry } from "../species/lazyEnrich.js";

const REAL_BASIS_OF_RECORD = ["HUMAN_OBSERVATION", "OBSERVATION", "MACHINE_OBSERVATION", "LIVING_SPECIMEN"];

async function hasEverBeenObserved(gbifKey: string): Promise<boolean> {
  const basisParams = REAL_BASIS_OF_RECORD.map((b) => `basisOfRecord=${b}`).join("&");
  const url = `https://api.gbif.org/v1/occurrence/search?taxonKey=${gbifKey}&${basisParams}&limit=0`;
  const res = await fetchWithRetry(url);
  if (!res.ok) return true; // fail open — a network hiccup shouldn't flag a real species
  const data = (await res.json()) as { count: number };
  return data.count > 0;
}

// Fully extinct species are excluded outright because they can never be photographed, which
// defeats the purpose of a photography life-list — distinct from extinct_in_wild
// (informational only, since a real captive/reintroduction population, per the Spix's Macaw
// precedent, can still make a species a legitimate target). REAL_BASIS_OF_RECORD includes
// LIVING_SPECIMEN, so a species that clears hasEverBeenObserved()'s check as "never observed"
// has zero record of any living individual, wild or captive, in GBIF's entire history — a
// direct signal for "fully extinct," not just "extinct in the wild." Hidden from
// collection/region listings entirely (species/routes.ts, collection/routes.ts,
// regions/routes.ts) rather than merely tagged, unlike extinct_in_wild.
async function markFullyExtinct(speciesId: string): Promise<void> {
  await pool.query(`UPDATE species_traits SET fully_extinct = true WHERE species_id = $1`, [speciesId]);
}

async function main() {
  const res = await pool.query<{ id: string; scientific_name: string; common_name: string | null; gbif_key: string; tier: string }>(
    `SELECT s.id, s.scientific_name, s.common_name, s.gbif_key, r.tier
     FROM species s JOIN species_rarity r ON r.species_id = s.id
     WHERE s.taxon_class = 'aves' AND r.tier IN ('epic', 'legendary')
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
