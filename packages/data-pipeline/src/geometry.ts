// Small, dependency-free geometry helpers — this project hand-rolls its own parsers
// everywhere else (CSV, WKT-adjacent formats) rather than pulling in a library for a single
// use, and a full geometry package (turf, etc.) would be a lot of surface area for the one
// thing needed here: simplifying a polygon ring down under GBIF's vertex limit and building
// valid WKT from it.

export type Point = [number, number];

// Ramer-Douglas-Peucker line simplification — a standard, well-known algorithm (not
// invented here): repeatedly find the point in a segment furthest from the line between its
// endpoints; keep it (and recurse both halves) if it's farther than `epsilon`, otherwise
// drop everything between the endpoints.
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
    if (pts.length <= 2) return pts;
    let maxDist = -1;
    let maxIdx = -1;
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

// Whether two segments [a,b] and [c,d] cross — standard orientation-based test, used only
// by isSimpleRing below.
function segmentsIntersect(a: Point, b: Point, c: Point, d: Point): boolean {
  const orient = (p: Point, q: Point, r: Point) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

// A simplified ring can come out self-intersecting — Ramer-Douglas-Peucker (or the
// even-decimation fallback) has no topological guarantee, and the Gulf of Mexico's
// highly concave coastline produces exactly this after simplification, which then
// gets rejected by GBIF outright ("Invalid shape in WKT"). O(n²) segment-pair check is cheap at
// the point counts involved here (≤170).
export function isSimpleRing(ring: Point[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n - 1; i++) {
    for (let j = i + 1; j < n - 1; j++) {
      if (j === i + 1 || (i === 0 && j === n - 2)) continue; // adjacent edges share an endpoint, not a crossing
      if (segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return false;
    }
  }
  return true;
}

// Andrew's monotone chain — a standard, well-known algorithm (not invented here). Always
// produces a valid (convex, hence simple) polygon, used as the last-resort fallback when a
// simplified ring comes out self-intersecting: a much coarser approximation of the real
// coastline, but guaranteed to be a shape GBIF will actually accept.
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

// Simplifies a closed ring down to at most `maxPoints` vertices (GBIF's occurrence/search
// `geometry` WKT param rejects polygons above ~170 total coordinate entries per ring —
// verified by binary search against GBIF's API, not documented anywhere findable, so this is deliberately
// conservative). Increases epsilon in a simple loop rather than solving for it directly —
// there's no closed-form epsilon-to-point-count relationship for RDP. Falls back to a convex
// hull (see above) if simplification produces a self-intersecting ring — a coarser shape,
// but a valid one, rather than a request GBIF will outright reject.
export function simplifyRingToMaxPoints(points: Point[], maxPoints: number): Point[] {
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
      // Fallback: if RDP still hasn't converged (pathological input), decimate evenly — a
      // worse approximation of the shape but guaranteed to fit GBIF's point-count limit.
      // Filtering by stride can drop the ring's closing point (index 0 duplicated at the
      // end) if that index isn't a multiple of the stride, leaving an open ring — GBIF's WKT
      // parser rejects that outright (confirmed live: a Brazilian state's complex boundary
      // hit exactly this path and came back a 400). closeRing below is the general fix.
      const stride = Math.ceil(points.length / maxPoints);
      simplified = points.filter((_, i) => i % stride === 0);
    }
  }
  simplified = closeRing(simplified);
  return isSimpleRing(simplified) ? simplified : convexHull(points);
}

// A valid WKT/GeoJSON ring's first and last points must be identical. Most paths above
// already preserve this (RDP keeps both endpoints of the polyline it's simplifying; convexHull
// explicitly closes itself), but this is cheap insurance against any path — present or future —
// that doesn't, rather than relying on every caller getting it right independently.
function closeRing(ring: Point[]): Point[] {
  if (ring.length === 0) return ring;
  const [firstX, firstY] = ring[0];
  const [lastX, lastY] = ring[ring.length - 1];
  return firstX === lastX && firstY === lastY ? ring : [...ring, ring[0]];
}

// GBIF requires a counter-clockwise exterior ring — a clockwise ring is rejected outright —
// the standard GeoJSON/RFC 7946 winding is also CCW for exteriors, but
// Natural Earth's own files don't reliably follow it, so this is checked and fixed per-ring
// rather than assumed.
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

