// Small, dependency-free geometry helpers, mainly for simplifying polygon rings under GBIF's
// vertex limit and building valid WKT from them.

export type Point = [number, number];

// Ramer-Douglas-Peucker line simplification: keep the point furthest from the segment's chord
// (and recurse) if it's farther than `epsilon`, otherwise drop everything between the endpoints.
export function simplifyRing(points: Point[], epsilon: number): Point[] {
  if (points.length <= 3) return points;

  function perpendicularDistance(p: Point, a: Point, b: Point): number {
    const [x, y] = p;
    const [x1, y1] = a;
    const [x2, y2] = b;
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) return Math.hypot(x - x1, y - y1);
    const t = ((x - x1) * dx + (y - y1) * dy) / lenSq;
    const projX = x1 + t * dx;
    const projY = y1 + t * dy;
    return Math.hypot(x - projX, y - projY);
  }

  function rdp(pts: Point[]): Point[] {
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent, two points have nothing in between, so the code below returns the same two
    if (pts.length <= 2) return pts;
    let maxDist = -1;
    // Stryker disable next-line UnaryOperator: equivalent, the first interior point always beats maxDist's -1 and sets it
    let maxIdx = -1;
    // Stryker disable next-line EqualityOperator: equivalent, the extra last point lies on the chord (distance 0) and never wins
    for (let i = 1; i < pts.length - 1; i++) {
      const dist = perpendicularDistance(pts[i], pts[0], pts[pts.length - 1]);
      if (dist > maxDist) {
        maxDist = dist;
        maxIdx = i;
      }
    }
    if (maxDist > epsilon) {
      const left = rdp(pts.slice(0, maxIdx + 1));
      const right = rdp(pts.slice(maxIdx));
      return [...left.slice(0, -1), ...right];
    }
    return [pts[0], pts[pts.length - 1]];
  }

  return rdp(points);
}

// Whether segments [a,b] and [c,d] cross (orientation test). Used by isSimpleRing.
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

// A simplified ring can self-intersect (RDP has no topological guarantee), and GBIF rejects
// that as "Invalid shape in WKT". O(n²) is cheap at these point counts (≤170).
export function isSimpleRing(ring: Point[]): boolean {
  const n = ring.length;
  // Stryker disable next-line EqualityOperator,ArithmeticOperator: equivalent, the inner loop has nothing left to compare for the extra i
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      if (j === i + 1 || (i === 0 && j === n - 2)) continue; // adjacent edges share an endpoint, not a crossing
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return false;
    }
  }
  return true;
}

// Andrew's monotone chain. Always a valid convex polygon, used as the last-resort fallback
// when a simplified ring self-intersects: coarser, but GBIF accepts it.
export function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]));
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const buildHalf = (pts: Point[]) => {
    const hull: Point[] = [];
    for (const p of pts) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    return hull;
  };
  const lower = buildHalf(sorted);
  const upper = buildHalf([...sorted].reverse());
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  hull.push(hull[0]); // close the ring
  return hull;
}

// Simplifies a closed ring to at most `maxPoints` vertices. GBIF's `geometry` WKT param rejects
// rings above ~170 coordinates (undocumented, found empirically), so callers stay well under.
// Grows epsilon in a loop since RDP has no closed-form epsilon for a point count. Falls back
// to a convex hull if the result self-intersects.
export function simplifyRingToMaxPoints(points: Point[], maxPoints: number): Point[] {
  const simplified = rdpToMaxPoints(points, maxPoints);
  return isSimpleRing(simplified) ? simplified : convexHull(points);
}

// Like simplifyRingToMaxPoints, but repairs a self-intersecting result by cutting off its smaller
// loops before falling back to the hull. Detailed coastlines (IHO sea areas) self-intersect after
// simplification about half the time, and their hull would take in a lot of land.
export function simplifyRingToMaxPointsRepaired(points: Point[], maxPoints: number): Point[] {
  const simplified = rdpToMaxPoints(points, maxPoints);
  if (isSimpleRing(simplified) && !hasRepeatedVertex(simplified)) return simplified;
  const repaired = removeSelfIntersectionLoops(simplified);
  return repaired.length >= 4 && isSimpleRing(repaired) && !hasRepeatedVertex(repaired) ? repaired : convexHull(points);
}

