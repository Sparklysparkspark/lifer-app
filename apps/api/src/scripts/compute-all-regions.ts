// Drills every country down into its provinces/states (if not already done), then computes GBIF
// occurrence checklists for every region that doesn't have one yet. Feeds the region packs; the
// API never does this live.
//
// Usage: npx tsx src/scripts/compute-all-regions.ts [--countries=France,Germany]
import { pool } from "../db.js";
import { computeRegionOccurrences } from "../regions/compute/occurrences.js";
import { fetchProvincesForCountry } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { wktFromGeometry } from "data-pipeline/src/geometry.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";

// Exported for other scripts. countryNames limits it to a batch; omit for every country.
export async function drillDownAllCountries(countryNames?: string[]): Promise<void> {
  // Same criteria as POST /regions/:id/drill-down. Non-country regions simply match nothing.
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
      // GBIF doesn't understand Natural Earth's ISO 3166-2 codes, so the boundary is stored as
      // WKT for GBIF queries. The ISO code is kept as ebird_region_code for eBird.
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
  // Exact match on the named countries and their direct child provinces.
  const res = await pool.query(
    `SELECT r.id, r.name, r.boundary_geojson, r.external_codes FROM regions r
     LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.occurrence_computed_at IS NULL AND array_length(r.external_codes, 1) > 0
       ${countryNames ? `AND (r.name = ANY($1) OR p.name = ANY($1))` : ""}
     ORDER BY r.name`,
    countryNames ? [countryNames] : [],
  );
  console.log(`[compute-all-regions] ${res.rows.length} region(s) to compute`);

  // Sequential: GBIF's rate limit is tight enough that parallel workers mostly fail with 429s.
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
  // --countries=France,Germany limits the run to a batch instead of the whole world.
  const countriesArg = process.argv.find((a) => a.startsWith("--countries="));
  const countryNames = countriesArg ? countriesArg.split("=")[1].split(",") : undefined;
  await drillDownAllCountries(countryNames);
  await computeAllUncomputed(countryNames);
  await pool.end();
}

// Only run main() when this file is the entry point, not when imported for drillDownAllCountries.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
