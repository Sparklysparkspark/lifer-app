// One-off cleanup for species that predate fetch-gbif-backbone.ts's fossil-checklist and
// "spec" placeholder exclusions (the fish seed in particular was built before either filter
// existed — see that file's own comments). Reads the candidate list a prior audit produced
// (data/junk_species_candidates.tsv: scientific_name, gbif_key, taxon_class, family, reason)
// and deletes them, same safety pattern as purge-mammal-fossils.ts: refuse to delete anything
// with a real capture/user_species row against it.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pool } from "../db.js";

const CANDIDATES_FILE = path.join(process.cwd(), "..", "..", "data", "junk_species_candidates.tsv");

async function main() {
  const file = process.argv[2] ?? CANDIDATES_FILE;
  const lines = readFileSync(file, "utf-8").trim().split("\n");
  const candidates = lines.map((line) => {
    const [scientificName, gbifKey, taxonClass, family, reason] = line.split("\t");
    return { scientificName, gbifKey: Number(gbifKey), taxonClass, family, reason };
  });
  console.log(`[purge-fossil-and-placeholder-species] ${candidates.length} candidates from ${file}`);

  const gbifKeys = candidates.map((c) => c.gbifKey);
  const existing = await pool.query<{ id: string; gbif_key: string; scientific_name: string; common_name: string | null }>(
    `SELECT id, gbif_key, scientific_name, common_name FROM species WHERE gbif_key = ANY($1)`,
    [gbifKeys],
  );
  console.log(`[purge-fossil-and-placeholder-species] ${existing.rows.length} of those currently loaded`);

  if (existing.rows.length === 0) {
    console.log("[purge-fossil-and-placeholder-species] nothing to do.");
    await pool.end();
    return;
  }

  const ids = existing.rows.map((r) => r.id);
  const captureCheck = await pool.query<{ species_id: string }>(`SELECT DISTINCT species_id FROM captures WHERE species_id = ANY($1)`, [
    ids,
  ]);
  const userSpeciesCheck = await pool.query<{ species_id: string }>(
    `SELECT DISTINCT species_id FROM user_species WHERE species_id = ANY($1)`,
    [ids],
  );
  const referencedIds = new Set([...captureCheck.rows, ...userSpeciesCheck.rows].map((r) => r.species_id));

  const toDelete = existing.rows.filter((r) => !referencedIds.has(r.id));
  const blocked = existing.rows.filter((r) => referencedIds.has(r.id));

  if (blocked.length > 0) {
    console.error(`[purge-fossil-and-placeholder-species] ${blocked.length} candidates have real captures/user_species rows — skipping these, NOT deleting:`);
    for (const row of blocked) {
      console.error(`  ${row.scientific_name} (${row.common_name ?? "no common name"}) gbif_key=${row.gbif_key}`);
    }
  }

  console.log(`[purge-fossil-and-placeholder-species] deleting ${toDelete.length} species (0 references found)`);
  for (const row of toDelete.slice(0, 20)) {
    console.log(`  removing: ${row.scientific_name} (${row.common_name ?? "no common name"}) gbif_key=${row.gbif_key}`);
  }
  if (toDelete.length > 20) console.log(`  ...and ${toDelete.length - 20} more`);

  const deleteIds = toDelete.map((r) => r.id);
  const res = await pool.query(`DELETE FROM species WHERE id = ANY($1)`, [deleteIds]);
  console.log(`[purge-fossil-and-placeholder-species] deleted ${res.rowCount} species.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
