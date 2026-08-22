// passesRecurrenceCheck is load-bearing for two features: the
// recurrence-rescue pass (Northern Goshawk — a real but SPARSE resident wrongly excluded by
// the raw recent-window threshold) and its exact inverse, region-scoped vagrant detection
// (Costa's Hummingbird — a burst of records from one chased bird, wrongly read as an
// established presence). Both depend on this one function drawing the line correctly between
// "spread across real years" and "concentrated in a burst."
import { describe, expect, it } from "vitest";
import { passesRecurrenceCheck, RECURRENCE_MIN_DISTINCT_YEARS, RECURRENCE_MAX_YEAR_CONCENTRATION } from "./build-region-species.js";

describe("passesRecurrenceCheck", () => {
  it("passes a species recorded steadily across many years with no single year dominating (genuine resident)", () => {
    const yearCounts = [
      { year: 2015, count: 5 },
      { year: 2017, count: 8 },
      { year: 2019, count: 4 },
      { year: 2021, count: 6 },
      { year: 2023, count: 7 },
    ];
    expect(passesRecurrenceCheck(yearCounts)).toBe(true);
  });

  it("fails a single-event burst (Costa's Hummingbird — all records from one chased bird)", () => {
    const yearCounts = [{ year: 2024, count: 294 }];
    expect(passesRecurrenceCheck(yearCounts)).toBe(false);
  });

  it("fails when one year dominates even with a few other years present", () => {
    const yearCounts = [
      { year: 2000, count: 133 },
      { year: 2005, count: 5 },
      { year: 2010, count: 5 },
    ];
    expect(passesRecurrenceCheck(yearCounts)).toBe(false);
  });

  it("fails with zero total records", () => {
    expect(passesRecurrenceCheck([])).toBe(false);
  });

  it("respects the exact distinct-years and concentration thresholds", () => {
    // Exactly at the distinct-years floor, no year over the concentration cap -> passes.
    const atThreshold = Array.from({ length: RECURRENCE_MIN_DISTINCT_YEARS }, (_, i) => ({
      year: 2000 + i,
      count: 10,
    }));
    expect(passesRecurrenceCheck(atThreshold)).toBe(true);

    // One fewer distinct year than the floor -> fails, even with even distribution.
    const belowThreshold = atThreshold.slice(1);
    expect(passesRecurrenceCheck(belowThreshold)).toBe(false);

    // Concentration exactly at the cap still passes; just over it fails.
    const atCap = [
      { year: 2020, count: Math.round(100 * RECURRENCE_MAX_YEAR_CONCENTRATION) },
      { year: 2021, count: 100 - Math.round(100 * RECURRENCE_MAX_YEAR_CONCENTRATION) },
      { year: 2022, count: 1 },
    ];
    expect(passesRecurrenceCheck(atCap)).toBe(true);
  });
});
