import { describe, expect, it } from "vitest";
import { clusterForImport } from "@lifer/shared";

const at = (min: number) => new Date(Date.UTC(2026, 5, 13, 12, min)).toISOString();

describe("clusterForImport", () => {
  it("keeps one species within an hour together and splits after a longer gap", () => {
    const clusters = clusterForImport([
      { id: "a", speciesId: "fox", takenAt: at(0) },
      { id: "b", speciesId: "fox", takenAt: at(30) },
      { id: "c", speciesId: "fox", takenAt: at(200) },
    ]);
    expect(clusters.map((c) => c.captureIds.sort())).toEqual([["c"], ["a", "b"]]);
  });

  it("never mixes species, and gives each undated photo its own sighting", () => {
    const clusters = clusterForImport([
      { id: "a", speciesId: "fox", takenAt: at(0) },
      { id: "b", speciesId: "moose", takenAt: at(1) },
      { id: "c", speciesId: "fox", takenAt: null },
      { id: "d", speciesId: "fox", takenAt: null },
    ]);
    expect(clusters).toHaveLength(4);
    expect(clusters.every((c) => c.captureIds.length === 1 || c.speciesId === "fox")).toBe(true);
  });

  it("splits where consecutive photos are over 200 m apart, but not for a short walk or missing places", () => {
    const here = { lat: 49.0, lon: -123.0 };
    const clusters = clusterForImport([
      { id: "a", speciesId: "fox", takenAt: at(0), ...here },
      { id: "b", speciesId: "fox", takenAt: at(5), lat: 49.001, lon: -123.0 }, // about 111 m
      { id: "c", speciesId: "fox", takenAt: at(10), lat: 49.0035, lon: -123.0 }, // about 280 m from b
      { id: "d", speciesId: "fox", takenAt: at(15) },
    ]);
    expect(clusters.map((c) => c.captureIds.sort())).toEqual([
      ["c", "d"],
      ["a", "b"],
    ]);
  });

  it("splits when the camera or lens changes, not when one side doesn't say", () => {
    const clusters = clusterForImport([
      { id: "a", speciesId: "fox", takenAt: at(0), cameraModel: "R5", lens: "100-500" },
      { id: "b", speciesId: "fox", takenAt: at(2), cameraModel: "R5", lens: null },
      { id: "c", speciesId: "fox", takenAt: at(4), cameraModel: "iPhone 15", lens: null },
      { id: "d", speciesId: "fox", takenAt: at(6), cameraModel: "iPhone 15", lens: "back" },
      { id: "e", speciesId: "fox", takenAt: at(8), cameraModel: "iPhone 15", lens: "front" },
    ]);
    expect(clusters.map((c) => c.captureIds.sort())).toEqual([["e"], ["c", "d"], ["a", "b"]]);
  });
});