function rdpToMaxPoints(points: Point[], maxPoints: number): Point[] {
  let simplified = points;
  if (points.length > maxPoints) {
    let epsilon = 0.001;
    simplified = points;
    let reached = false;
    for (let i = 0; i < 40; i++) {
      simplified = simplifyRing(points, epsilon);
      if (simplified.length <= maxPoints) {
        reached = true;
        break;
      }
      epsilon *= 1.5;
    }
    if (!reached) {
      // RDP didn't converge (pathological input), so decimate evenly. Striding can drop the closing
      // point; closeRing below restores it, since GBIF rejects open rings.
      const stride = Math.ceil(points.length / maxPoints);
      simplified = points.filter((_, i) => i % stride === 0);
    }
  }
  return closeRing(simplified);
}

function repeatedVertexPair(pts: Point[]): [number, number] | null {
  const firstIndex = new Map<string, number>();
  for (let j = 0; j < pts.length; j++) {
    const key = `${pts[j][0]} ${pts[j][1]}`;
    const i = firstIndex.get(key);
    if (i !== undefined) return [i, j];
    firstIndex.set(key, j);
  }
  return null;
}

function segmentIntersection(a: Point, b: Point, c: Point, d: Point): Point {
  const denom = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denom;
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

function openRingArea(pts: Point[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    // Stryker disable next-line AssignmentOperator: equivalent, the sign is dropped by Math.abs below
    sum += x1 * y2 - x2 * y1;
  }
  // Stryker disable next-line ArithmeticOperator: equivalent, areas are only compared with each other, so the scale doesn't matter
  return Math.abs(sum / 2);
}

// A ring that comes back to one of its own vertices touches itself there without crossing, which
// isSimpleRing doesn't see but GBIF rejects ("Invalid shape in WKT"). Some EEZ outlines pinch like
// that where two lobes of water meet.
function hasRepeatedVertex(ring: Point[]): boolean {
  const seen = new Set<string>();
  for (const [x, y] of ring.slice(0, -1)) {
    const key = `${x} ${y}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// At each crossing (or repeated vertex), the ring splits into two loops joined at that point; the
// one with the smaller area (a lobe the simplification folded over) is dropped. Each step removes
// at least one vertex, so this ends. Closed ring in, closed ring out.
export function removeSelfIntersectionLoops(ring: Point[]): Point[] {
  // Stryker disable next-line MethodExpression: equivalent, a kept closing point is a repeated vertex and is split off below as an empty loop
  let pts = closeRing(ring).slice(0, -1);
  for (;;) {
    const n = pts.length;
    // Stryker disable next-line ConditionalExpression,EqualityOperator: equivalent, two points (or a triangle) have no crossing or repeated vertex to remove
    if (n < 3) return closeRing(pts);
    let crossing: [number, number] | null = null;
    // Stryker disable next-line EqualityOperator: equivalent, for i = n the inner loop doesn't run
    search: for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue; // adjacent through the closing edge
        if (segmentsIntersect(pts[i], pts[i + 1], pts[j], pts[(j + 1) % n])) {
          crossing = [i, j];
          break search;
        }
      }
    }
    if (!crossing) {
      const pinch = repeatedVertexPair(pts);
      if (!pinch) return closeRing(pts);
      const [i, j] = pinch;
      const loop = pts.slice(i, j);
      const rest = [...pts.slice(0, i), ...pts.slice(j)];
      pts = openRingArea(loop) > openRingArea(rest) ? loop : rest;
      continue;
    }
    const [i, j] = crossing;
    const x = segmentIntersection(pts[i], pts[i + 1], pts[j], pts[(j + 1) % n]);
    const loop = [x, ...pts.slice(i + 1, j + 1)];
    const rest = [...pts.slice(0, i + 1), x, ...pts.slice(j + 1)];
    pts = openRingArea(loop) > openRingArea(rest) ? loop : rest;
  }
}

// A valid WKT/GeoJSON ring's first and last points must match. Cheap insurance for every path.
function closeRing(ring: Point[]): Point[] {
  if (ring.length === 0) return ring;
  const [firstX, firstY] = ring[0];
  const [lastX, lastY] = ring[ring.length - 1];
  return firstX === lastX && firstY === lastY ? ring : [...ring, ring[0]];
}

// GBIF rejects clockwise exterior rings, and Natural Earth files don't reliably follow the CCW
// convention, so winding is checked and fixed per ring.
export function ensureCounterClockwise(ring: Point[]): Point[] {
  let signedArea = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[i + 1];
    signedArea += x1 * y2 - x2 * y1;
  }
  // Positive signed area (shoelace formula) = counter-clockwise.
  return signedArea > 0 ? ring : [...ring].reverse();
}

// Rounding to 5 decimals (~1.1m) roughly halves each coordinate's length, keeping the GBIF
// request URL under its length limit (see fetch-iho-sea-areas.ts).
const WKT_COORDINATE_PRECISION = 5;

export function ringToWktPolygon(ring: Point[]): string {
  const coords = ring
    .map(([x, y]) => `${x.toFixed(WKT_COORDINATE_PRECISION)} ${y.toFixed(WKT_COORDINATE_PRECISION)}`)
    .join(",");
  return `POLYGON((${coords}))`;
}

export interface BoundingBox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

export function ringBoundingBox(ring: Point[]): BoundingBox {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const [x, y] of ring) {
    // Stryker disable next-line EqualityOperator: equivalent, on a tie the value stored is the same
    if (x < minLon) minLon = x;
    // Stryker disable next-line EqualityOperator: equivalent, on a tie the value stored is the same
    if (x > maxLon) maxLon = x;
    // Stryker disable next-line EqualityOperator: equivalent, on a tie the value stored is the same
    if (y < minLat) minLat = y;
    // Stryker disable next-line EqualityOperator: equivalent, on a tie the value stored is the same
    if (y > maxLat) maxLat = y;
  }
  return { minLon, minLat, maxLon, maxLat };
}

// Loose bbox proximity with a degree buffer, only a cheap shortlist before the real distance
// check: an irregular sea's bbox can overlap regions its coastline is nowhere near.
export function bboxesNear(a: BoundingBox, b: BoundingBox, bufferDegrees: number): boolean {
  return (
    a.minLon - bufferDegrees <= b.maxLon &&
    a.maxLon + bufferDegrees >= b.minLon &&
    a.minLat - bufferDegrees <= b.maxLat &&
    a.maxLat + bufferDegrees >= b.minLat
  );
}

// True if `inner` sits entirely inside `outer`. Used as a bypass for the nearby-sea-zone
// distance check (see regions/routes.ts and build-region-pack.ts's nearbyZones): a small island
// inside a zone's bbox is in that sea even if the simplified polygon edge falls past the cutoff.
// Callers MUST also gate on the inner bbox being island-scale (SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES):
// a sea zone's bbox is a loose rectangle, so a large inland region can sit inside it by chance.
export function bboxContains(outer: BoundingBox, inner: BoundingBox): boolean {
  return (
    inner.minLon >= outer.minLon &&
    inner.maxLon <= outer.maxLon &&
    inner.minLat >= outer.minLat &&
    inner.maxLat <= outer.maxLat
  );
}

// Bbox diagonal in plain degrees (a proximity heuristic, like minRingDistance).
export function bboxDiagonalDegrees(bbox: BoundingBox): number {
  return Math.hypot(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat);
}

// ~1.5° (about 165km at the equator) covers genuine small islands while excluding
// county-scale regions and larger.
export const SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES = 1.5;

// Minimum distance between any point of any ring in A and any point of any ring in B, in plain
// Euclidean degrees (a proximity heuristic; the regions involved are never near the poles).
export function minRingDistance(ringsA: Point[][], ringsB: Point[][]): number {
  let min = Infinity;
  for (const a of ringsA) {
    for (const b of ringsB) {
      for (const [ax, ay] of a) {
        for (const [bx, by] of b) {
          const dist = Math.hypot(ax - bx, ay - by);
          // Stryker disable next-line EqualityOperator: equivalent, on a tie the distance stored is the same
          if (dist < min) min = dist;
        }
      }
    }
  }
  return min;
}

// Like minRingDistance, but also returns the closest point of ringsB, so callers can check
// whether a nearby coastline belongs to this country or a neighbour (see nearbyZones).
export function closestPointBetweenRings(ringsA: Point[][], ringsB: Point[][]): { distance: number; point: Point } {
  let min = Infinity;
  let closest: Point = ringsB[0]?.[0] ?? [0, 0];
  for (const a of ringsA) {
    for (const b of ringsB) {
      for (const [ax, ay] of a) {
        for (const bp of b) {
          const [bx, by] = bp;
          const dist = Math.hypot(ax - bx, ay - by);
          if (dist < min) {
            min = dist;
            closest = bp;
          }
        }
      }
    }
  }
  return { distance: min, point: closest };
}

// Ray-casting point-in-polygon test (even-odd rule), e.g. to check whether a record's
// coordinates fall on a country's landmass (see looksLikeInlandRecords).
export function pointInRing(point: Point, ring: Point[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    // Stryker disable next-line ConditionalExpression: equivalent, a horizontal edge also fails the range check on the next line
    if (yi === yj) continue;
    if (py < Math.min(yi, yj) || py >= Math.max(yi, yj)) continue;
    const xIntersect = xi + ((py - yi) / (yj - yi)) * (xj - xi);
    // Stryker disable next-line EqualityOperator: equivalent, a closed ring crosses the whole line an even number of times, so counting the crossings left of the point instead gives the same parity
    if (px < xIntersect) inside = !inside;
  }
  return inside;
}

export function pointInAnyRing(point: Point, rings: Point[][]): boolean {
  return rings.some((ring) => pointInRing(point, ring));
}

export function exteriorRingsFromGeometry(geometry: { type: string; coordinates: unknown }): Point[][] {
  if (geometry.type === "Polygon") return [(geometry.coordinates as Point[][])[0]];
  if (geometry.type === "MultiPolygon") return (geometry.coordinates as Point[][][]).map((poly) => poly[0]);
  return [];
}

// Turns a boundary into a GBIF-queryable WKT polygon (see gbifRegionParam's WKT branch in
// build-region-species.ts). Only the largest polygon's exterior ring is kept: holes and small
// parts don't matter for "roughly within this area" and would exceed GBIF's request-length limit.
const DEFAULT_MAX_WKT_POINTS = 80;

export function wktFromGeometry(
  geometry: { type: string; coordinates: unknown },
  maxPoints = DEFAULT_MAX_WKT_POINTS,
): string | null {
  const rings = exteriorRingsFromGeometry(geometry);
  if (rings.length === 0) return null;
  const largest = rings.reduce((a, b) => (b.length > a.length ? b : a));
  return ringToWktPolygon(ensureCounterClockwise(simplifyRingToMaxPoints(largest, maxPoints)));
}

// Merges several provinces' boundaries (a vernacular region) into one GBIF-queryable shape.
// Uses a convex hull of all members' points: a MULTIPOLYGON of independently simplified rings
// overlaps or gaps at shared borders, which GBIF rejects. The hull is always valid, at the
// cost of filling in concave gaps between members.
export function wktFromMergedGeometries(
  geometries: Array<{ type: string; coordinates: unknown }>,
  maxPoints = DEFAULT_MAX_WKT_POINTS,
): string | null {
  const allPoints = geometries.flatMap((g) => exteriorRingsFromGeometry(g).flat());
  if (allPoints.length === 0) return null;
  const hull = convexHull(allPoints);
  return ringToWktPolygon(ensureCounterClockwise(simplifyRingToMaxPoints(hull, maxPoints)));
}

// Parses the WKT `ringToWktPolygon` produces back into a point ring. sea_zones stores only the
// WKT, so this avoids persisting the ring twice.
export function parseWktPolygonRing(wkt: string): Point[] {
  const match = wkt.match(/^POLYGON\(\((.+)\)\)$/);
  if (!match) return [];
  return match[1].split(",").map((pair) => {
    const [x, y] = pair.trim().split(" ").map(Number);
    return [x, y] as Point;
  });
}
