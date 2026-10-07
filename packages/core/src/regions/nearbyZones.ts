import { pool } from "../db.js";
import {
  bboxesNear,
  bboxContains,
  bboxDiagonalDegrees,
  SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES,
  minRingDistance,
  closestPointBetweenRings,
  pointInAnyRing,
  exteriorRingsFromGeometry,
  parseWktPolygonRing,
  type BoundingBox,
  type Point,
} from "../lib/geometry.js";

// Exterior rings of the region's country, for nearbyZones' coastline check. Null skips that check.
export async function resolveCountryRings(regionId: string): Promise<Point[][] | null> {
  const res = await pool.query<{
    geometry: { type: string; coordinates: unknown } | null;
    parent_id: string | null;
    parent_external_codes: string[] | null;
  }>(
    `SELECT r.boundary_geojson->'geometry' AS geometry, r.parent_id, p.external_codes AS parent_external_codes
     FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  // A parent without codes is a continent, so this region is the country.
  if (!row.parent_external_codes?.length) return row.geometry ? exteriorRingsFromGeometry(row.geometry) : null;
  const parentRes = await pool.query<{ geometry: { type: string; coordinates: unknown } | null }>(
    `SELECT boundary_geojson->'geometry' AS geometry FROM regions WHERE id = $1`,
    [row.parent_id],
  );
  const geometry = parentRes.rows[0]?.geometry;
  return geometry ? exteriorRingsFromGeometry(geometry) : null;
}

// Only the fallback for a region with no precomputed nearby_sea_zone_ids: the catalog's regions
// get theirs from data-pipeline's build-sea-zones.ts, measured against full-resolution outlines.
// A loose bbox pre-filter, then a vertex distance check against the stored 80-point outlines.
// 0.4 degrees (~44km) allows for their coarseness, though the large IHO seas' vertices are often
// further apart than that. The country rings check below rules out water across another country.
const BBOX_PREFILTER_BUFFER_DEGREES = 10;
const NEARBY_MAX_DISTANCE_DEGREES = 0.4;

// Tolerance for the zone's closest point to count as on the country's coastline: the country
// polygon is simplified, so an exact point-in-ring test would miss real coasts.
const COUNTRY_COASTLINE_TOLERANCE_DEGREES = 0.05;

export async function nearbyZones(
  regionBbox: BoundingBox,
  regionRings: Point[][],
  // The region's country rings. Without them, water across another country counts as nearby.
  countryRings?: Point[][],
): Promise<Array<{ id: string; name: string; wkt: string }>> {
  const zonesRes = await pool.query(
    `SELECT id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat FROM sea_zones`,
  );
  const shortlisted = zonesRes.rows.filter((z) =>
    bboxesNear(
      regionBbox,
      { minLon: z.bbox_min_lon, minLat: z.bbox_min_lat, maxLon: z.bbox_max_lon, maxLat: z.bbox_max_lat },
      BBOX_PREFILTER_BUFFER_DEGREES,
    ),
  );
  return shortlisted.filter((z) => {
    // A small island inside a zone's bbox is next to that water, whatever polygon
    // simplification does to the ring distance.
    const zoneBbox: BoundingBox = {
      minLon: z.bbox_min_lon,
      minLat: z.bbox_min_lat,
      maxLon: z.bbox_max_lon,
      maxLat: z.bbox_max_lat,
    };
    // Island-scale only: a large inland region can sit inside a whole basin's bbox too.
    if (
      bboxDiagonalDegrees(regionBbox) <= SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES &&
      bboxContains(zoneBbox, regionBbox)
    ) {
      return true;
    }
    const zoneRing = parseWktPolygonRing(z.wkt);
    const { distance, point: closestZonePoint } = closestPointBetweenRings(regionRings, [zoneRing]);
    if (distance > NEARBY_MAX_DISTANCE_DEGREES) return false;
    if (!countryRings) return true;
    // The zone's closest point must be on this country's coast: inside it (an inlet) or
    // within tolerance of its boundary.
    return (
      pointInAnyRing(closestZonePoint, countryRings) ||
      minRingDistance([[closestZonePoint]], countryRings) <= COUNTRY_COASTLINE_TOLERANCE_DEGREES
    );
  });
}
