import { describe, expect, it } from "vitest";
import { bucketsFor, overviewInsights, type InsightInputs } from "./overview.js";

const quiet: InsightInputs = {
  totalKeepers: 0,
  topCamera: null,
  focalLength: { buckets: [], total: 0 },
  timeOfDay: [],
  perMonth: [],
  ghostCount: 0,
  lostCount: 0,
  rediscoveredCount: 0,
};

describe("bucketsFor", () => {
  it("lays database rows over every bucket, counting values below the first in the total only", () => {
    const { buckets, total } = bucketsFor(
      [
        { dim: "iso", bucket: 0, count: 2, species: 1, photo_ids: null },
        { dim: "iso", bucket: 2, count: 3, species: 2, photo_ids: ["p1"] },
        { dim: "aperture", bucket: 1, count: 9, species: 9, photo_ids: null },
      ],
      "iso",
    );
    expect(total).toBe(5);
    expect(buckets.map((b) => b.label)).toEqual(["≤200", "400", "800", "1600", "3200", "6400+"]);
    expect(buckets[1]).toEqual({ label: "400", count: 3, photoIds: ["p1"], species: 2 });
    expect(buckets[0]).toEqual({ label: "≤200", count: 0, photoIds: [], species: 0 });
  });
});

describe("overviewInsights", () => {
  it("says nothing without data", () => {
    expect(overviewInsights(quiet)).toEqual([]);
  });

  it("needs five focal lengths, and a quarter of them in one range", () => {
    const focal = (counts: number[], total: number) => ({
      buckets: counts.map((count, i) => ({ label: `b${i}`, count })),
      total,
    });
    expect(overviewInsights({ ...quiet, focalLength: focal([4], 4) })).toEqual([]);
    expect(overviewInsights({ ...quiet, focalLength: focal([1, 1, 1, 1, 1], 5) })).toEqual([]);
    expect(overviewInsights({ ...quiet, focalLength: focal([2, 3], 5) })).toEqual([
      "60% of your keepers were shot in the b1 range.",
    ]);
  });

  it("names the best month and the collection's Ghost, Lost and rediscovered species", () => {
    const perMonth = [
      { month: "2024-01", newLifers: 1 },
      { month: "2024-02", newLifers: 3 },
      { month: "2024-03", newLifers: 0 },
    ];
    expect(overviewInsights({ ...quiet, perMonth, ghostCount: 1, lostCount: 2, rediscoveredCount: 1 })).toEqual([
      "February 2024 was your best month, 3 new lifers.",
      "You've photographed 1 Ghost species, rarely documented anywhere, but you found one.",
      "You've photographed 2 Lost species, not recorded anywhere else in over 25 years.",
      "You helped rediscover 1 species that was Ghost or Lost when you found it.",
    ]);
  });
});
