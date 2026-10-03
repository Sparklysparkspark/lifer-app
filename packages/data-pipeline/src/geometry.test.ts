// Coverage for geometry.ts's point-in-polygon primitives, plus a contract: exteriorRingsFromGeometry
// returns zero rings (rather than throwing) for a GeoJSON Feature wrapper, so callers must
// unwrap `.geometry` themselves.
import { describe, expect, it } from "vitest";
import {
  pointInRing,
  pointInAnyRing,
  exteriorRingsFromGeometry,
  ringBoundingBox,
  bboxesNear,
  bboxContains,
  bboxDiagonalDegrees,
  ensureCounterClockwise,
  convexHull,
  simplifyRing,
  simplifyRingToMaxPoints,
  isSimpleRing,
  ringToWktPolygon,
  parseWktPolygonRing,
  type Point,
} from "./geometry.js";

// A simple square, [lon, lat] winding CCW, centered on the origin.
const SQUARE: Point[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
  [-1, -1],
];

describe("pointInRing / pointInAnyRing", () => {
  it("is true for a point inside the ring", () => {
    expect(pointInRing([0, 0], SQUARE)).toBe(true);
  });

  it("is false for a point outside the ring", () => {
    expect(pointInRing([5, 5], SQUARE)).toBe(false);
  });

  // Boundary-value cases: the even-odd implementation has no special handling for points exactly
  // on the boundary, so these pin down its actual behaviour.
  it("a point exactly ON an edge is NOT considered inside (matches this implementation's even-odd behavior)", () => {
    expect(pointInRing([1, 0], SQUARE)).toBe(false);
  });

  it("a point exactly ON a vertex is NOT considered inside", () => {
    expect(pointInRing([1, 1], SQUARE)).toBe(false);
  });

  it("a point just inside the edge (within floating-point epsilon) IS inside", () => {
    expect(pointInRing([0.999, 0], SQUARE)).toBe(true);
  });

  it("a point just outside the edge is NOT inside", () => {
    expect(pointInRing([1.001, 0], SQUARE)).toBe(false);
  });

  it("pointInAnyRing is true if any one of several rings contains the point (a MultiPolygon's disjoint parts)", () => {
    const farAwaySquare: Point[] = [
      [10, 10],
      [12, 10],
      [12, 12],
      [10, 12],
      [10, 10],
    ];
    expect(pointInAnyRing([0, 0], [farAwaySquare, SQUARE])).toBe(true);
    expect(pointInAnyRing([100, 100], [farAwaySquare, SQUARE])).toBe(false);
  });
});

describe("exteriorRingsFromGeometry", () => {
  it("extracts the single ring from a Polygon", () => {
    const rings = exteriorRingsFromGeometry({ type: "Polygon", coordinates: [SQUARE] });
    expect(rings).toEqual([SQUARE]);
  });

  it("extracts each part's exterior ring from a MultiPolygon", () => {
    const other: Point[] = [
      [5, 5],
      [6, 5],
      [6, 6],
      [5, 6],
      [5, 5],
    ];
    const rings = exteriorRingsFromGeometry({ type: "MultiPolygon", coordinates: [[SQUARE], [other]] });
    expect(rings).toEqual([SQUARE, other]);
  });

  it("returns an empty array for an unrecognized geometry type, rather than throwing", () => {
    // A GeoJSON Feature's `.type` is "Feature", never "Polygon"/"MultiPolygon", so callers MUST
    // unwrap `.geometry` first. This makes the empty-array (not throw) behaviour explicit.
    const featureWrapper = { type: "Feature", coordinates: undefined };
    expect(exteriorRingsFromGeometry(featureWrapper as never)).toEqual([]);
  });

  it("correctly extracts rings once a Feature wrapper is unwrapped to its .geometry", () => {
    const feature = { type: "Feature", geometry: { type: "Polygon", coordinates: [SQUARE] } };
    const rings = exteriorRingsFromGeometry(feature.geometry);
    expect(rings).toEqual([SQUARE]);
  });
});

const UNIT_BOX = { minLon: 0, minLat: 0, maxLon: 1, maxLat: 1 };

