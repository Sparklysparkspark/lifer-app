// ZoneSegmentIndex: which regions count as next to which sea zones, on hand-made outlines.
import { describe, expect, it } from "vitest";
import { ZoneSegmentIndex, NEARBY_SEA_ZONE_MAX_DISTANCE_DEGREES, MIN_SHARED_BOUNDARY_DEGREES } from "./nearby-sea-zones.js";
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

// Region boundaries are dense in real data (Natural Earth 10m), and boundary length is measured
// edge by edge, so test regions get a vertex every 0.01 degrees.
function denseBox(minLon: number, minLat: number, maxLon: number, maxLat: number): Point[] {
  const corners = box(minLon, minLat, maxLon, maxLat);
  const ring: Point[] = [];
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[i + 1];
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 0.01));
    for (let k = 0; k < steps; k++) ring.push([ax + ((bx - ax) * k) / steps, ay + ((by - ay) * k) / steps]);
  }
  ring.push(ring[0]);
  return ring;
}

// A sea whose outline has only its four corners, 20 degrees apart: the case the API's
// vertex-to-vertex check misses (a coast in the middle of a long edge is far from every vertex).
const BIG_SEA = { id: "big-sea", ring: box(0, 0, 20, 20) };
const SMALL_SEA = { id: "small-sea", ring: box(30, 0, 32, 2) };

describe("ZoneSegmentIndex.nearbyZoneIds", () => {
  const index = new ZoneSegmentIndex([BIG_SEA, SMALL_SEA]);

  it("finds a coast that runs along the middle of a long outline edge", () => {
    // A province whose southern boundary sits on the sea's northern edge, far from any corner.
    expect(index.nearbyZoneIds([box(9, 20, 11, 22)])).toEqual(["big-sea"]);
  });

  it("allows a boundary that stops just short of the shore, but not an inland region", () => {
    const gap = NEARBY_SEA_ZONE_MAX_DISTANCE_DEGREES / 2;
    expect(index.nearbyZoneIds([box(9, 20 + gap, 11, 22)])).toEqual(["big-sea"]);
    expect(index.nearbyZoneIds([box(9, 21, 11, 23)])).toEqual([]);
  });

  it("counts an island inside a sea, which is a hole IHO's outline doesn't carry", () => {
    expect(index.nearbyZoneIds([box(9, 9, 10, 10)])).toEqual(["big-sea"]);
  });

  it("returns every zone a region borders, from any of its rings", () => {
    // A country of two parts, one on each sea.
    expect(index.nearbyZoneIds([box(25, 0, 29.95, 2), box(5, 20, 6, 21)])).toEqual(["big-sea", "small-sea"]);
  });

  it("works across the grid's cell boundaries and in negative coordinates", () => {
    const west = new ZoneSegmentIndex([{ id: "west", ring: box(-170.3, -40.2, -150.1, -20.4) }]);
    expect(west.nearbyZoneIds([box(-150.05, -30.5, -149, -29.5)])).toEqual(["west"]);
    expect(west.nearbyZoneIds([box(-149.5, -30.5, -149, -29.5)])).toEqual([]);
  });

  it("leaves out a zone the region only touches at a corner, like a neighbour's part of an ocean", () => {
    // Two countries' parts of an ocean side by side, split at x = 10 where their land border meets
    // the coast (y = 0, land to the north).
    const parts = new ZoneSegmentIndex([
      { id: "west-part", ring: box(0, -5, 10, 0) },
      { id: "east-part", ring: box(10, -5, 20, 0) },
    ]);
    // The western country's coast runs from x = 0 to 10 and its border goes north from (10, 0).
    expect(parts.nearbyZoneIds([denseBox(0, 0, 10, 3)])).toEqual(["west-part"]);
    // A coast running a little past the corner (its border going inland near the sea counts too)...
    expect(parts.nearbyZoneIds([denseBox(0, 0, 10 + MIN_SHARED_BOUNDARY_DEGREES / 4, 3)])).toEqual(["west-part"]);
    // ...and one running along it for more borders it.
    expect(parts.nearbyZoneIds([denseBox(0, 0, 10 + MIN_SHARED_BOUNDARY_DEGREES * 2, 3)])).toEqual(["west-part", "east-part"]);
  });

  it("counts an islet whose whole coast is shorter than the minimum", () => {
    expect(index.nearbyZoneIds([box(10, 19.95, 10.05, 20.05)])).toEqual(["big-sea"]);
  });

  it("checks every part of a region for being inside a sea, not only the first", () => {
    // A mainland far from any sea, plus an island in the middle of the big sea.
    expect(index.nearbyZoneIds([box(50, 50, 55, 55), box(9, 9, 10, 10)])).toEqual(["big-sea"]);
  });

  it("still gives a tiny coast where two zones meet one of them rather than none", () => {
    const parts = new ZoneSegmentIndex([
      { id: "west-part", ring: box(0, -5, 10, 0) },
      { id: "east-part", ring: box(10, -5, 20, 0) },
    ]);
    // A coast 0.04 degrees long astride the meeting point: almost every point is a tie.
    const ids = parts.nearbyZoneIds([denseBox(9.98, 0, 10.02, 0.04)]);
    expect(ids).toHaveLength(1);
    expect(["west-part", "east-part"]).toContain(ids[0]);
  });
});

