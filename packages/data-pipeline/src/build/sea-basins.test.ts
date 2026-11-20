import { describe, expect, it } from "vitest";
import type { Point } from "@lifer/core/lib/geometry.js";
import {
  assignBasins,
  basinFromZone,
  decideBasinStrays,
  landBridges,
  sameBasin,
  sharesSeaBoundary,
  type Basin,
  type StrayInputs,
} from "./sea-basins.js";

const zone = (name: string, minLat = 0, maxLat = 10) => ({ name, minLat, maxLat });

describe("basinFromZone", () => {
  it("reads the ocean from a national part's name and leaves named seas open", () => {
    expect(basinFromZone(zone("Panamanian part of the North Pacific Ocean"))).toBe("indo-pacific");
    expect(basinFromZone(zone("Kenyan part of the Indian Ocean"))).toBe("indo-pacific");
    expect(basinFromZone(zone("Bahamian part of the North Atlantic Ocean"))).toBe("atlantic");
    expect(basinFromZone(zone("Caribbean Sea"))).toBeNull();
  });

  it("makes zones centred near the poles polar, whatever their name", () => {
    expect(basinFromZone(zone("Chukchi Sea", 65, 75))).toBe("polar");
    expect(basinFromZone(zone("Chilean part of the South Atlantic Ocean", -57, -52))).toBe("polar");
    expect(sameBasin("polar", "atlantic")).toBe(true);
    expect(sameBasin("atlantic", "indo-pacific")).toBe(false);
  });
});

describe("assignBasins", () => {
  it("gives a named sea the basin most of its neighbours have", () => {
    const zones = [
      zone("Caribbean Sea"),
      zone("Bahamian part of the North Atlantic Ocean"),
      zone("Cuban part of the North Atlantic Ocean"),
      zone("Panamanian part of the North Pacific Ocean"),
      zone("Gulf of Mexico"),
    ];
    const neighbours = new Map([
      [0, new Set([1, 2, 3, 4])],
      [1, new Set([0])],
      [2, new Set([0])],
      [3, new Set([0])],
      [4, new Set([0])],
    ]);
    // The Gulf of Mexico only touches the Caribbean, so it takes its basin on the second round.
    expect(assignBasins(zones, neighbours)).toEqual(["atlantic", "atlantic", "atlantic", "indo-pacific", "atlantic"]);
  });
});

describe("landBridges", () => {
  const line = (lon: number, n: number): Point[] => Array.from({ length: n }, (_, i) => [lon, i * 0.1] as Point);
  it("counts zones of two basins as a land bridge only when they share no boundary at sea", () => {
    // The two South African coasts share a boundary line; Caribbean and Pacific Panama only meet across land.
    const rings: Point[][][] = [[line(20, 30)], [line(20, 30)], [line(-79, 30)], [line(-79.2, 30)]];
    const basins: Basin[] = ["atlantic", "indo-pacific", "atlantic", "indo-pacific"];
    const neighbours = new Map([
      [0, new Set([1])],
      [1, new Set([0])],
      [2, new Set([3])],
      [3, new Set([2])],
    ]);
    expect(sharesSeaBoundary(rings[0], rings[1])).toBe(true);
    expect([...landBridges(rings, basins, neighbours)].sort()).toEqual(["2|3", "3|2"]);
    // A reviewed canal link (Suez) counts as sea.
    expect(landBridges(rings, basins, neighbours, new Set(["3|2"])).size).toBe(0);
  });
});

describe("decideBasinStrays", () => {
  // 0 Caribbean, 1 Panamanian Pacific, 2 Mexican Pacific, 3 Gulf of Mexico.
  const base: StrayInputs = {
    basins: ["atlantic", "indo-pacific", "indo-pacific", "atlantic"],
    neighbours: new Map([
      [0, new Set([1, 3])],
      [1, new Set([0, 2])],
      [2, new Set([1])],
      [3, new Set([0])],
    ]),
    bridges: new Set(["0|1", "1|0"]),
    zoneNames: ["Caribbean Sea", "Panamanian Pacific", "Mexican Pacific", "Gulf of Mexico"],
    globalCount: new Map([["edge", 1000]]),
    marineOrBrackish: new Set(["edge"]),
    allow: new Set(),
    deep: new Set(),
  };

  it("drops a Pacific species kept in the Caribbean only by the Panamanian Pacific across the isthmus", () => {
    const rows = [
      { zone: 0, speciesId: "edge", recordCount: 2 },
      { zone: 1, speciesId: "edge", recordCount: 4 },
      { zone: 2, speciesId: "edge", recordCount: 5 },
      // Well recorded only across the isthmus; ratio too small for the stray rule.
      { zone: 1, speciesId: "edge2", recordCount: 30 },
      { zone: 0, speciesId: "edge2", recordCount: 3 },
      { zone: 3, speciesId: "edge2", recordCount: 3 },
    ];
    const out = decideBasinStrays(rows, {
      ...base,
      globalCount: new Map([["edge2", 1000]]),
      marineOrBrackish: new Set(["edge2"]),
    });
    expect(out.map((d) => [d.zone, d.speciesId, d.rule])).toEqual([[0, "edge2", "edge-across-basin"]]);
  });

  it("keeps an edge-of-range species that its own ocean records well elsewhere", () => {
    const rows = [
      { zone: 1, speciesId: "marlin", recordCount: 3 },
      { zone: 2, speciesId: "marlin", recordCount: 40 },
      { zone: 0, speciesId: "marlin", recordCount: 50 },
    ];
    const out = decideBasinStrays(rows, {
      ...base,
      globalCount: new Map([["marlin", 100000]]),
      marineOrBrackish: new Set(["marlin"]),
    });
    expect(out).toEqual([]);
  });

  it("drops a stray whose basin has a handful of records against many times more elsewhere", () => {
    const rows = [
      { zone: 0, speciesId: "kuhl", recordCount: 8 },
      { zone: 2, speciesId: "kuhl", recordCount: 1245 },
      // Bull Shark: hundreds of Atlantic records, kept whatever the ratio.
      { zone: 0, speciesId: "bull", recordCount: 300 },
      { zone: 2, speciesId: "bull", recordCount: 50000 },
      // Blacktip Reef Shark: dozens of Atlantic records, overwhelmed.
      { zone: 0, speciesId: "reef", recordCount: 10 },
      { zone: 3, speciesId: "reef", recordCount: 31 },
      { zone: 2, speciesId: "reef", recordCount: 226680 },
    ];
    const out = decideBasinStrays(rows, base);
    expect(out.map((d) => `${d.zone}:${d.speciesId}:${d.rule}`).sort()).toEqual([
      "0:kuhl:basin-stray",
      "0:reef:basin-stray",
      "3:reef:basin-stray",
    ]);
  });

  it("leaves allow-listed species, lists deep-sea ones for review, and skips zones that meet another basin at sea", () => {
    const rows = [
      { zone: 0, speciesId: "allowed", recordCount: 2 },
      { zone: 2, speciesId: "allowed", recordCount: 900 },
      { zone: 0, speciesId: "deep", recordCount: 2 },
      { zone: 2, speciesId: "deep", recordCount: 900 },
    ];
    const out = decideBasinStrays(rows, { ...base, allow: new Set(["allowed"]), deep: new Set(["deep"]) });
    expect(out.map((d) => `${d.speciesId}:${d.rule}`)).toEqual(["deep:deep-sea-review"]);
    // Without the land bridge the Caribbean meets the Pacific at sea: a junction, so nothing goes.
    expect(decideBasinStrays(rows, { ...base, bridges: new Set() })).toEqual([]);
  });
});
