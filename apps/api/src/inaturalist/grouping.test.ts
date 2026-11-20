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
});
