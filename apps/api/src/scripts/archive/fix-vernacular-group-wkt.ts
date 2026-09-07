// One-time repair: every vernacular group region created by apply-vernacular-regions.ts got its
// external_codes built from the OLD (buggy) wktFromMergedGeometries, which stitched together
// each member province's independently-simplified ring into a MULTIPOLYGON — invalid per GBIF's
// geometry parser essentially every time (confirmed live: every group tried came back a 400).
// Recomputes external_codes with the fixed convex-hull version. boundary_geojson (used for map
// rendering, not queried by GBIF) never had this problem and is left untouched.
import { pool } from "../db.js";
import { wktFromMergedGeometries } from "data-pipeline/src/geometry.js";

async function main() {
  const groups = await pool.query<{ id: string; name: string }>(
    `SELECT id, name FROM regions WHERE has_children = true AND external_codes[1] LIKE 'MULTIPOLYGON(%'`,
  );
  console.log(`[fix-vernacular-group-wkt] ${groups.rows.length} vernacular group(s) to recompute`);

  let fixed = 0;
  for (const group of groups.rows) {
    const members = await pool.query<{ boundary_geojson: { geometry?: { type: string; coordinates: unknown } } | null }>(
      `SELECT boundary_geojson FROM regions WHERE parent_id = $1`,
      [group.id],
    );
    const geometries = members.rows
      .map((m) => m.boundary_geojson?.geometry)
      .filter((g): g is { type: string; coordinates: unknown } => g !== undefined && g !== null);
    const wkt = wktFromMergedGeometries(geometries);
    if (!wkt) {
      console.error(`[fix-vernacular-group-wkt]   ${group.name}: no usable geometry among its members, skipping`);
      continue;
    }
    await pool.query(`UPDATE regions SET external_codes = $1 WHERE id = $2`, [[wkt], group.id]);
    fixed++;
  }

  console.log(`[fix-vernacular-group-wkt] done. ${fixed}/${groups.rows.length} fixed.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
