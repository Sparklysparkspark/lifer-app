// The 74 duplicate-species pairs neither find-duplicate-species.ts nor
// resolve-ambiguous-duplicates.ts could resolve via iNaturalist — checked directly against
// GBIF too (both sides come back "ACCEPTED", sometimes under entirely different families —
// e.g. Cracticus quoyi/Cracticidae vs Melloria quoyi/Artamidae for "Black Butcherbird" — a
// genuine unreconciled disagreement between GBIF's constituent checklists, not something any
// API resolves cleanly). No external authority decisively picks a winner for these, so this
// applies a pragmatic, deterministic tie-break instead: prefer whichever side already has
// richer data in OUR OWN database (a cached reference photo, more region/sea-zone links),
// falling back to alphabetical order only when both sides are equally empty. This is a
// practical choice to stop showing visible duplicates, not a verified taxonomic ruling.
import { writeFileSync } from "node:fs";
import { pool } from "../db.js";

function epithet(scientificName: string): string {
  const parts = scientificName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}
function genus(scientificName: string): string {
  return scientificName.trim().split(/\s+/)[0].toLowerCase();
}

async function main() {
  const res = await pool.query<{
    id: string;
    common_name: string;
    scientific_name: string;
    reference_photo: string | null;
    region_count: string;
    sea_zone_count: string;
  }>(
    `SELECT s.id, s.common_name, s.scientific_name, s.reference_photo,
            (SELECT count(*) FROM region_species WHERE species_id = s.id) AS region_count,
            (SELECT count(*) FROM sea_zone_species WHERE species_id = s.id) AS sea_zone_count
     FROM species s
     WHERE s.common_name IS NOT NULL AND s.taxon_class IN ('aves', 'mammalia')`,
  );

  const byNameAndEpithet = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    const key = `${row.common_name.toLowerCase()}|${epithet(row.scientific_name)}`;
    const group = byNameAndEpithet.get(key) ?? [];
    group.push(row);
    byNameAndEpithet.set(key, group);
  }
  const candidateGroups = [...byNameAndEpithet.values()].filter(
    (g) => g.length > 1 && new Set(g.map((r) => genus(r.scientific_name))).size > 1,
  );

  console.log(`${candidateGroups.length} groups to tie-break\n`);

  const decided = candidateGroups.map((group) => {
    const scored = group.map((r) => ({
      row: r,
      score: (r.reference_photo ? 1000 : 0) + Number(r.region_count) + Number(r.sea_zone_count),
    }));
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.row.scientific_name.localeCompare(b.row.scientific_name);
    });
    const [winner, ...losers] = scored;
    console.log(
      `KEEP: ${winner.row.scientific_name} (${winner.row.common_name}) [score ${winner.score}]  <-  MERGE: ${losers.map((l) => `${l.row.scientific_name} [score ${l.score}]`).join(", ")}`,
    );
    return { keepId: winner.row.id, mergeIds: losers.map((l) => l.row.id) };
  });

  writeFileSync("/tmp/remaining-resolved.json", JSON.stringify(decided, null, 2));
  console.log(`\nWrote ${decided.length} decisions to /tmp/remaining-resolved.json`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
