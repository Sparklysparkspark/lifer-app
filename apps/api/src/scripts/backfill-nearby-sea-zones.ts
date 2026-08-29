// Precomputes regions.nearby_sea_zone_ids (migration 052) — a pure function of static
// reference data (a region's boundary, sea zones' polygons) that never changes at runtime, so
// it belongs computed once here rather than live on every GET /regions/:id/sea-zones request
// (see that route's own comment: this used to take 2.5+ seconds for a large/complex coastline
// like Canada, synchronously blocking Node's event loop and stalling every other concurrent
// request behind it too). Re-runnable/idempotent — always recomputes and overwrites, so it's
// safe to re-run after a sea_zones or region boundary change.
import { pool } from "../db.js";
import { nearbyZones } from "../regions/routes.js";
import { exteriorRingsFromGeometry, type BoundingBox } from "data-pipeline/src/geometry.js";

async function main() {
  const res = await pool.query<{ id: string; name: string; boundary_geojson: { bbox?: number[]; geometry?: { type: string; coordinates: unknown } } | null }>(
    `SELECT id, name, boundary_geojson FROM regions`,
  );
  console.log(`[backfill-nearby-sea-zones] ${res.rows.length} regions to check`);

  let computed = 0;
  let skipped = 0;
  for (const region of res.rows) {
    const bbox = region.boundary_geojson?.bbox as [number, number, number, number] | undefined;
    const geometry = region.boundary_geojson?.geometry;
    if (!bbox || !geometry) {
      await pool.query(`UPDATE regions SET nearby_sea_zone_ids = '{}' WHERE id = $1`, [region.id]);
      skipped++;
      continue;
    }
    const regionBbox: BoundingBox = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
    const zones = await nearbyZones(regionBbox, exteriorRingsFromGeometry(geometry));
    await pool.query(`UPDATE regions SET nearby_sea_zone_ids = $1 WHERE id = $2`, [zones.map((z) => z.id), region.id]);
    computed++;
    if (computed % 50 === 0) console.log(`[backfill-nearby-sea-zones] ${computed}/${res.rows.length}`);
  }

  console.log(`[backfill-nearby-sea-zones] done. ${computed} computed, ${skipped} skipped (no boundary).`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
