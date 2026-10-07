import { describe, expect, it } from "vitest";
import {
  exifRows,
  gearRows,
  headlineStats,
  percentOfKeepers,
  portfolioHighlights,
  SCATTER_AXES,
  scatterPointsFor,
  shutterTicks,
  statsCsvFilename,
  yearsPhotographed,
} from "./statsHelpers";
import type { PortfolioSpecies, ScatterPoint, StatsResponse } from "./types";

function stats(partial: Partial<StatsResponse>): StatsResponse {
  return {
    totalKeepers: 0,
    insights: [],
    perMonth: [],
    gearUsage: { cameras: [], lenses: [], combos: [] },
    timeOfDay: [],
    exifDistributions: { focalLength: [], iso: [], aperture: [], shutter: [] },
    hitRateByFocalLength: [],
    scatter: [],
    countriesPhotographed: { count: 0, countries: [] },
    ghostSpecies: [],
    lostSpecies: [],
    rediscoveredSpecies: [],
    ...partial,
  };
}

function species(id: string, partial: Partial<PortfolioSpecies> = {}): PortfolioSpecies {
  return {
    speciesId: id,
    commonName: null,
    scientificName: id,
    taxonClass: "aves",
    totalPhotos: 1,
    rated4Plus: 0,
    bestRating: null,
    earliestTakenAt: null,
    latestTakenAt: null,
    ...partial,
  };
}

describe("SCATTER_AXES formats", () => {
  it("writes shutter speeds as fractions under a second and seconds above", () => {
    expect(SCATTER_AXES.shutterSeconds.format(1 / 500)).toBe("1/500");
    expect(SCATTER_AXES.shutterSeconds.format(0.3)).toBe("1/3");
    expect(SCATTER_AXES.shutterSeconds.format(1)).toBe("1s");
    expect(SCATTER_AXES.shutterSeconds.format(2.5)).toBe("2.5s");
  });

  it("labels the other axes with their units", () => {
    expect(SCATTER_AXES.focalLength.format(400)).toBe("400mm");
    expect(SCATTER_AXES.aperture.format(5.6)).toBe("f/5.6");
    expect(SCATTER_AXES.iso.format(800)).toBe("800");
  });
});

describe("shutterTicks", () => {
  it("offers the common speeds when there's no data", () => {
    expect(shutterTicks([]).map((s) => Math.round(1 / s))).toEqual([30, 60, 125, 250, 500, 1000, 2000, 4000, 8000]);
  });

  it("keeps only the speeds inside the data's range, ends included", () => {
    expect(shutterTicks([1 / 100, 1 / 3000]).map((s) => Math.round(1 / s))).toEqual([125, 250, 500, 1000, 2000]);
    expect(shutterTicks([1 / 125, 1 / 1000]).map((s) => Math.round(1 / s))).toEqual([125, 250, 500, 1000]);
  });

  it("falls back to every speed when fewer than two land in range", () => {
    expect(shutterTicks([1 / 400, 1 / 450])).toHaveLength(13);
    expect(shutterTicks([1 / 200, 1 / 300])).toHaveLength(13);
  });
});

describe("scatterPointsFor", () => {
  const point = (photoId: string, iso: number | null, aperture: number | null): ScatterPoint => ({
    focalLength: null,
    aperture,
    iso,
    shutterSeconds: null,
    shutterLabel: null,
    scientificName: "x",
    commonName: null,
    photoId,
  });

  it("keeps points with a value on both axes", () => {
    const points = [point("both", 400, 4), point("noIso", null, 4), point("noAperture", 400, null)];
    expect(scatterPointsFor(points, "iso", "aperture").map((p) => p.photoId)).toEqual(["both"]);
    expect(scatterPointsFor(points, "aperture", "aperture").map((p) => p.photoId)).toEqual(["both", "noIso"]);
  });
});

describe("headlineStats", () => {
  it("picks the top camera and the busiest focal length, hour and month", () => {
    const h = headlineStats(
      stats({
        gearUsage: {
          cameras: [
            { model: "First", photoCount: 2, speciesCount: 1 },
            { model: "Second", photoCount: 9, speciesCount: 1 },
          ],
          lenses: [],
          combos: [],
        },
        exifDistributions: {
          focalLength: [
            { label: "100mm", count: 1, photoIds: [] },
            { label: "400mm", count: 5, photoIds: [] },
          ],
          iso: [],
          aperture: [],
          shutter: [],
        },
        timeOfDay: [
          { hour: 6, label: "6 AM", count: 3 },
          { hour: 7, label: "7 AM", count: 3 },
          { hour: 8, label: "8 AM", count: 1 },
        ],
        perMonth: [
          { month: "2024-01", label: "Jan 2024", newLifers: 1, keepers: 9 },
          { month: "2024-02", label: "Feb 2024", newLifers: 4, keepers: 2 },
        ],
      }),
    );
    // The server sends cameras most used first.
    expect(h.topCamera?.model).toBe("First");
    expect(h.topFocalLength?.label).toBe("400mm");
    // A tie goes to the earlier hour.
    expect(h.busiestHour?.label).toBe("6 AM");
    expect(h.bestMonth?.label).toBe("Feb 2024");
  });

  it("has nothing to show for an empty library", () => {
    expect(headlineStats(stats({}))).toEqual({
      topCamera: undefined,
      topFocalLength: undefined,
      busiestHour: undefined,
      bestMonth: undefined,
    });
  });

  it("doesn't reorder the response's own lists", () => {
    const s = stats({
      timeOfDay: [
        { hour: 0, label: "12 AM", count: 1 },
        { hour: 1, label: "1 AM", count: 5 },
      ],
    });
    headlineStats(s);
    expect(s.timeOfDay.map((t) => t.hour)).toEqual([0, 1]);
  });
});

