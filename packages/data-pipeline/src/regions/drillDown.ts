// Splits every country region into its provinces/states (if not already done), so province
// checklists have rows to fill.
import { pool } from "@lifer/core/db.js";
import { fetchProvincesForCountry } from "@lifer/core/regions/regionBoundary.js";
import { wktFromGeometry } from "@lifer/core/lib/geometry.js";

// countryNames limits it to a batch; omit for every country.
export async function drillDownAllCountries(countryNames?: string[]): Promise<void> {
  // Same criteria as POST /regions/:id/drill-down. Non-country regions simply match nothing.
  const res = await pool.query<{ id: string; name: string; external_codes: string[] }>(
    `SELECT id, name, external_codes FROM regions
     WHERE has_children = false AND array_length(external_codes, 1) > 0
       ${countryNames ? `AND name = ANY($1)` : ""}`,
    countryNames ? [countryNames] : [],
  );
  console.log(`[drill-down] checking ${res.rows.length} region(s) for provinces/states to drill into`);

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
    console.log(`[drill-down] ${region.name}: drilled into ${created} new province/state row(s)`);
  }
}