// MEOW's raw shapefile coordinates carry full double-precision decimals (e.g.
// -79.98845196724204, 14 significant digits) versus the old Natural-Earth zones'
// already-rounded ones. At the same 80-point cap, that alone pushed the total request URL
// (WKT + all 52 fish taxonKeys + basisOfRecord params) from ~2,500 characters past the
// ~3,840-3,905 character wall documented in fetch-marine-zones.ts, causing MEOW ecoregion
// zones like "Virginian" to fail GBIF's occurrence search with a 400. 5 decimal places is
// ~1.1m of real-world precision — vastly more than "is this region near this sea zone"
// needs — and cuts each coordinate's length roughly in half.
const WKT_COORDINATE_PRECISION = 5;

export function ringToWktPolygon(ring: Point[]): string {
  const coords = ring.map(([x, y]) => `${x.toFixed(WKT_COORDINATE_PRECISION)} ${y.toFixed(WKT_COORDINATE_PRECISION)}`).join(",");
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
    if (x < minLon) minLon = x;
    if (x > maxLon) maxLon = x;
    if (y < minLat) minLat = y;
    if (y > maxLat) maxLat = y;
  }
  return { minLon, minLat, maxLon, maxLat };
}

// Bounding-box proximity with a large degree buffer — deliberately loose, used ONLY as a
// cheap first-pass shortlist before the real point-distance check below, never as the final
// "is this actually nearby" answer. A bbox alone isn't good enough because a large,
// irregularly-shaped sea's bounding box can span a huge area relative to its real
// shape — the Mediterranean's sub-basins (Ionian Sea, Aegean Sea) have bboxes that
// spuriously "overlap" Egypt's even though the real coastlines are 500+ km apart.
export function bboxesNear(a: BoundingBox, b: BoundingBox, bufferDegrees: number): boolean {
  return (
    a.minLon - bufferDegrees <= b.maxLon &&
    a.maxLon + bufferDegrees >= b.minLon &&
    a.minLat - bufferDegrees <= b.maxLat &&
    a.maxLat + bufferDegrees >= b.minLat
  );
}

// True if `inner` sits entirely inside `outer` — used as a bypass for the nearby-sea-zone
// ring-distance check (see regions/routes.ts and build-region-pack.ts's nearbyZones): a small
// island whose own bbox is fully contained in a sea zone's bbox is unambiguously "in that
// sea," even in the rare case where the zone's simplified polygon edge sits just past the
// ring-distance cutoff (found via Antigua and Barb. vs. the Eastern Caribbean zone).
//
// This is a plain geometric containment check with no size opinion of its own — callers using
// it as that "small island" bypass MUST additionally gate on the inner bbox actually being
// island-scale (see bboxDiagonalDegrees + SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES below).
// Without that gate, this backfires for a LARGE landlocked region: a sea zone's bbox is often
// a loose rectangle spanning its entire basin (gulfs, sub-seas and all), so a big inland
// governorate's bbox can trivially sit "inside" it by sheer coincidence of rectangle geometry
// despite being nowhere near real water — found via Aswan (Egypt), whose bbox landed
// entirely inside the Red Sea zone's bbox despite being ~200km from the actual coast.
export function bboxContains(outer: BoundingBox, inner: BoundingBox): boolean {
  return inner.minLon >= outer.minLon && inner.maxLon <= outer.maxLon && inner.minLat >= outer.minLat && inner.maxLat <= outer.maxLat;
}

// Diagonal size of a bbox in plain degrees (same Euclidean-not-haversine tradeoff as
// minRingDistance below — a proximity heuristic, not a navigational distance).
export function bboxDiagonalDegrees(bbox: BoundingBox): number {
  return Math.hypot(bbox.maxLon - bbox.minLon, bbox.maxLat - bbox.minLat);
}

// ~1.5° (roughly 165km at the equator) comfortably covers genuine small-island cases (Antigua
// and Barbuda's combined bbox is well under 1°) while excluding anything governorate/county
// scale or larger, which is exactly the size class the bboxContains bypass above was never
// meant to cover.
export const SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES = 1.5;

