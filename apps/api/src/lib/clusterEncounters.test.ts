import { describe, expect, it } from "vitest";
import { clusterIntoEncounters, type ClusterableCapture } from "./clusterEncounters.js";

function cap(id: string, takenAt: string | null): ClusterableCapture {
  return { id, takenAt };
}

describe("clusterIntoEncounters", () => {
  it("groups captures taken within the session gap into one encounter", () => {
    const encounters = clusterIntoEncounters([
      cap("a", "2026-01-01T10:00:00Z"),
      cap("b", "2026-01-01T10:15:00Z"),
      cap("c", "2026-01-01T10:30:00Z"),
    ]);
    expect(encounters).toHaveLength(1);
    expect(encounters[0].captureIds).toEqual(["a", "b", "c"]);
    expect(encounters[0].earliestTakenAt).toBe("2026-01-01T10:00:00Z");
    expect(encounters[0].latestTakenAt).toBe("2026-01-01T10:30:00Z");
  });

  it("splits into separate encounters when the gap exceeds one hour", () => {
    const encounters = clusterIntoEncounters([
      cap("a", "2026-01-01T10:00:00Z"),
      cap("b", "2026-01-01T12:00:00Z"), // 2 hours later
    ]);
    expect(encounters).toHaveLength(2);
    expect(encounters[0].captureIds).toEqual(["a"]);
    expect(encounters[1].captureIds).toEqual(["b"]);
  });

  // Boundary: exactly 1 hour apart stays together (strictly-greater-than splits), one second
  // past the hour splits.
  it("keeps exactly-one-hour-apart captures together, splits at one hour plus one second", () => {
    const exact = clusterIntoEncounters([cap("a", "2026-01-01T10:00:00Z"), cap("b", "2026-01-01T11:00:00Z")]);
    expect(exact).toHaveLength(1);

    const justOver = clusterIntoEncounters([cap("a", "2026-01-01T10:00:00Z"), cap("b", "2026-01-01T11:00:01Z")]);
    expect(justOver).toHaveLength(2);
  });

  it("sorts out-of-order input by taken_at before clustering", () => {
    const encounters = clusterIntoEncounters([
      cap("late", "2026-01-01T10:30:00Z"),
      cap("early", "2026-01-01T10:00:00Z"),
    ]);
    expect(encounters).toHaveLength(1);
    expect(encounters[0].captureIds).toEqual(["early", "late"]);
  });

  it("gives every capture with no taken_at its own single-photo encounter", () => {
    const encounters = clusterIntoEncounters([cap("a", null), cap("b", null)]);
    expect(encounters).toHaveLength(2);
    expect(encounters.map((e) => e.captureIds)).toEqual([["a"], ["b"]]);
    expect(encounters[0].earliestTakenAt).toBeNull();
    expect(encounters[0].latestTakenAt).toBeNull();
  });

  it("returns an empty array for no captures", () => {
    expect(clusterIntoEncounters([])).toEqual([]);
  });

  it("keeps timed encounters and untimed singletons separate, timed first", () => {
    const encounters = clusterIntoEncounters([cap("timed", "2026-01-01T10:00:00Z"), cap("untimed", null)]);
    expect(encounters).toHaveLength(2);
    expect(encounters[0].captureIds).toEqual(["timed"]);
    expect(encounters[1].captureIds).toEqual(["untimed"]);
  });
});
