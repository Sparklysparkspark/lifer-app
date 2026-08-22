// One-off cleanup after fetch-gbif-backbone.ts's second extinct/fossil filter fix — the
// "German Wikipedia - Species Pages" GBIF constituent reliably populates
// `extinct: true`, unlike the Paleobiology Database constituent already excluded earlier.
// build-seed-mammals.ts was re-run with LIFER_BUILD_ID=mammals-extinct-fix and produced 7888
// species (down from the ~8203 currently loaded) — this diffs the two sets and removes the
// now-excluded fossil/extinct species from the live DB, same pattern as the original
// Paleobiology Database purge: verify zero captures/user_species reference an orphan before
// deleting it (a real sighting logged against a species is a hard stop, not something to
// silently drop).
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";
import { BUILD_DIR } from "../raw-cache.js";

interface SeedSpecies {
  gbifKey: number;
}

async function main() {
  const buildId = process.env.LIFER_BUILD_ID ?? "mammals-extinct-fix";
  const dir = path.join(BUILD_DIR, buildId);
  const newSpecies: SeedSpecies[] = JSON.parse(readFileSync(path.join(dir, "species.json"), "utf-8"));
  const newGbifKeys = new Set(newSpecies.map((s) => s.gbifKey));
  console.log(`[purge-mammal-fossils] new seed (${buildId}) has ${newGbifKeys.size} mammal species`);

  const existing = await pool.query<{ id: string; gbif_key: string; scientific_name: string; common_name: string | null }>(
    `SELECT s.id, s.gbif_key, s.scientific_name, s.common_name
     FROM species s
     JOIN species_traits t ON t.species_id = s.id
     WHERE t.source_attribution LIKE 'Mammal Diversity Database%'`,
  );
  console.log(`[purge-mammal-fossils] ${existing.rows.length} mammal species currently loaded (MDD-sourced)`);

  const orphans = existing.rows.filter((r) => !newGbifKeys.has(Number(r.gbif_key)));
  console.log(`[purge-mammal-fossils] ${orphans.length} species no longer in the new seed (candidates for removal)`);

  if (orphans.length === 0) {
    console.log("[purge-mammal-fossils] nothing to do.");
    await pool.end();
    return;
  }

  const orphanIds = orphans.map((r) => r.id);
  const captureCheck = await pool.query<{ species_id: string; n: string }>(
    `SELECT species_id, count(*) as n FROM captures WHERE species_id = ANY($1) GROUP BY species_id`,
    [orphanIds],
  );
  const userSpeciesCheck = await pool.query<{ species_id: string; n: string }>(
    `SELECT species_id, count(*) as n FROM user_species WHERE species_id = ANY($1) GROUP BY species_id`,
    [orphanIds],
  );
  const referencedIds = new Set([...captureCheck.rows, ...userSpeciesCheck.rows].map((r) => r.species_id));

  if (referencedIds.size > 0) {
    console.error(
      `[purge-mammal-fossils] ABORTING — ${referencedIds.size} orphan species have real captures/user_species rows, refusing to delete any of them:`,
    );
    for (const id of referencedIds) {
      const row = orphans.find((o) => o.id === id)!;
      console.error(`  ${row.scientific_name} (${row.common_name ?? "no common name"}) gbif_key=${row.gbif_key}`);
    }
    await pool.end();
    process.exit(1);
  }

  console.log(`[purge-mammal-fossils] 0 captures/user_species rows reference any orphan — safe to delete all ${orphans.length}.`);
  for (const row of orphans.slice(0, 20)) {
    console.log(`  removing: ${row.scientific_name} (${row.common_name ?? "no common name"}) gbif_key=${row.gbif_key}`);
  }
  if (orphans.length > 20) console.log(`  ...and ${orphans.length - 20} more`);

  const res = await pool.query(`DELETE FROM species WHERE id = ANY($1)`, [orphanIds]);
  console.log(`[purge-mammal-fossils] deleted ${res.rowCount} species.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
