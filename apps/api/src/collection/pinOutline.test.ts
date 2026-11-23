import { describe, expect, it } from "vitest";
import { NEAR_KM, inOutline, nearOutline, parseOutline, prefilterBoxes } from "./pinOutline.js";

type Ring = Array<[number, number]>;
const square = (w: number, s: number, e: number, n: number): Ring => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
];
const feature = (geometry: unknown) => ({ type: "Feature", geometry });

describe("parseOutline", () => {
  it("reads a Feature or a bare geometry, and nothing else", () => {
    expect(parseOutline(feature({ type: "Polygon", coordinates: [square(0, 0, 1, 1)] }))).toHaveLength(1);
    expect(
      parseOutline({ type: "MultiPolygon", coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] }),
    ).toHaveLength(2);
    expect(parseOutline(null)).toBeNull();
    expect(parseOutline(feature({ type: "Point", coordinates: [0, 0] }))).toBeNull();
  });
});

describe("inOutline", () => {
  it("keeps points inside a polygon and drops those outside", () => {
    const o = parseOutline(feature({ type: "Polygon", coordinates: [square(10, 40, 20, 50)] }))!;
    expect(inOutline(o, 15, 45)).toBe(true);
    expect(inOutline(o, 25, 45)).toBe(false);
  });

  it("leaves out a polygon's holes (a lake, an enclave)", () => {
    const o = parseOutline({ type: "Polygon", coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] })!;
    expect(inOutline(o, 5, 5)).toBe(false);
    expect(inOutline(o, 2, 2)).toBe(true);
  });

  it("finds a point on any island of a group", () => {
    const o = parseOutline({ type: "MultiPolygon", coordinates: [[square(0, 0, 1, 1)], [square(5, 5, 6, 6)]] })!;
    expect(inOutline(o, 5.5, 5.5)).toBe(true);
    expect(inOutline(o, 3, 3)).toBe(false);
  });

  it("holds across the antimeridian, split at 180 or drawn past it", () => {
    const split = parseOutline({
      type: "MultiPolygon",
      coordinates: [[square(177, -19, 180, -16)], [square(-180, -19, -178, -16)]],
    })!;
    expect(inOutline(split, -179, -17)).toBe(true);
    expect(inOutline(split, 178, -17)).toBe(true);
    const past = parseOutline({ type: "Polygon", coordinates: [square(177, -19, 182, -16)] })!;
    expect(inOutline(past, -179, -17)).toBe(true);
    expect(inOutline(past, 170, -17)).toBe(false);
  });
});

// Degrees of latitude for a distance in km: along a meridian, km and degrees match exactly.
const deg = (km: number) => km / ((6371.0088 * Math.PI) / 180);

