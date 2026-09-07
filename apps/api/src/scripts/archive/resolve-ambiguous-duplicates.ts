// Second pass over the duplicate-species candidates find-duplicate-species.ts couldn't
// resolve with a strict species-rank-only iNaturalist check — this uses the fuller
// fetchINaturalistTaxon (species rank, OR a documented taxon_changes.json reclassification,
// OR a subspecies-of-a-different-parent match — see lazyEnrich.ts) on each side. A group
// resolves here if exactly one side gets a hit via any of those three methods and the other
// gets none. Still read-only; writes results to /tmp/ambiguous-resolved.json for
// merge-duplicate-species.ts to consume (same format: {keepId, mergeIds}).
import { writeFileSync } from "node:fs";
import { pool } from "../db.js";
import { fetchINaturalistTaxon } from "../species/lazyEnrich.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

const CONCURRENCY = 6;

function epithet(scientificName: string): string {
  const parts = scientificName.trim().split(/\s+/);
  return parts[parts.length - 1].toLowerCase();
}
function genus(scientificName: string): string {
  return scientificName.trim().split(/\s+/)[0].toLowerCase();
}

async function main() {
  const res = await pool.query<{ id: string; common_name: string; scientific_name: string }>(
    `SELECT id, common_name, scientific_name FROM species WHERE common_name IS NOT NULL AND taxon_class IN ('aves', 'mammalia')`,
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

  console.log(`${candidateGroups.length} candidate groups remaining\n`);

  let processed = 0;
  const results = await mapWithConcurrency(candidateGroups, CONCURRENCY, async (group) => {
    const withHit = await Promise.all(
      group.map(async (row) => ({ row, hit: await fetchINaturalistTaxon(row.scientific_name) })),
    );
    const hits = withHit.filter((w) => w.hit !== null);
    const current = hits.length === 1 ? hits[0].row : null;
    processed++;
    if (processed % 20 === 0) console.log(`  ${processed}/${candidateGroups.length}...`);
    return { group, current, stale: current ? group.filter((r) => r.id !== current.id) : [] };
  });

  const resolved = results.filter((r) => r.current);
  const stillAmbiguous = results.filter((r) => !r.current);

  console.log(`\n${resolved.length} resolved on second pass`);
  console.log(`${stillAmbiguous.length} still ambiguous\n`);

  for (const r of resolved) {
    console.log(
      `KEEP: ${r.current!.scientific_name} (${r.current!.common_name}) [${r.current!.id}]  <-  MERGE: ${r.stale.map((s) => `${s.scientific_name} [${s.id}]`).join(", ")}`,
    );
  }

  if (stillAmbiguous.length > 0) {
    console.log("\n--- STILL AMBIGUOUS (genuinely needs manual review) ---");
    for (const r of stillAmbiguous) {
      console.log(`  ${r.group.map((g) => `${g.scientific_name} [${g.id}]`).join(" vs ")} (common: ${r.group[0].common_name})`);
    }
  }

  writeFileSync(
    "/tmp/ambiguous-resolved.json",
    JSON.stringify(
      resolved.map((r) => ({ keepId: r.current!.id, mergeIds: r.stale.map((s) => s.id) })),
      null,
      2,
    ),
  );
  console.log(`\nWrote ${resolved.length} resolved pairs to /tmp/ambiguous-resolved.json`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => pool.end());
