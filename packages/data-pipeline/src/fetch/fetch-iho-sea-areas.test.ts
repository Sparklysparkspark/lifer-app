// seaZonesFromFeatures on hand-made features shaped like the IHO layer's: the ones that need
// special handling are the open oceans, the circumpolar ones, and the Pacific's split pieces.
import { describe, expect, it } from "vitest";
import { seaZonesFromFeatures, type IhoFeature } from "./fetch-iho-sea-areas.js";
import { parseWktPolygonRing, isSimpleRing, type Point } from "@lifer/core/lib/geometry.js";

function box(minLon: number, minLat: number, maxLon: number, maxLat: number, clockwise = false): Point[] {
  const ring: Point[] = [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
  return clockwise ? ring.reverse() : ring;
}

function feature(name: string, rings: Point[][]): IhoFeature {
  return { properties: { name }, geometry: { type: "MultiPolygon", coordinates: rings.map((r) => [r]) } };
}

// A wiggly coastline of many points, to exercise simplification.
function detailedRing(points: number): Point[] {
  const ring: Point[] = Array.from({ length: points }, (_, i) => {
    const a = (i / points) * 2 * Math.PI;
    const r = 5 + 0.3 * Math.sin(a * 40);
    return [10 + r * Math.cos(a), 50 + r * Math.sin(a)] as Point;
  });
  ring.push(ring[0]);
  return ring;
}

describe("seaZonesFromFeatures", () => {
  it("leaves out the open and circumpolar oceans", () => {
    const zones = seaZonesFromFeatures([
      feature("North Sea", [box(-4, 51, 12, 61)]),
      feature("North Atlantic Ocean", [box(-80, 0, 0, 60)]),
      feature("Indian Ocean", [box(20, -60, 140, 10)]),
      feature("Southern Ocean", [box(-180, -85, 180, -60)]),
    ]);
    expect(zones.map((z) => z.name)).toEqual(["North Sea"]);
  });

  it("keeps the largest piece by area, not the most detailed one", () => {
    // Like the South Pacific: a detailed small piece west of the antimeridian, a plain big one east.
    const smallDetailed: Point[] = [
      ...box(170, -20, 180, -10).slice(0, 4),
      ...Array.from({ length: 500 }, (_, i) => [170, -10 - (i * 10) / 500] as Point),
    ];
    smallDetailed.push(smallDetailed[0]);
    const zones = seaZonesFromFeatures([feature("Split Sea", [smallDetailed, box(-180, -60, -70, 0)])]);
    expect(zones).toHaveLength(1);
    expect(zones[0].bbox).toEqual({ minLon: -180, minLat: -60, maxLon: -70, maxLat: 0 });
    expect(zones[0].outline).toEqual(box(-180, -60, -70, 0));
  });

  it("simplifies to a closed, simple, counter-clockwise ring of at most 80 points and keeps the full outline", () => {
    const ring = detailedRing(2000);
    const [zone] = seaZonesFromFeatures([feature("Wiggly Sea", [ring.slice().reverse()])]);
    const wktRing = parseWktPolygonRing(zone.wkt);
    expect(wktRing.length).toBeLessThanOrEqual(80);
    expect(wktRing[0]).toEqual(wktRing[wktRing.length - 1]);
    expect(isSimpleRing(wktRing)).toBe(true);
    let signedArea = 0;
    for (let i = 0; i < wktRing.length - 1; i++)
      signedArea += wktRing[i][0] * wktRing[i + 1][1] - wktRing[i + 1][0] * wktRing[i][1];
    expect(signedArea).toBeGreaterThan(0);
    expect(zone.outline).toHaveLength(2001);
  });

  it("skips features without a name or geometry and trims names", () => {
    const zones = seaZonesFromFeatures([
      { properties: { name: null }, geometry: { type: "Polygon", coordinates: [box(0, 0, 1, 1)] } },
      { properties: { name: "Empty Sea" }, geometry: null },
      { properties: { name: " Red Sea " }, geometry: { type: "Polygon", coordinates: [box(33, 12, 43, 28, true)] } },
    ]);
    expect(zones.map((z) => z.name)).toEqual(["Red Sea"]);
  });
});
