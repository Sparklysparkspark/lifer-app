import { describe, expect, it } from "vitest";
import { inOutline, parseOutline, prefilterBoxes } from "./pinOutline.js";

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

describe("prefilterBoxes", () => {
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
