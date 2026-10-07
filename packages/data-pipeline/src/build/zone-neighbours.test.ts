// zoneNeighbours: zones sharing a boundary are neighbours, zones on different coasts aren't.
import { describe, expect, it } from "vitest";
import type { Point } from "@lifer/core/lib/geometry.js";
import { zoneNeighbours } from "./zone-neighbours.js";

const square = (x0: number, y0: number, size: number): Point[] => [
  [x0, y0],
  [x0 + size, y0],
  [x0 + size, y0 + size],
  [x0, y0 + size],
  [x0, y0],
];

describe("zoneNeighbours", () => {
  it("links zones that share an edge and not zones far apart", () => {
    const zones = [[square(0, 0, 2)], [square(2, 0, 2)], [square(40, 40, 2)]];
    const n = zoneNeighbours(zones);
    expect([...n.get(0)!]).toEqual([1]);
    expect([...n.get(1)!]).toEqual([0]);
    expect(n.get(2)!.size).toBe(0);
  });

  it("links zones across the antimeridian", () => {
    const zones = [[square(178, 0, 1.9)], [square(-180, 0, 1)]];
    const n = zoneNeighbours(zones);
    expect(n.get(0)!.has(1)).toBe(true);
  });

  it("never lists a zone as its own neighbour", () => {
    const n = zoneNeighbours([[square(0, 0, 5), square(10, 10, 1)]]);
    expect(n.get(0)!.size).toBe(0);
  });
});
