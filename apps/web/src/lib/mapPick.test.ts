import { describe, expect, it } from "vitest";
import { clusterRadius, pickNearest, pickSlop, pointRadius, spotUnderMark, type PickCandidate } from "./mapPick";

const at = (
  kind: PickCandidate["kind"],
  x: number,
  y: number,
  radius = 5,
  data: string = kind,
): PickCandidate<string> => ({
  kind,
  x,
  y,
  radius,
  data,
});

describe("pickNearest", () => {
  it("takes the nearest dot within reach, not only one under the pointer", () => {
    const hit = pickNearest([at("point", 110, 100, 5, "far"), at("point", 104, 100, 5, "near")], 100, 100, 8);
    expect(hit?.data).toBe("near");
  });

  it("prefers a dot over a ring at about the same distance, and either over a country", () => {
    const ring = at("ring", 100, 101, 20);
    const dot = at("cluster", 102, 100, 11);
    const country = at("country", 0, 0, 0);
    expect(pickNearest([ring, dot, country], 100, 100, 8)?.kind).toBe("cluster");
    expect(pickNearest([ring, country], 100, 100, 8)?.kind).toBe("ring");
  });

  it("lets the province under the pointer win only when no mark is in reach, before its country", () => {
    const dot = at("point", 150, 100);
    const areas = [at("country", 0, 0, 0), at("province", 0, 0, 0)];
    expect(pickNearest([dot, ...areas], 100, 100, 8)?.kind).toBe("province");
    expect(pickNearest([at("point", 110, 100), ...areas], 100, 100, 8)?.kind).toBe("point");
  });

  it("reaches further for a finger than for a mouse", () => {
    const dot = [at("point", 125, 100)];
    expect(pickNearest(dot, 100, 100, pickSlop("mouse", 6))).toBeNull();
    expect(pickNearest(dot, 100, 100, pickSlop("touch", 6))?.kind).toBe("point");
    expect(pickSlop("mouse", 1)).toBeGreaterThan(pickSlop("mouse", 6));
  });

  it("returns nothing over empty sea", () => {
    expect(pickNearest([], 0, 0, 8)).toBeNull();
  });
});

describe("drawn radii", () => {
  it("match the map's circle sizes", () => {
    expect(clusterRadius(1)).toBe(11);
    expect(clusterRadius(900)).toBe(22);
    expect(pointRadius(1)).toBe(5);
    expect(pointRadius(100)).toBe(9);
  });
});

describe("saved spots under photo marks", () => {
  it("lets the photo mark win when a spot sits inside it, even nearer the pointer", () => {
    const marks = [at("cluster", 100, 100, 18), at("spot", 104, 100, 7.5)];
    expect(pickNearest(marks, 104, 100, 8)?.kind).toBe("cluster");
  });

  it("keeps a spot pickable once it is clear of the mark", () => {
    const marks = [at("cluster", 100, 100, 18), at("spot", 130, 100, 7.5)];
    expect(pickNearest(marks, 130, 100, 8)?.kind).toBe("spot");
  });

  it("folds a spot only when its centre is inside the mark", () => {
    expect(spotUnderMark({ x: 10, y: 0 }, { x: 0, y: 0, radius: 11 })).toBe(true);
    expect(spotUnderMark({ x: 12, y: 0 }, { x: 0, y: 0, radius: 11 })).toBe(false);
  });
});
