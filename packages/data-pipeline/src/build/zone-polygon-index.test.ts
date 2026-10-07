// ZonePolygonIndex: which zones contain a point, against outlines with holes and several parts.
import { describe, expect, it } from "vitest";
import { ZonePolygonIndex } from "./zone-polygon-index.js";
import type { Point } from "@lifer/core/lib/geometry.js";

function box(minLon: number, minLat: number, maxLon: number, maxLat: number): Point[] {
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
}

// A wiggly coastline with many short edges across many bands, like a real sea's outline.
function wiggly(cx: number, cy: number, r: number, points: number): Point[] {
  const ring: Point[] = Array.from({ length: points }, (_, i) => {
    const a = (i / points) * 2 * Math.PI;
    const rr = r + 0.05 * Math.sin(a * 50);
    return [cx + rr * Math.cos(a), cy + rr * Math.sin(a)] as Point;
  });
  ring.push(ring[0]);
  return ring;
}

describe("ZonePolygonIndex.zonesContaining", () => {
  const index = new ZonePolygonIndex([
    // A sea with an island in it, and a second, separate part.
    { rings: [box(0, 0, 10, 10), box(4, 4, 6, 6), box(20, 0, 22, 2)] },
    // A neighbouring sea sharing the x = 10 edge.
    { rings: [box(10, 0, 15, 10)] },
    { rings: [wiggly(-60.5, -30.25, 3, 5000)] },
  ]);

  it("finds the zone a point is in, and none outside every zone", () => {
    expect(index.zonesContaining(2, 2)).toEqual([0]);
    expect(index.zonesContaining(12, 8)).toEqual([1]);
    expect(index.zonesContaining(30, 30)).toEqual([]);
  });

  it("leaves out a point on an island (a hole) and counts one in a second part", () => {
    expect(index.zonesContaining(5, 5)).toEqual([]);
    expect(index.zonesContaining(21, 1)).toEqual([0]);
  });

  it("agrees with a plain ray cast on a detailed outline, in negative coordinates", () => {
    const ring = wiggly(-60.5, -30.25, 3, 5000);
    const reference = (x: number, y: number) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    for (let k = 0; k < 2000; k++) {
      const x = -64 + ((k * 7919) % 1000) / 1000 * 7;
      const y = -34 + ((k * 104729) % 1000) / 1000 * 7.5;
      expect(index.zonesContaining(x, y).includes(2)).toBe(reference(x, y));
    }
  });
});