// Minimum distance (plain Euclidean degrees, not haversine — this is a proximity heuristic
// for surfacing checkbox options, not a navigational distance, and the regions involved are
// never near enough to a pole for the difference to matter) between any point of any ring in
// A and any point of any ring in B. This correctly separates Egypt's real
// neighbors (Mediterranean/Red Sea/Gulf of Suez/Gulf of Aqaba, all 0-1km away) from the
// bbox-only false positives above (Ionian 612km, Aegean 545km, Sea of Crete 389km).
export function minRingDistance(ringsA: Point[][], ringsB: Point[][]): number {
  let min = Infinity;
  for (const a of ringsA) {
    for (const b of ringsB) {
      for (const [ax, ay] of a) {
        for (const [bx, by] of b) {
          const dist = Math.hypot(ax - bx, ay - by);
          if (dist < min) min = dist;
        }
      }
    }
  }
  return min;
}

// Standard ray-casting point-in-polygon test (even-odd rule) — a genuine gap this file didn't
// have: minRingDistance/bboxContains answer "how close are two shapes," not "is this exact
// point inside this one shape," which is what's needed to sanity-check an occurrence record's
// own coordinates against a country's real landmass (see looksLikeInlandRecords's own
// comment — a "marine" observation that resolves 150+ miles inland at a desert oasis is
// wrong regardless of which sea zone's polygon happened to also (incorrectly) claim it).
export function pointInRing(point: Point, ring: Point[]): boolean {
  const [px, py] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi === yj) continue;
    if (py < Math.min(yi, yj) || py >= Math.max(yi, yj)) continue;
    const xIntersect = xi + ((py - yi) / (yj - yi)) * (xj - xi);
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

// Same simplification fetch-marine-zones.ts uses for sea zones (only the largest ring, capped
// point count, forced winding direction) — reused here so a province's own boundary can be
// turned into a GBIF-queryable WKT polygon (see gbifRegionParam's WKT branch in
// build-region-species.ts) whenever it has no usable GADM gid. Only the exterior ring of the
// largest polygon is kept: holes and a MultiPolygon's smaller disconnected parts don't matter
// for "is a species found roughly within this area," and keeping them would blow past GBIF's
// request-length limit for no real accuracy gain.
const DEFAULT_MAX_WKT_POINTS = 80;

export function wktFromGeometry(geometry: { type: string; coordinates: unknown }, maxPoints = DEFAULT_MAX_WKT_POINTS): string | null {
  const rings = exteriorRingsFromGeometry(geometry);
  if (rings.length === 0) return null;
  const largest = rings.reduce((a, b) => (b.length > a.length ? b : a));
  return ringToWktPolygon(ensureCounterClockwise(simplifyRingToMaxPoints(largest, maxPoints)));
}

// A vernacular region (see ~/.claude/plans/inaturalist-sync.md's sibling plan for province
// grouping) merges several provinces' own boundaries into one GBIF-queryable shape — e.g.
// Thailand's 6 regions each combining a dozen-plus provinces. The first version of this
// function built a MULTIPOLYGON out of each member's independently-simplified ring, which GBIF
// rejected with a 400 across essentially every group tried (confirmed live, systematically):
// simplifying each member's boundary on its own, with no constraint that adjacent members'
// simplified edges still line up, easily produces two neighboring provinces' shapes that
// slightly overlap or gap at their shared border — an invalid MultiPolygon by the OGC/JTS rules
// GBIF's geometry parser enforces. A convex hull over every member's combined points sidesteps
// the problem entirely: a hull can never self-intersect or have a topology conflict between
// parts, so it's always a valid single POLYGON, at the cost of a coarser shape (it fills in the
// concave "bites" between member provinces, and for a country whose regions are contiguous
// blocks — the normal case here — that's a fairly small over-approximation, not a wild one).
export function wktFromMergedGeometries(
  geometries: Array<{ type: string; coordinates: unknown }>,
  maxPoints = DEFAULT_MAX_WKT_POINTS,
): string | null {
  const allPoints = geometries.flatMap((g) => exteriorRingsFromGeometry(g).flat());
  if (allPoints.length === 0) return null;
  const hull = convexHull(allPoints);
  return ringToWktPolygon(ensureCounterClockwise(simplifyRingToMaxPoints(hull, maxPoints)));
}

// Parses back the exact WKT shape `ringToWktPolygon` produces ("POLYGON((x y,x y,...))") —
// sea_zones stores only the WKT (what GBIF needs), so this recovers the point ring for the
// distance check above without persisting the same data twice.
export function parseWktPolygonRing(wkt: string): Point[] {
  const match = wkt.match(/^POLYGON\(\((.+)\)\)$/);
  if (!match) return [];
  return match[1].split(",").map((pair) => {
    const [x, y] = pair.trim().split(" ").map(Number);
    return [x, y] as Point;
  });
}
