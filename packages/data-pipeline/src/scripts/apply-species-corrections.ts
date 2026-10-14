// Applies data/reference/species-corrections.json now, for an edit to the file between refreshes
// (the refresh applies it at the end of its catalog and enrich stages).
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/apply-species-corrections.ts
import { pool } from "../db.js";
import { applySpeciesCorrections, loadSpeciesCorrections } from "../pipeline/speciesCorrections.js";

async function main() {
  const corrections = loadSpeciesCorrections();
  const missing = await applySpeciesCorrections(pool, corrections);
  console.log(`[species-corrections] ${corrections.length - missing.length} applied`);
  if (missing.length > 0) console.log(`[species-corrections] matching no catalog species: ${missing.join(", ")}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