describe("nearOutline", () => {
  // South edge on the equator, east edge on a meridian: both great circles, so offsets are exact.
  const box = parseOutline({ type: "Polygon", coordinates: [square(10, 0, 11, 1)] })!;

  it("is 22 km", () => expect(NEAR_KM).toBe(22));

  it("keeps a point inside", () => expect(nearOutline(box, 10.5, 0.5)).toBe(true));

  it("keeps a point 5 km and 21.9 km offshore, not 22.1 km", () => {
    expect(nearOutline(box, 10.5, -deg(5))).toBe(true);
    expect(nearOutline(box, 10.5, -deg(21.9))).toBe(true);
    expect(nearOutline(box, 10.5, -deg(22.1))).toBe(false);
  });

  it("measures to the corner past both edges, not to the edges' lines", () => {
    // 0.1 degrees out each way is 15.7 km from the corner; 0.15 is 23.6 km, though only 16.7 from each line.
    expect(nearOutline(box, 11.1, -0.1)).toBe(true);
    expect(nearOutline(box, 11.15, -0.15)).toBe(false);
  });

  it("measures to the nearest island of a group", () => {
    const o = parseOutline({
      type: "MultiPolygon",
      coordinates: [[square(0, 0, 1, 1)], [square(5, 0, 5.1, 0.1)]],
    })!;
    expect(nearOutline(o, 5.05, -deg(10))).toBe(true);
    expect(nearOutline(o, 3, 0.5)).toBe(false);
  });

  it("counts a point in a hole only near the hole's shore", () => {
    const o = parseOutline({ type: "Polygon", coordinates: [square(0, 0, 10, 10), square(4, 4, 6, 6)] })!;
    expect(nearOutline(o, 5, 5)).toBe(false);
    expect(nearOutline(o, 4.1, 5)).toBe(true);
  });

  it("holds across the antimeridian, split at 180 or drawn past it", () => {
    // At 17 S, 0.1 degrees of longitude is 10.6 km, 0.3 is 31.9 km.
    const split = parseOutline({
      type: "MultiPolygon",
      coordinates: [[square(177, -19, 180, -16)], [square(-180, -19, -178, -16)]],
    })!;
    expect(nearOutline(split, -177.9, -17)).toBe(true);
    expect(nearOutline(split, -177.7, -17)).toBe(false);
    expect(nearOutline(split, 176.9, -17)).toBe(true);
    const past = parseOutline({ type: "Polygon", coordinates: [square(177, -19, 182, -16)] })!;
    expect(nearOutline(past, -177.9, -17)).toBe(true);
    expect(nearOutline(past, -177.7, -17)).toBe(false);
  });

  it("measures to a polar seam drawn along a parallel", () => {
    const pole = parseOutline({ type: "Polygon", coordinates: [square(-180, -90, 180, -60)] })!;
    expect(nearOutline(pole, 0, -90)).toBe(true);
    expect(nearOutline(pole, 0, -60 + deg(10))).toBe(true);
    expect(nearOutline(pole, 0, -60 + deg(30))).toBe(false);
  });
});

describe("prefilterBoxes", () => {
  it("grows by km, longitude scaled by latitude, and spans the world near a pole", () => {
    const [b] = prefilterBoxes(parseOutline({ type: "Polygon", coordinates: [square(10, 0, 11, 60)] })!, 22);
    expect(b.s).toBeCloseTo(-deg(22), 6);
    expect(b.n).toBeCloseTo(60 + deg(22), 6);
    expect(b.e - 11).toBeGreaterThan(deg(22) * 2);
    const pole = parseOutline({ type: "Polygon", coordinates: [square(0, 85, 10, 88.9)] })!;
    expect(prefilterBoxes(pole, 22)).toEqual([{ w: -180, s: 85 - deg(22), e: 180, n: 88.9 + deg(22) }]);
  });

  it("splits a grown box that reaches past 180", () => {
    const o = parseOutline({ type: "Polygon", coordinates: [square(170, 0, 179.9, 1)] })!;
    const boxes = prefilterBoxes(o, 22);
    expect(boxes).toHaveLength(2);
    expect(boxes[1].w).toBe(-180);
    expect(boxes[1].e).toBeGreaterThan(-180);
  });

  it("is the outline's box for an ordinary region", () => {
    const o = parseOutline({
      type: "MultiPolygon",
      coordinates: [[square(10, 40, 12, 42)], [square(15, 45, 20, 50)]],
    })!;
    expect(prefilterBoxes(o)).toEqual([{ w: 10, s: 40, e: 20, n: 50 }]);
  });

  it("splits in two across the antimeridian instead of spanning the world", () => {
    const fiji = parseOutline({
      type: "MultiPolygon",
      coordinates: [[square(177, -19, 180, -16)], [square(-180, -19, -178, -16)]],
    })!;
    expect(prefilterBoxes(fiji)).toEqual([
      { w: 177, s: -19, e: 180, n: -16 },
      { w: -180, s: -19, e: -178, n: -16 },
    ]);
    const past = parseOutline({ type: "Polygon", coordinates: [square(177, -19, 182, -16)] })!;
    expect(prefilterBoxes(past)).toEqual([
      { w: 177, s: -19, e: 180, n: -16 },
      { w: -180, s: -19, e: -178, n: -16 },
    ]);
  });

  it("keeps one box for a region that only reaches across 0", () => {
    const o = parseOutline({ type: "Polygon", coordinates: [square(-5, 50, 5, 55)] })!;
    expect(prefilterBoxes(o)).toEqual([{ w: -5, s: 50, e: 5, n: 55 }]);
  });
});
