// oceanZonesFromFeatures on hand-made features shaped like the EEZ x IHO layer's.
import { describe, expect, it } from "vitest";
import { oceanZonesFromFeatures, type EezIhoFeature } from "./fetch-eez-iho.js";
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

function piece(marregion: string, iho_sea: string, eez: string | null): EezIhoFeature {
  return {
    properties: { marregion, iho_sea, eez },
    geometry: { type: "MultiPolygon", coordinates: [[box(-80, -40, -70, -20)]] },
  };
}

describe("oceanZonesFromFeatures", () => {
  it("keeps a country's part of an ocean, named as Marine Regions names it", () => {
    const zones = oceanZonesFromFeatures([
      piece("Chilean part of the South Pacific Ocean", "South Pacific Ocean", "Chilean Exclusive Economic Zone"),
    ]);
    expect(zones.map((z) => z.name)).toEqual(["Chilean part of the South Pacific Ocean"]);
    expect(zones[0].bbox).toEqual({ minLon: -80, minLat: -40, maxLon: -70, maxLat: -20 });
  });

  it("leaves out the high seas, joint regime areas and pieces of named seas", () => {
    const zones = oceanZonesFromFeatures([
      piece("High Seas of the South Pacific Ocean", "South Pacific Ocean", null),
      piece(
        "Joint regime area: Peru / Ecuador part of the South Pacific Ocean",
        "South Pacific Ocean",
        "Joint regime area Ecuador / Peru",
      ),
      // Named seas come whole from IHO Sea Areas instead.
      piece("Mexican part of the Gulf of Mexico", "Gulf of Mexico", "Mexican Exclusive Economic Zone"),
      piece(
        "Overlapping claim Mayotte: France / Comores part of the Indian Ocean",
        "Indian Ocean",
        "Overlapping claim Mayotte",
      ),
    ]);
    expect(zones.map((z) => z.name)).toEqual(["Overlapping claim Mayotte: France / Comores part of the Indian Ocean"]);
  });
});
