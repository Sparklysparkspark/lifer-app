// One-time repair: every province drilled today via drillDownAllCountries stored a plain ISO
// 3166-2 code (e.g. "TH-70") as its external_codes[0] — GBIF's gadmGid param doesn't recognize
// that ID system at all, so every occurrence query against these provinces silently matched
// zero records regardless of real data density (see compute-all-regions.ts's drill-down,
// fixed to store a real WKT polygon instead going forward). This backfills the already-created
// rows: recomputes a WKT polygon from each affected province's own stored boundary_geojson and
// replaces external_codes with it, then clears occurrence_computed_at and
// province_split_meaningful so they get correctly recomputed from scratch rather than keeping
// their bogus "zero species" result.
import { pool } from "../db.js";
import { wktFromGeometry } from "data-pipeline/src/geometry.js";

async function main() {
  // Provinces only: a country-level region also fails the "contains a dot" check (real ISO3
  // codes like "THA" have no dot either) but must be left alone — scoping to children of an
  // already-drilled region (has_children=true) selects exactly the province level.
  const res = await pool.query<{ id: string; name: string; external_codes: string[]; boundary_geojson: { geometry?: unknown } | null }>(
    `SELECT id, name, external_codes, boundary_geojson FROM regions
     WHERE parent_id IN (SELECT id FROM regions WHERE has_children = true)
       AND array_length(external_codes, 1) > 0
       AND external_codes[1] NOT LIKE 'POLYGON(%'
       AND external_codes[1] NOT LIKE 'MULTIPOLYGON(%'
       AND external_codes[1] NOT LIKE '%.%'`,
  );
  console.log(`[fix-province-codes] ${res.rows.length} province(s) with a bogus (non-WKT, non-GADM) code to fix`);

  let fixed = 0;
  let noGeometry = 0;
  for (const region of res.rows) {
    const geometry = region.boundary_geojson?.geometry as { type: string; coordinates: unknown } | undefined;
    if (!geometry) {
      noGeometry++;
      console.error(`[fix-province-codes]   ${region.name}: no boundary_geojson.geometry to derive a WKT from, skipping`);
      continue;
    }
    const wkt = wktFromGeometry(geometry);
    if (!wkt) {
      noGeometry++;
      console.error(`[fix-province-codes]   ${region.name}: geometry present but not a Polygon/MultiPolygon, skipping`);
      continue;
    }
    await pool.query(
      `UPDATE regions SET external_codes = $1, occurrence_computed_at = NULL, province_split_meaningful = NULL WHERE id = $2`,
      [[wkt], region.id],
    );
    fixed++;
  }

  console.log(`[fix-province-codes] done. ${fixed} fixed, ${noGeometry} skipped (no usable geometry).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
