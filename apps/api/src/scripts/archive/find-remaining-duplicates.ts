// Broader duplicate-species sweep, no longer requiring an exact epithet match (the first
// sweep's approach, which missed real duplicates differing only by a Latin gender ending —
// "lunulata" vs "lunulatus" — or by a completely different but same-meaning epithet in another
// language — "melanocephalos" vs "atriceps", both "black-headed"). Resolution signal:
// query iNaturalist's own relevance search for BOTH scientific names and check whether they
// converge on any shared taxon ID in their top results — iNaturalist's search already
// understands synonyms internally, so this catches cases no spelling heuristic would.
//
// Also flags (but does NOT try to merge) groups whose "common name" is actually a 4-6 letter
// all-caps banding/alpha code applied to two genuinely UNRELATED species — a different bug
// (bad common_name data), not a duplicate-species case, and merging those would be wrong.
import { writeFileSync } from "node:fs";
import { pool } from "../db.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 6;
const ALPHA_CODE_PATTERN = /^[A-Z]{4,6}$/;

async function searchTaxonIds(scientificName: string): Promise<Set<number>> {
  const res = await fetch(`https://api.inaturalist.org/v1/taxa?q=${encodeURIComponent(scientificName)}&per_page=10`);
  if (!res.ok) return new Set();
  const data = (await res.json()) as { results: Array<{ id: number }> };
  return new Set(data.results.map((r) => r.id));
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

  const byName = new Map<string, typeof res.rows>();
  for (const row of res.rows) {
    const group = byName.get(row.common_name) ?? [];
    group.push(row);
    byName.set(row.common_name, group);
  }
  const allGroups = [...byName.entries()].filter(([, g]) => g.length > 1);

  const alphaCodeGroups = allGroups.filter(([name]) => ALPHA_CODE_PATTERN.test(name));
  const realGroups = allGroups.filter(([name]) => !ALPHA_CODE_PATTERN.test(name));

  console.log(`${allGroups.length} total duplicate-common-name groups`);
  console.log(`${alphaCodeGroups.length} look like banding/alpha codes, not real common names — SKIPPING (flagged below)`);
  console.log(`${realGroups.length} to check for genuine species duplication\n`);

  let processed = 0;
  const results = await mapWithConcurrency(realGroups, CONCURRENCY, async ([commonName, group]) => {
    // Pairwise convergence check; union-find-lite via a simple "any shared taxon with anyone
    // else in the group" rule, good enough for the group sizes actually observed (2-3).
    const idSets = await Promise.all(group.map((r) => searchTaxonIds(r.scientific_name)));
    const linked = new Set<number>(); // indices confirmed to share a taxon with at least one other member
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const overlap = [...idSets[i]].some((id) => idSets[j].has(id));
        if (overlap) {
          linked.add(i);
          linked.add(j);
        }
      }
    }
    processed++;
    if (processed % 20 === 0) console.log(`  ${processed}/${realGroups.length}...`);

    if (linked.size < 2) return { commonName, group, confirmed: [] as typeof group };
    const confirmed = group.filter((_, i) => linked.has(i));
    return { commonName, group, confirmed };
  });

  const resolved = results.filter((r) => r.confirmed.length > 1);
  const unresolved = results.filter((r) => r.confirmed.length <= 1);

  console.log(`\n${resolved.length} groups confirmed as genuine duplicates (converge on a shared iNaturalist taxon)`);
  console.log(`${unresolved.length} groups NOT confirmed (no shared taxon found — likely genuinely different species with a coincidentally shared name)\n`);

  const decided = resolved.map((r) => {
    const scored = r.confirmed.map((row) => ({
      row,
      score: (row.reference_photo ? 1000 : 0) + Number(row.region_count) + Number(row.sea_zone_count),
    }));
    scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.row.scientific_name.localeCompare(b.row.scientific_name)));
    const [winner, ...losers] = scored;
    console.log(
      `KEEP: ${winner.row.scientific_name} (${r.commonName}) [score ${winner.score}]  <-  MERGE: ${losers.map((l) => `${l.row.scientific_name} [score ${l.score}]`).join(", ")}`,
    );
    return { keepId: winner.row.id, mergeIds: losers.map((l) => l.row.id) };
  });

  if (alphaCodeGroups.length > 0) {
    console.log("\n--- FLAGGED: common_name looks like a banding/alpha code (not merged, likely a data bug) ---");
    for (const [name, group] of alphaCodeGroups) {
      console.log(`  "${name}": ${group.map((g) => g.scientific_name).join(" / ")}`);
    }
  }

  if (unresolved.length > 0) {
    console.log("\n--- NOT CONFIRMED (left alone) ---");
    for (const r of unresolved) {
      console.log(`  "${r.commonName}": ${r.group.map((g) => g.scientific_name).join(" vs ")}`);
    }
  }

  writeFileSync("/tmp/spelling-variant-resolved.json", JSON.stringify(decided, null, 2));
  console.log(`\nWrote ${decided.length} decisions to /tmp/spelling-variant-resolved.json`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
