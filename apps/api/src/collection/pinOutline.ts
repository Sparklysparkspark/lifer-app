// Which species pins fall in or near a region's outline: a pin follows where its photos were taken.
// Pure, so it's tested without a database.
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

/** How far outside its outline a photo still counts for a region: about 12 nautical miles, the
 *  territorial sea, so a photo from a boat off the coast still shows. */
export const NEAR_KM = 22;
const EARTH_KM = 6371.0088;
const KM_PER_DEG = (EARTH_KM * Math.PI) / 180;
const RAD = Math.PI / 180;

/** A box grown by km on every side; longitude spans the world when it would reach a pole. */
function grow(b: BoundingBox, km: number): BoundingBox {
  if (km <= 0) return b;
  const dLat = km / KM_PER_DEG;
  const minLat = Math.max(-90, b.minLat - dLat);
  const maxLat = Math.min(90, b.maxLat + dLat);
  const edge = Math.max(Math.abs(minLat), Math.abs(maxLat));
  const dLon = edge >= 89 ? 360 : Math.min(360, dLat / Math.cos(edge * RAD));
  return dLon >= 180
    ? { minLon: -540, maxLon: 540, minLat, maxLat }
    : { minLon: b.minLon - dLon, maxLon: b.maxLon + dLon, minLat, maxLat };
}

type Vec = [number, number, number];
const vec = (lon: number, lat: number): Vec => [
  Math.cos(lat * RAD) * Math.cos(lon * RAD),
  Math.cos(lat * RAD) * Math.sin(lon * RAD),
  Math.sin(lat * RAD),
];
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec, b: Vec): Vec => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const angle = (a: Vec, b: Vec) => Math.atan2(Math.hypot(...cross(a, b)), dot(a, b));

/** Great-circle km from p to the arc a-b, all unit vectors. */
function arcKm(p: Vec, a: Vec, b: Vec): number {
  const n = cross(a, b);
  const len = Math.hypot(...n);
  if (len < 1e-12) return angle(p, a) * EARTH_KM;
  const u: Vec = [n[0] / len, n[1] / len, n[2] / len];
  // The nearest point of the whole great circle lies between a and b: the arc's distance is p's.
  if (dot(cross(a, p), u) >= 0 && dot(cross(p, b), u) >= 0)
    return Math.abs(Math.asin(Math.max(-1, Math.min(1, dot(p, u))))) * EARTH_KM;
  return Math.min(angle(p, a), angle(p, b)) * EARTH_KM;
}

/** Km from the point to the ring's edge. An edge is drawn straight in lon/lat, so a long one is
 *  measured in pieces of at most 1 degree (a seam along a parallel near a pole, say). */
function ringKm(ring: Point[], lon: number, lat: number, within: number): number {
  const p = vec(lon, lat);
  const dLat = within / KM_PER_DEG;
  let best = Infinity;
  for (let i = 1; i < ring.length; i++) {
    const [ax, ay] = ring[i - 1];
    const [bx, by] = ring[i];
    // No point of an edge is nearer than its nearest latitude.
    if (lat < Math.min(ay, by) - dLat || lat > Math.max(ay, by) + dLat) continue;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay))));
    let prev = vec(ax, ay);
    for (let k = 1; k <= steps; k++) {
      const next = vec(ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps);
      best = Math.min(best, arcKm(p, prev, next));
      prev = next;
    }
  }
  return best;
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

/** Whether the point is inside the outline or within km of its edge. A hole isn't the region, so a
 *  point in a lake counts only within km of the lake's shore. */
export function nearOutline(outline: Outline, lon: number, lat: number, km = NEAR_KM): boolean {
  if (inOutline(outline, lon, lat)) return true;
  return outline.some(
    (p) =>
      [lon, lon + 360, lon - 360].some((x) => inBox(x, lat, grow(p.box, km))) &&
      [p.outer, ...p.holes].some((ring) => ringKm(ring, lon, lat, km) <= km),
  );
}

export interface LonLatBox {
  w: number;
  s: number;
  e: number;
  n: number;
}

/** The outline's bounding box grown by km, for a SQL prefilter, in -180..180 with west <= east: one
 *  box, or two when the region crosses the antimeridian (Fiji, the Aleutians), so it doesn't span
 *  the world. */
export function prefilterBoxes(outline: Outline, km = 0): LonLatBox[] {
  const boxes = outline.map((p) => grow(p.box, km));
  const s = Math.min(...boxes.map((b) => b.minLat));
  const n = Math.max(...boxes.map((b) => b.maxLat));
  // Every polygon's longitudes folded into -180..180, as pieces.
  const pieces = boxes.flatMap(({ minLon, maxLon }) => {
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