describe("ringBoundingBox / bboxesNear / bboxContains", () => {
  it("computes the min/max lon/lat of a ring", () => {
    expect(ringBoundingBox(SQUARE)).toEqual({ minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 });
  });

  it("bboxesNear is true for overlapping boxes and false for far-apart ones", () => {
    const a = UNIT_BOX;
    const b = { minLon: 0.5, minLat: 0.5, maxLon: 1.5, maxLat: 1.5 };
    const farB = { minLon: 100, minLat: 100, maxLon: 101, maxLat: 101 };
    expect(bboxesNear(a, b, 0)).toBe(true);
    expect(bboxesNear(a, farB, 0)).toBe(false);
    // A buffer can bridge two boxes that don't quite touch.
    const adjacent = { minLon: 1.1, minLat: 0, maxLon: 2, maxLat: 1 };
    expect(bboxesNear(a, adjacent, 0)).toBe(false);
    expect(bboxesNear(a, adjacent, 0.2)).toBe(true);
  });

  it("boundary values: two boxes sharing exactly one edge count as near, even with zero buffer", () => {
    const touchingExactly = { minLon: 1, minLat: 0, maxLon: 2, maxLat: 1 };
    expect(bboxesNear(UNIT_BOX, touchingExactly, 0)).toBe(true);
  });

  it("boundary values: a box just past exact-touching does not count with zero buffer", () => {
    const justPastTouch = { minLon: 1.0001, minLat: 0, maxLon: 2, maxLat: 1 };
    expect(bboxesNear(UNIT_BOX, justPastTouch, 0)).toBe(false);
  });

  it("bboxContains is true only when inner sits fully inside outer", () => {
    const outer = { minLon: -10, minLat: -10, maxLon: 10, maxLat: 10 };
    const inside = { minLon: -1, minLat: -1, maxLon: 1, maxLat: 1 };
    const straddling = { minLon: -1, minLat: -1, maxLon: 20, maxLat: 1 };
    expect(bboxContains(outer, inside)).toBe(true);
    expect(bboxContains(outer, straddling)).toBe(false);
  });

  it("bboxDiagonalDegrees computes the Euclidean diagonal", () => {
    expect(bboxDiagonalDegrees({ minLon: 0, minLat: 0, maxLon: 3, maxLat: 4 })).toBeCloseTo(5);
  });
});

describe("ensureCounterClockwise", () => {
  it("leaves an already-CCW ring unchanged", () => {
    expect(ensureCounterClockwise(SQUARE)).toEqual(SQUARE);
  });

  it("reverses a clockwise ring", () => {
    const clockwise = [...SQUARE].reverse();
    expect(ensureCounterClockwise(clockwise)).toEqual(SQUARE);
  });
});

describe("convexHull", () => {
  it("produces a hull containing every input point (a simple, valid polygon)", () => {
    const points: Point[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [1, 1], // interior point: should NOT appear as its own hull vertex
    ];
    const hull = convexHull(points);
    expect(isSimpleRing(hull)).toBe(true);
    // First and last point close the ring.
    expect(hull[0]).toEqual(hull[hull.length - 1]);
    for (const p of points) expect(pointInRing(p, hull) || hull.some((h) => h[0] === p[0] && h[1] === p[1])).toBe(true);
  });
});

describe("simplifyRing / simplifyRingToMaxPoints", () => {
  it("drops a point that lies almost exactly on the line between its neighbors", () => {
    // simplifyRing returns rings of 3 points or fewer unchanged, so this uses 5 points: two corners
    // (0,0) and (4,0.001) with two near-collinear points between them that should disappear.
    const almostStraight: Point[] = [
      [0, 0],
      [1, 0.0001],
      [2, 0.0001],
      [3, 0.0001],
      [4, 0.001],
    ];
    expect(simplifyRing(almostStraight, 0.01)).toEqual([
      [0, 0],
      [4, 0.001],
    ]);
  });


  it("simplifyRingToMaxPoints caps the point count and keeps a closed, simple ring", () => {
    // A rough circle with many points, a realistic stand-in for a complex coastline.
    const circle: Point[] = Array.from({ length: 200 }, (_, i) => {
      const angle = (i / 200) * 2 * Math.PI;
      return [Math.cos(angle), Math.sin(angle)] as Point;
    });
    circle.push(circle[0]);
    const simplified = simplifyRingToMaxPoints(circle, 80);
    expect(simplified.length).toBeLessThanOrEqual(80);
    expect(simplified[0]).toEqual(simplified[simplified.length - 1]);
    expect(isSimpleRing(simplified)).toBe(true);
  });
});

describe("ringToWktPolygon / parseWktPolygonRing", () => {
  it("round-trips a ring through WKT", () => {
    const wkt = ringToWktPolygon(SQUARE);
    expect(wkt).toBe("POLYGON((-1.00000 -1.00000,1.00000 -1.00000,1.00000 1.00000,-1.00000 1.00000,-1.00000 -1.00000))");
    expect(parseWktPolygonRing(wkt)).toEqual(SQUARE);
  });
});
