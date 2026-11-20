// Which species pins fall inside a region's outline: a pin follows where its photos were taken,
// not the region they're filed under. Pure, so it's tested without a database.
import { pointInRing, ringBoundingBox, type BoundingBox, type Point } from "@lifer/core/lib/geometry.js";

interface Polygon {
  outer: Point[];
  holes: Point[][];
  box: BoundingBox;
}
export type Outline = Polygon[];

/** A region's boundary_geojson (a Feature or a bare geometry) as polygons; null with no outline. */
export function parseOutline(geojson: unknown): Outline | null {
  const g = (geojson && typeof geojson === "object" && "geometry" in geojson ? geojson.geometry : geojson) as {
    type?: string;
    coordinates?: unknown;
  } | null;
  const polys =
    g?.type === "Polygon"
      ? [g.coordinates as Point[][]]
      : g?.type === "MultiPolygon"
        ? (g.coordinates as Point[][][])
        : [];
  const out = polys
    .filter((p) => Array.isArray(p) && p[0]?.length >= 3)
    .map(([outer, ...holes]) => ({ outer, holes, box: ringBoundingBox(outer) }));
  return out.length > 0 ? out : null;
}

const inBox = (lon: number, lat: number, b: BoundingBox) =>
  lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;

/** Whether the point is inside the outline: in some polygon's outer ring and none of its holes.
 *  A ring drawn past 180 (or before -180) to cross the antimeridian is tested a turn over too. */
export function inOutline(outline: Outline, lon: number, lat: number): boolean {
  return outline.some((p) =>
    [lon, lon + 360, lon - 360].some(
      (x) => inBox(x, lat, p.box) && pointInRing([x, lat], p.outer) && !p.holes.some((h) => pointInRing([x, lat], h)),
    ),
  );
}

export interface LonLatBox {
  w: number;
  s: number;
  e: number;
  n: number;
}

/** The outline's bounding box for a SQL prefilter, in -180..180 with west <= east: one box, or two
 *  when the region crosses the antimeridian (Fiji, the Aleutians), so it doesn't span the world. */
export function prefilterBoxes(outline: Outline): LonLatBox[] {
  const s = Math.min(...outline.map((p) => p.box.minLat));
  const n = Math.max(...outline.map((p) => p.box.maxLat));
  // Every polygon's longitudes folded into -180..180, as pieces.
  const pieces = outline.flatMap(({ box: { minLon, maxLon } }) => {
    if (maxLon - minLon >= 360) return [[-180, 180]];
    const w = ((((minLon + 180) % 360) + 360) % 360) - 180;
    const e = w + (maxLon - minLon);
    return e > 180
      ? [
          [w, 180],
          [-180, e - 360],
        ]
      : [[w, e]];
  });
  const plain = { w: Math.min(...pieces.map((p) => p[0])), e: Math.max(...pieces.map((p) => p[1])) };
  // The same span measured from 0..360: narrower means the region sits across 180.
  const shift = (x: number) => (x < 0 ? x + 360 : x);
  const east = pieces.filter((p) => p[0] >= 0);
  const west = pieces.filter((p) => p[1] <= 0 && p[0] < 0);
  const straddles = pieces.some((p) => p[0] < 0 && p[1] > 0);
  if (!straddles && east.length > 0 && west.length > 0) {
    const w360 = Math.min(...east.map((p) => p[0]));
    const e360 = Math.max(...west.map((p) => shift(p[1])));
    if (e360 - w360 < plain.e - plain.w)
      return [
        { w: w360, s, e: 180, n },
        { w: -180, s, e: e360 - 360, n },
      ];
  }
  return [{ w: plain.w, s, e: plain.e, n }];
}
