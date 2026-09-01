// One-time pass (run once, then only again quarterly alongside a fresh pack release — not
// scheduled/cron'd): drills every country down into its provinces/states (if not already
// done), then computes real GBIF occurrence checklists for every region that doesn't have one
// yet. This is what actually populates the data that gets bundled into region packs (see
// packages/data-pipeline/src/build/build-region-pack.ts) — a self-hosted install's own API
// never does this live (see regions/routes.ts's own comment on that).
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/routes.js";
import { fetchProvincesForCountry } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { wktFromGeometry } from "data-pipeline/src/geometry.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

// Exported for reuse by recompute-all-regions.ts, which needs the same drill-down step but
// followed by a forced full recompute (every region, not just uncomputed ones) rather than
// this file's own "only what's missing" computeAllUncomputed. countryNames scopes this to a
// specific batch (e.g. prioritizing whichever countries beta testers actually need first)
// instead of the whole world — omit for the original unscoped behavior.
export async function drillDownAllCountries(countryNames?: string[]): Promise<void> {
  // Same criteria the API's own POST /regions/:id/drill-down uses. Attempting this on a
  // region that isn't actually a country (a province, say) is harmless — fetchProvincesForCountry
  // filters by the country's own GADM code, so a province's code just matches nothing and
  // zero rows get created.
  const res = await pool.query<{ id: string; name: string; external_codes: string[] }>(
    `SELECT id, name, external_codes FROM regions
     WHERE has_children = false AND array_length(external_codes, 1) > 0
       ${countryNames ? `AND name = ANY($1)` : ""}`,
    countryNames ? [countryNames] : [],
  );
  console.log(`[compute-all-regions] checking ${res.rows.length} region(s) for provinces/states to drill into`);

  for (const region of res.rows) {
    const provinces = await fetchProvincesForCountry(region.external_codes[0]);
    if (provinces.length === 0) continue;
    let created = 0;
    for (const province of provinces) {
      // Natural Earth only gives us an ISO 3166-2 code (e.g. "TH-70") — GBIF's gadmGid param
      // doesn't recognize that ID system at all and silently matches zero records for it (see
      // gbifRegionParam's own comment). Storing the province's own boundary as a WKT polygon
      // instead means every future GBIF query against it is correctly scoped to its real
      // shape, with no ID system mismatch possible. ebird_region_code keeps the ISO code
      // separately since that's still the right ID for eBird links elsewhere.
      const wkt = wktFromGeometry(province.feature.geometry as { type: string; coordinates: unknown });
      const insertRes = await pool.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, parent_id) DO NOTHING`,
        [province.name, region.id, wkt ? [wkt] : [], province.iso3166_2 ?? null, JSON.stringify(province.feature)],
      );
      if ((insertRes.rowCount ?? 0) > 0) created++;
    }
    await pool.query(`UPDATE regions SET has_children = true WHERE id = $1`, [region.id]);
    console.log(`[compute-all-regions] ${region.name}: drilled into ${created} new province/state row(s)`);
  }
}

async function computeAllUncomputed(countryNames?: string[]): Promise<void> {
  // Scoped to the named countries themselves AND their own already-drilled-down provinces —
  // not a substring/fuzzy match, an exact country name or one of its direct children's names.
  const res = await pool.query(
    `SELECT r.id, r.name, r.boundary_geojson, r.external_codes FROM regions r
     LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.occurrence_computed_at IS NULL AND array_length(r.external_codes, 1) > 0
       ${countryNames ? `AND (r.name = ANY($1) OR p.name = ANY($1))` : ""}
     ORDER BY r.name`,
    countryNames ? [countryNames] : [],
  );
  console.log(`[compute-all-regions] ${res.rows.length} region(s) to compute`);

  // Tried CONCURRENCY=4 for real — GBIF's actual rate limit turned out far tighter than
  // assumed: 150 of 156 regions in that run failed outright on 429 Too Many Requests, even
  // with fetchWithRetry's own backoff (each of the 4 workers independently backing off and
  // retrying just re-collided with the other 3 doing the same). Back to strictly sequential —
  // a slow, fully-successful run beats a fast, mostly-failed one that has to be re-run anyway.
  const CONCURRENCY = 1;
  let done = 0;
  let failed = 0;
  await mapWithConcurrency(res.rows, CONCURRENCY, async (region) => {
    try {
      await computeRegionOccurrences(region);
      done++;
    } catch (err) {
      failed++;
      console.error(`[compute-all-regions] FAILED ${region.name}:`, err);
      return;
    }
    console.log(`[compute-all-regions] ${done + failed}/${res.rows.length} ${region.name} computed`);
  });
  console.log(`[compute-all-regions] done. ${done} computed, ${failed} failed.`);
}

async function main() {
  // --countries=France,Germany,... scopes a run to a specific batch (e.g. prioritizing where
  // beta testers actually are) instead of attempting the whole world — see this file's own
  // top comment on just how long an unscoped run actually takes (single real country: ~6.5
  // minutes, sequential, no concurrency — GBIF's own rate limiting makes parallelizing this
  // not actually faster).
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countryNames = countriesArg ? countriesArg.split("=")[1].split(",") : undefined;
  await drillDownAllCountries(countryNames);
  await computeAllUncomputed(countryNames);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
