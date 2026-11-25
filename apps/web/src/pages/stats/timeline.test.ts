import { describe, expect, it } from "vitest";
import {
  axisTicks,
  galleryDates,
  parseRangeParam,
  rangeIndices,
  rangeOf,
  timelineBins,
  timelineGroup,
} from "./timeline";

const rows = [
  { month: "2019-11", taxonClass: "aves", count: 3 },
  { month: "2019-11", taxonClass: "amphibia", count: 1 },
  { month: "2020-02", taxonClass: "squamata", count: 2 },
  { month: "2020-02", taxonClass: "nudibranchs", count: 4 },
  { month: "2021-01", taxonClass: null, count: 10_000 },
];

describe("timeline", () => {
  it("folds classes into the five bands", () => {
    expect(
      ["aves", "aquatic_mammalia", "testudines", "amphibia", "elasmobranchii", "corals", "Insecta", null].map(
        timelineGroup,
      ),
    ).toEqual(["birds", "mammals", "herps", "herps", "sea", "sea", "other", "other"]);
  });

  it("lays every month out from the first photo to the last, gaps included", () => {
    const bins = timelineBins(rows, "month");
    expect(bins.map((b) => b.key)).toEqual([
      "2019-11",
      "2019-12",
      "2020-01",
      "2020-02",
      "2020-03",
      "2020-04",
      "2020-05",
      "2020-06",
      "2020-07",
      "2020-08",
      "2020-09",
      "2020-10",
      "2020-11",
      "2020-12",
      "2021-01",
    ]);
    expect(bins[0]).toMatchObject({ birds: 3, herps: 1, total: 4 });
    expect(bins[3]).toMatchObject({ herps: 2, sea: 4, total: 6 });
    expect(bins[14]).toMatchObject({ other: 10_000, total: 10_000 });
    expect(bins.reduce((sum, b) => sum + b.total, 0)).toBe(10_010);
    expect(timelineBins([], "month")).toEqual([]);
  });

  it("reaches back a year before a short span of photos, so a few months draw narrow bars", () => {
    const bins = timelineBins(
      [
        { month: "2026-09", taxonClass: "aves", count: 7 },
        { month: "2026-10", taxonClass: "aves", count: 3 },
      ],
      "month",
    );
    expect(bins.map((b) => b.key)).toEqual([
      "2025-11",
      "2025-12",
      ...["01", "02", "03", "04", "05", "06", "07", "08", "09", "10"].map((m) => `2026-${m}`),
    ]);
    expect(bins.slice(-2).map((b) => b.total)).toEqual([7, 3]);
  });

  it("sums years, and twenty years of months stay one bar each", () => {
    expect(timelineBins(rows, "year").map((b) => [b.key, b.total])).toEqual([
      ["2017", 0],
      ["2018", 0],
      ["2019", 4],
      ["2020", 6],
      ["2021", 10_000],
    ]);
    const long = timelineBins(
      [
        { month: "2005-01", taxonClass: "aves", count: 1 },
        { month: "2024-12", taxonClass: "aves", count: 1 },
      ],
      "month",
    );
    expect(long).toHaveLength(240);
  });

  it("maps a range to bins and back, in either granularity", () => {
    const months = timelineBins(rows, "month");
    const years = timelineBins(rows, "year");
    const range = { from: "2020-02", to: "2020-06" };
    expect(rangeIndices(months, range, "month")).toEqual([3, 7]);
    expect(rangeOf(months, 3, 7, "month")).toEqual(range);
    expect(rangeIndices(years, range, "year")).toEqual([3, 3]);
    expect(rangeOf(years, 3, 3, "year")).toEqual({ from: "2020-01", to: "2020-12" });
    // The whole timeline is no range at all.
    expect(rangeIndices(months, null, "month")).toEqual([0, 14]);
    expect(rangeOf(months, 0, 14, "month")).toBeNull();
    // A range outside the photos still gives a valid span.
    expect(rangeIndices(months, { from: "2030-01", to: "2031-01" }, "month")).toEqual([14, 14]);
  });

  it("thins axis labels to what fits, never overlapping", () => {
    const keys = timelineBins(
      [
        { month: "2025-11", taxonClass: "aves", count: 1 },
        { month: "2026-10", taxonClass: "aves", count: 1 },
      ],
      "month",
    ).map((b) => b.key);
    // Wide: every month, the year on the first and on January.
    const wide = axisTicks(keys, 800);
    expect(wide).toHaveLength(12);
    expect(wide.filter((t) => t.year).map((t) => `${t.label} ${t.year}`)).toEqual(["Nov 2025", "Jan 2026"]);
    // Narrow: quarters.
    expect(axisTicks(keys, 160).map((t) => t.label)).toEqual(["Jan", "Apr", "Jul", "Oct"]);
    // Twenty years in a phone's width: years only, spaced out.
    const long = timelineBins(
      [
        { month: "2005-01", taxonClass: "aves", count: 1 },
        { month: "2024-12", taxonClass: "aves", count: 1 },
      ],
      "month",
    ).map((b) => b.key);
    const phone = axisTicks(long, 330);
    expect(phone.map((t) => t.label)).toEqual(["2005", "2010", "2015", "2020"]);
    expect(axisTicks(["2019", "2020", "2021", "2022", "2023"], 300).map((t) => t.label)).toHaveLength(5);
  });

  it("reads only a well-formed dates param", () => {
    expect(parseRangeParam("2021-08..2019-03")).toEqual({ from: "2019-03", to: "2021-08" });
    for (const bad of ["", "2019-3..2020-01", "2019-13..2020-01", "2019-01"]) expect(parseRangeParam(bad)).toBeNull();
  });

  it("gives the Gallery the range's first and last day", () => {
    expect(galleryDates({ from: "2024-02", to: "2024-02" })).toEqual({ dateFrom: "2024-02-01", dateTo: "2024-02-29" });
  });
});
