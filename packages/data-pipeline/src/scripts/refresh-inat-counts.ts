// Fetches every region's iNaturalist research-grade species list with observation counts, for
// places whose cached list has none yet. Tiers are rated on those counts: research-grade
// observations are photographs, so a species' share of its group's photos in a place is the most
// direct measure of how hard it is to photograph there. Resumable: places already fetched with
// counts are skipped, so rerunning after an interruption only does what's left. Run it on its own:
// alongside another job calling iNaturalist it gets throttled.
//
// Usage (from packages/data-pipeline): npx tsx src/scripts/refresh-inat-counts.ts
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "@lifer/core/db.js";
import { refreshPlaceCounts } from "@lifer/core/regions/inatChecklist.js";

export async function refreshAllPlaceCounts(
  log: (m: string) => void = console.log,
): Promise<{ done: number; failed: number }> {
  const places = await pool.query<{ inat_place_id: number }>(
    `SELECT DISTINCT inat_place_id FROM regions WHERE inat_place_id IS NOT NULL ORDER BY 1`,
  );
  let done = 0;
  let failed = 0;
  for (const [i, p] of places.rows.entries()) {
    if (await refreshPlaceCounts(p.inat_place_id)) done++;
    else {
      // Almost always iNaturalist throttling: carrying on straight away only keeps it throttled.
      failed++;
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
    if ((i + 1) % 50 === 0) log(`[inat-counts] ${i + 1}/${places.rows.length} places (${failed} failed)`);
  }
  return { done, failed };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  refreshAllPlaceCounts()
    .then(async (r) => {
      console.log(`[inat-counts] ${r.done} places with counts, ${r.failed} failed (rerun to retry)`);
      await pool.end();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
