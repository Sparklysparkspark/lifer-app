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
  simplifyRingToMaxPointsRepaired,
  removeSelfIntersectionLoops,
  isSimpleRing,
  ringToWktPolygon,
  parseWktPolygonRing,
  minRingDistance,
  closestPointBetweenRings,
  wktFromGeometry,
  wktFromMergedGeometries,
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

  it("uses slanted edges' real position, not just their endpoints", () => {
    const triangle: Point[] = [
      [0, 0],
      [4, 0],
      [0, 4],
      [0, 0],
    ];
    // The slanted edge crosses y = 1 at x = 3.
    expect(pointInRing([2.9, 1], triangle)).toBe(true);
    expect(pointInRing([3.1, 1], triangle)).toBe(false);
    expect(pointInRing([0.5, 3.4], triangle)).toBe(true);
    expect(pointInRing([0.7, 3.4], triangle)).toBe(false);
  });

  it("ignores edges entirely above or below the point (a concave L shape)", () => {
    const lShape: Point[] = [
      [0, 0],
      [4, 0],
      [4, 1],
      [1, 1],
      [1, 4],
      [0, 4],
      [0, 0],
    ];
    expect(pointInRing([0.5, 0.5], lShape)).toBe(true);
    expect(pointInRing([2, 2], lShape)).toBe(false);
    expect(pointInRing([0.5, 3], lShape)).toBe(true);
  });

  it("counts a ray through a vertex once, so a point level with a corner is still inside", () => {
    const diamond: Point[] = [
      [0, -2],
      [2, 0],
      [0, 2],
      [-2, 0],
      [0, -2],
    ];
    expect(pointInRing([-1, 0], diamond)).toBe(true);
    expect(pointInRing([1.5, 0], diamond)).toBe(true);
    expect(pointInRing([3, 0], diamond)).toBe(false);
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
    expect(bboxDiagonalDegrees({ minLon: 10, minLat: -20, maxLon: 13, maxLat: -16 })).toBeCloseTo(5);
  });

  it("ringBoundingBox finds the extremes wherever they sit in the ring", () => {
    const ring: Point[] = [
      [0, 0],
      [-3, 1],
      [2, 5],
      [1, -4],
      [0, 0],
    ];
    expect(ringBoundingBox(ring)).toEqual({ minLon: -3, minLat: -4, maxLon: 2, maxLat: 5 });
  });

  // Each side separately: b to the east, west, north and south of the unit box.
  it.each([
    ["east", { minLon: 1.5, minLat: 0, maxLon: 2, maxLat: 1 }, { minLon: 1, minLat: 0, maxLon: 2, maxLat: 1 }],
    ["west", { minLon: -2, minLat: 0, maxLon: -0.5, maxLat: 1 }, { minLon: -2, minLat: 0, maxLon: 0, maxLat: 1 }],
    ["north", { minLon: 0, minLat: 1.5, maxLon: 1, maxLat: 2 }, { minLon: 0, minLat: 1, maxLon: 1, maxLat: 2 }],
    ["south", { minLon: 0, minLat: -2, maxLon: 1, maxLat: -0.5 }, { minLon: 0, minLat: -2, maxLon: 1, maxLat: 0 }],
  ])("bboxesNear checks the %s side: apart, bridged by the buffer, touching", (_side, apart, touching) => {
    expect(bboxesNear(UNIT_BOX, apart, 0)).toBe(false);
    expect(bboxesNear(UNIT_BOX, apart, 0.4)).toBe(false);
    expect(bboxesNear(UNIT_BOX, apart, 0.5)).toBe(true);
    expect(bboxesNear(UNIT_BOX, touching, 0)).toBe(true);
  });

  it("bboxContains counts a box equal to the outer one, and refuses one poking out of any side", () => {
    const outer = { minLon: -10, minLat: -10, maxLon: 10, maxLat: 10 };
    expect(bboxContains(outer, outer)).toBe(true);
    expect(bboxContains(outer, { ...outer, minLon: -11 })).toBe(false);
    expect(bboxContains(outer, { ...outer, maxLon: 11 })).toBe(false);
    expect(bboxContains(outer, { ...outer, minLat: -11 })).toBe(false);
    expect(bboxContains(outer, { ...outer, maxLat: 11 })).toBe(false);
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

  it("decides by the signed area for rings away from the origin", () => {
    const ccw: Point[] = [
      [1, 1],
      [3, 1],
      [2, 3],
      [1, 1],
    ];
    const cw: Point[] = [
      [1, 1],
      [2, 3],
      [3, 1],
      [1, 1],
    ];
    expect(ensureCounterClockwise(ccw)).toEqual(ccw);
    expect(ensureCounterClockwise(cw)).toEqual(ccw);
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

  it("keeps only the corners, whatever the input order, dropping points along the edges", () => {
    const points: Point[] = [
      [2, 2],
      [0, 0],
      [1, 0],
      [2, 0],
      [0, 2],
      [1, 1],
      [0, 1],
      [2, 1],
      [1, 2],
    ];
    expect(convexHull(points)).toEqual([
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
      [0, 0],
    ]);
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

  it("keeps the furthest point and recurses on both sides", () => {
    // A peak at (2, 0.5); the in-between points sit within 0.01 of the two sides.
    const peak: Point[] = [
      [0, 0],
      [1, 0.26],
      [2, 0.5],
      [3, 0.24],
      [4, 0],
    ];
    expect(simplifyRing(peak, 0.1)).toEqual([
      [0, 0],
      [2, 0.5],
      [4, 0],
    ]);
    // The same shape far from the origin gives the same answer.
    const shifted = peak.map(([x, y]) => [x + 100, y + 50] as Point);
    expect(simplifyRing(shifted, 0.1)).toEqual([
      [100, 50],
      [102, 50.5],
      [104, 50],
    ]);
  });

  it("drops a point exactly epsilon away, keeps one further", () => {
    const line: Point[] = [
      [0, 0],
      [1, 0],
      [2, 0.5],
      [3, 0],
      [4, 0],
    ];
    expect(simplifyRing(line, 0.5)).toEqual([
      [0, 0],
      [4, 0],
    ]);
    expect(simplifyRing(line, 0.49)).toEqual([
      [0, 0],
      [2, 0.5],
      [4, 0],
    ]);
  });

  it("measures from the start point on a closed ring, whose chord has no length", () => {
    const square: Point[] = [
      [10, 10],
      [12, 10],
      [12, 12],
      [10, 12],
      [10, 10],
    ];
    expect(simplifyRing(square, 0.1)).toEqual(square);
    // From (10, 10), (0, 0) is the furthest point; (11, 11) only looks further if the distance
    // were measured from the origin.
    const sliver: Point[] = [
      [10, 10],
      [11, 11],
      [0, 0],
      [10, 10],
    ];
    expect(simplifyRing(sliver, 5)).toEqual([
      [10, 10],
      [0, 0],
      [10, 10],
    ]);
  });

  it("returns three points or fewer unchanged", () => {
    const tiny: Point[] = [
      [0, 0],
      [5, 5],
      [0, 0],
    ];
    expect(simplifyRing(tiny, 100)).toEqual(tiny);
  });

  it("simplifyRingToMaxPoints leaves a ring already under the limit untouched", () => {
    // [5, 0] lies on the bottom edge: any simplification would drop it.
    const ring: Point[] = [
      [0, 0],
      [5, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    expect(simplifyRingToMaxPoints(ring, 6)).toEqual(ring);
  });

  it("simplifyRingToMaxPoints closes an open ring, and doesn't double-close a closed one", () => {
    // The last point shares the first one's x, so closing must compare both coordinates.
    const open: Point[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [0, 2],
    ];
    expect(simplifyRingToMaxPoints(open, 80)).toEqual([...open, [0, 0]]);
    const openSameY: Point[] = [
      [0, 0],
      [0, 2],
      [2, 2],
      [2, 0],
    ];
    expect(simplifyRingToMaxPoints(openSameY, 80)).toEqual([...openSameY, [0, 0]]);
    expect(simplifyRingToMaxPoints(SQUARE, 80)).toEqual(SQUARE);
  });

  it("simplifyRingToMaxPoints finds the corners of a densely and unevenly traced square", () => {
    const traced: Point[] = [];
    const corners: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    for (let c = 0; c < 4; c++) {
      const [a, b] = [corners[c], corners[c + 1]];
      // Every other point wobbles 0.01 off the edge, more than the first epsilon tried, so it has
      // to grow before the wobble goes.
      const wobble = (i: number) => (i % 2) * 0.01;
      for (let i = 0; i < 25; i++) {
        traced.push([a[0] + ((b[0] - a[0]) * i) / 25 + wobble(i), a[1] + ((b[1] - a[1]) * i) / 25 + wobble(i)]);
      }
    }
    traced.push([0, 0]);
    // Exactly five points fit a limit of five.
    expect(simplifyRingToMaxPoints(traced, 5)).toEqual(corners);
  });

  it("simplifyRingToMaxPoints decimates evenly, and closes the ring, when simplifying can't get under the limit", () => {
    // Coordinates so large that no epsilon it tries is big enough.
    const huge: Point[] = Array.from({ length: 100 }, (_, i) => {
      const angle = (i / 100) * 2 * Math.PI;
      return [Math.cos(angle) * 1e9, Math.sin(angle) * 1e9] as Point;
    });
    huge.push(huge[0]);
    const result = simplifyRingToMaxPoints(huge, 10);
    // Every 11th point (ceil(101 / 10)), then the first again to close it.
    const expected = [0, 11, 22, 33, 44, 55, 66, 77, 88, 99].map((i) => huge[i]);
    expect(result).toEqual([...expected, huge[0]]);
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

// The IHO sea areas' coastlines fold over themselves once simplified; the old hull fallback took
// in up to three times the sea's area in land.
describe("removeSelfIntersectionLoops / simplifyRingToMaxPointsRepaired", () => {
  // A 10x10 square whose closing stretch dips below its first edge, crossing it twice.
  const FOLDED: Point[] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [2, -2],
    [3, 1],
    [0, 0],
  ];

  it("cuts off the small lobe and keeps the large part, closed and simple", () => {
    expect(isSimpleRing(FOLDED)).toBe(false);
    const repaired = removeSelfIntersectionLoops(FOLDED);
    expect(isSimpleRing(repaired)).toBe(true);
    expect(repaired[0]).toEqual(repaired[repaired.length - 1]);
    expect(repaired).toContainEqual([10, 0]);
    expect(repaired).toContainEqual([10, 10]);
    expect(repaired).toContainEqual([0, 10]);
    expect(repaired).not.toContainEqual([2, -2]);
  });

  it("splits a ring that comes back to one of its own vertices, which GBIF rejects", () => {
    // A square with a small lobe pinched onto its corner at (10, 10).
    const pinched: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [12, 11],
      [11, 12],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    expect(isSimpleRing(pinched)).toBe(true);
    const repaired = simplifyRingToMaxPointsRepaired(pinched, 80);
    expect(repaired).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ]);
  });

  it("puts the cut exactly where the edges cross", () => {
    // The edge from (0, 10) to (2, -2) crosses y = 0 at x = 10/6.
    const x = 10 / 6;
    const repaired = removeSelfIntersectionLoops(FOLDED);
    expect(repaired).toHaveLength(5);
    expect(repaired[0][0]).toBeCloseTo(x);
    expect(repaired[0][1]).toBeCloseTo(0);
    expect(repaired.slice(1, 4)).toEqual([
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
    expect(repaired[4]).toEqual(repaired[0]);
  });

  it("cuts at the right place on slanted edges too (a sheared copy gives the sheared answer)", () => {
    const shear = ([px, py]: Point): Point => [px + 0.5 * py, 0.25 * px + py];
    const repaired = removeSelfIntersectionLoops(FOLDED.map(shear));
    const expected = [
      [10 / 6, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [10 / 6, 0],
    ].map((p) => shear(p as Point));
    expect(repaired).toHaveLength(expected.length);
    repaired.forEach(([px, py], i) => {
      expect(px).toBeCloseTo(expected[i][0]);
      expect(py).toBeCloseTo(expected[i][1]);
    });
  });

  it("repairs a crossing between a middle edge and the closing edge", () => {
    // The closing edge (4, 1) to (0, 0) crosses the edge x = 2 at (2, 0.5).
    const closingCross: Point[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [4, 1],
      [0, 0],
    ];
    expect(removeSelfIntersectionLoops(closingCross)).toEqual([
      [2, 0.5],
      [2, 2],
      [4, 1],
      [2, 0.5],
    ]);
  });

  it("drops a small fold in the middle of the ring, keeping the rest", () => {
    // The top edge is folded: (5, 12) to (6, 9) crosses it at x = 17/3.
    const ring: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [4, 10],
      [5, 12],
      [6, 9],
      [0, 10],
      [0, 0],
    ];
    const repaired = removeSelfIntersectionLoops(ring);
    expect(repaired.map(([px, py]) => [Number(px.toFixed(6)), py])).toEqual([
      [0, 0],
      [10, 0],
      [10, 10],
      [Number((17 / 3).toFixed(6)), 10],
      [6, 9],
      [0, 10],
      [0, 0],
    ]);
  });

  it("keeps a pinched-on lobe when it's the larger part", () => {
    const smallSquareBigLobe: Point[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [12, 2],
      [12, 12],
      [2, 12],
      [2, 2],
      [0, 2],
      [0, 0],
    ];
    expect(simplifyRingToMaxPointsRepaired(smallSquareBigLobe, 80)).toEqual([
      [2, 2],
      [12, 2],
      [12, 12],
      [2, 12],
      [2, 2],
    ]);
  });

  it("isSimpleRing sees a bowtie, and a crossing with the closing edge", () => {
    const bowtie: Point[] = [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
      [0, 0],
    ];
    expect(isSimpleRing(bowtie)).toBe(false);
    // Only the second edge and the closing edge cross.
    const closingCross: Point[] = [
      [0, 0],
      [2, 0],
      [2, 2],
      [4, 1],
      [0, 0],
    ];
    expect(isSimpleRing(closingCross)).toBe(false);
    expect(isSimpleRing(SQUARE)).toBe(true);
  });

  it("an empty ring stays empty instead of throwing", () => {
    expect(removeSelfIntersectionLoops([])).toEqual([]);
  });

  it("leaves a simple ring alone", () => {
    expect(removeSelfIntersectionLoops(SQUARE)).toEqual(SQUARE);
  });

  it("repairs instead of falling back to the convex hull", () => {
    // An L shape (concave) traced with a fold: the hull would fill in the notch.
    const lShapeFolded: Point[] = [
      [0, 0],
      [10, 0],
      [10, 2],
      [2, 2],
      [2, 10],
      [0, 10],
      [1, -1],
      [0.5, 0.5],
      [0, 0],
    ];
    expect(isSimpleRing(lShapeFolded)).toBe(false);
    expect(simplifyRingToMaxPoints(lShapeFolded, 80)).toEqual(convexHull(lShapeFolded));
    const repaired = simplifyRingToMaxPointsRepaired(lShapeFolded, 80);
    expect(isSimpleRing(repaired)).toBe(true);
    // The notch's inner corner survives, so the shape is still an L.
    expect(repaired).toContainEqual([2, 2]);
  });
});

describe("ringToWktPolygon / parseWktPolygonRing", () => {
  it("round-trips a ring through WKT", () => {
    const wkt = ringToWktPolygon(SQUARE);
    expect(wkt).toBe(
      "POLYGON((-1.00000 -1.00000,1.00000 -1.00000,1.00000 1.00000,-1.00000 1.00000,-1.00000 -1.00000))",
    );
    expect(parseWktPolygonRing(wkt)).toEqual(SQUARE);
  });

  it("parses WKT with spaces after the commas", () => {
    expect(parseWktPolygonRing("POLYGON((0 0, 1 0, 1 1, 0 0))")).toEqual([
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ]);
  });

  it("returns no ring for anything that isn't exactly one polygon", () => {
    expect(parseWktPolygonRing("MULTIPOLYGON(((0 0,1 0,1 1,0 0)))")).toEqual([]);
    expect(parseWktPolygonRing("SRID=4326;POLYGON((0 0,1 0,1 1,0 0))")).toEqual([]);
    expect(parseWktPolygonRing("POLYGON((0 0,1 0,1 1,0 0)) trailing")).toEqual([]);
  });
});

describe("minRingDistance / closestPointBetweenRings", () => {
  const a: Point[] = [
    [0, 1],
    [1, 1],
  ];
  const b: Point[] = [
    [10, 10],
    [4, 5],
    [7, 1],
  ];
  const far: Point[] = [[50, 50]];

  it("finds the smallest distance between any two points of the two sets", () => {
    expect(minRingDistance([a], [far, b])).toBeCloseTo(5);
  });

  it("returns that distance and the point of the second set it was measured to", () => {
    expect(closestPointBetweenRings([a], [far, b])).toEqual({ distance: 5, point: [4, 5] });
  });

  it("with nothing to measure to, reports an infinite distance instead of throwing", () => {
    expect(minRingDistance([a], [])).toBe(Infinity);
    expect(closestPointBetweenRings([a], [])).toEqual({ distance: Infinity, point: [0, 0] });
  });
});

describe("wktFromGeometry / wktFromMergedGeometries", () => {
  const small: Point[] = [
    [20, 20],
    [21, 20],
    [21, 21],
    [20, 20],
  ];
  const clockwiseSquare: Point[] = [...SQUARE].reverse();

  it("uses the polygon with the most points, made counter-clockwise", () => {
    const wkt = wktFromGeometry({ type: "MultiPolygon", coordinates: [[small], [clockwiseSquare], [small]] });
    expect(wkt).toBe(ringToWktPolygon(SQUARE));
  });

  it("is null for a geometry with no polygon", () => {
    expect(wktFromGeometry({ type: "Point", coordinates: [0, 0] })).toBeNull();
    expect(wktFromMergedGeometries([{ type: "LineString", coordinates: [] }])).toBeNull();
    expect(wktFromMergedGeometries([])).toBeNull();
  });

  it("merges several boundaries into the hull around all of them", () => {
    const left: Point[] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ];
    const right: Point[] = [
      [3, 0],
      [4, 0],
      [4, 1],
      [3, 1],
      [3, 0],
    ];
    expect(
      wktFromMergedGeometries([
        { type: "Polygon", coordinates: [left] },
        { type: "MultiPolygon", coordinates: [[right]] },
      ]),
    ).toBe("POLYGON((0.00000 0.00000,4.00000 0.00000,4.00000 1.00000,0.00000 1.00000,0.00000 0.00000))");
  });
});