describe("percentOfKeepers", () => {
  it("rounds to a whole percent", () => {
    expect(percentOfKeepers(1, 3)).toBe(33);
    expect(percentOfKeepers(2, 3)).toBe(67);
    expect(percentOfKeepers(5, 5)).toBe(100);
  });
});

describe("gearRows", () => {
  const s = stats({
    gearUsage: {
      cameras: [{ model: "Body", photoCount: 3, speciesCount: 2 }],
      lenses: [{ model: "Glass", photoCount: 4, speciesCount: 1 }],
      combos: [{ camera: "Body", lens: "Glass", photoCount: 3, speciesCount: 1 }],
    },
  });

  it("labels cameras and lenses by model", () => {
    expect(gearRows(s, "cameras")).toEqual([{ label: "Body", photoCount: 3, speciesCount: 2 }]);
    expect(gearRows(s, "lenses")).toEqual([{ label: "Glass", photoCount: 4, speciesCount: 1 }]);
  });

  it("labels a combination with both", () => {
    expect(gearRows(s, "combos")).toEqual([{ label: "Body + Glass", photoCount: 3, speciesCount: 1 }]);
  });
});

describe("exifRows", () => {
  const s = stats({
    exifDistributions: {
      focalLength: [{ label: "400mm", count: 2, photoIds: ["a", "b"] }],
      iso: [{ label: "ISO 800", count: 1, photoIds: ["c"] }],
      aperture: [],
      shutter: [],
    },
    hitRateByFocalLength: [{ label: "400mm", species: 7 }],
  });

  it("charts photo counts for an EXIF field", () => {
    expect(exifRows(s, "iso")).toEqual({ key: "count", rows: s.exifDistributions.iso });
  });

  it("charts species for the hit rate", () => {
    expect(exifRows(s, "hitRate")).toEqual({ key: "species", rows: s.hitRateByFocalLength });
  });
});

describe("yearsPhotographed", () => {
  it("is empty before the portfolio loads", () => {
    expect(yearsPhotographed(null)).toEqual([]);
  });

  it("lists each year once, newest first, from both ends of every species' range", () => {
    const portfolio = {
      species: [
        species("a", { earliestTakenAt: "2021-06-01T12:00:00Z", latestTakenAt: "2024-06-01T12:00:00Z" }),
        species("b", { earliestTakenAt: "2022-06-01T12:00:00Z", latestTakenAt: "2022-07-01T12:00:00Z" }),
        species("c"),
      ],
    };
    expect(yearsPhotographed(portfolio)).toEqual([2024, 2022, 2021]);
  });
});

describe("portfolioHighlights", () => {
  it("is empty before the portfolio loads", () => {
    expect(portfolioHighlights(null)).toEqual({ mostPhotographed: [], oneAndDone: [], needsBetterPhoto: [] });
  });

  it("ranks the ten most photographed and finds the single-photo species", () => {
    const many = Array.from({ length: 12 }, (_, i) => species(`s${i}`, { totalPhotos: i + 1 }));
    const oneStar = species("oneStar", { totalPhotos: 1, bestRating: 1 });
    const unrated = species("unrated", { totalPhotos: 1 });
    const h = portfolioHighlights({ species: [...many, oneStar, unrated] });
    expect(h.mostPhotographed.map((s) => s.speciesId)).toEqual([
      "s11",
      "s10",
      "s9",
      "s8",
      "s7",
      "s6",
      "s5",
      "s4",
      "s3",
      "s2",
    ]);
    expect(h.oneAndDone.map((s) => s.speciesId)).toEqual(["s0", "oneStar", "unrated"]);
    expect(h.needsBetterPhoto.map((s) => s.speciesId)).toEqual(["oneStar"]);
  });
});

describe("statsCsvFilename", () => {
  // Early in the UTC day, so in the Americas the local date is still the day before.
  it("names the filter and the UTC date", () => {
    expect(statsCsvFilename("topRated", new Date("2024-05-17T02:00:00Z"))).toBe("lifer-stats-topRated-2024-05-17.csv");
  });
});
