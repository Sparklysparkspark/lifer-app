// One-time pass (run once, then only again quarterly alongside a fresh pack release — not
// scheduled/cron'd): drills every country down into its provinces/states (if not already
// done), then computes real GBIF occurrence checklists for every region that doesn't have one
// yet. This is what actually populates the data that gets bundled into region packs (see
// packages/data-pipeline/src/build/build-region-pack.ts) — a self-hosted install's own API
// never does this live (see regions/routes.ts's own comment on that).
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";
import { fetchProvincesForCountry } from "data-pipeline/src/fetch/fetch-region-boundary.js";

async function drillDownAllCountries(): Promise<void> {
  // Same criteria the API's own POST /regions/:id/drill-down uses. Attempting this on a
  // region that isn't actually a country (a province, say) is harmless — fetchProvincesForCountry
  // filters by the country's own GADM code, so a province's code just matches nothing and
  // zero rows get created.
  const res = await pool.query<{ id: string; name: string; external_codes: string[] }>(
    `SELECT id, name, external_codes FROM regions WHERE has_children = false AND array_length(external_codes, 1) > 0`,
  );
  console.log(`[compute-all-regions] checking ${res.rows.length} region(s) for provinces/states to drill into`);

  for (const region of res.rows) {
    const provinces = await fetchProvincesForCountry(region.external_codes[0]);
    if (provinces.length === 0) continue;
    let created = 0;
    for (const province of provinces) {
      const insertRes = await pool.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name) DO NOTHING`,
        [
          province.name,
          region.id,
          province.iso3166_2 ? [province.iso3166_2] : [],
          province.iso3166_2 ?? null,
          JSON.stringify(province.feature),
        ],
      );
      if ((insertRes.rowCount ?? 0) > 0) created++;
    }
    await pool.query(`UPDATE regions SET has_children = true WHERE id = $1`, [region.id]);
    console.log(`[compute-all-regions] ${region.name}: drilled into ${created} new province/state row(s)`);
  }
}

async function computeAllUncomputed(): Promise<void> {
  const res = await pool.query(
    `SELECT id, name, boundary_geojson, external_codes FROM regions
     WHERE occurrence_computed_at IS NULL AND array_length(external_codes, 1) > 0
     ORDER BY name`,
  );
  console.log(`[compute-all-regions] ${res.rows.length} region(s) to compute`);

  let done = 0;
  let failed = 0;
  for (const region of res.rows) {
    try {
      await computeRegionOccurrences(region);
      done++;
    } catch (err) {
      failed++;
      console.error(`[compute-all-regions] FAILED ${region.name}:`, err);
      continue;
    }
    console.log(`[compute-all-regions] ${done + failed}/${res.rows.length} ${region.name} computed`);
  }
  console.log(`[compute-all-regions] done. ${done} computed, ${failed} failed.`);
}

async function main() {
  await drillDownAllCountries();
  await computeAllUncomputed();
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
