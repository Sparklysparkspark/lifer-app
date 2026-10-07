import { describe, expect, it } from "vitest";
import {
  countPhotoFilters,
  matchesMediaFilter,
  matchesPhotoFilters,
  sortPhotos,
  type PhotoFilters,
} from "./photoListFilters";

const none: PhotoFilters = { rawFilter: "any", onlyTopRated: false, dateFrom: "", dateTo: "" };

function photo(id: string, takenAt: string | null, qualityRating: number | null = null) {
  return { id, takenAt, qualityRating };
}

describe("matchesPhotoFilters", () => {
  it("passes everything with no filters", () => {
    expect(matchesPhotoFilters(photo("a", null), true, none)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null), false, none)).toBe(true);
  });

  it("filters on whether the photo has a RAW", () => {
    expect(matchesPhotoFilters(photo("a", null), true, { ...none, rawFilter: "with" })).toBe(true);
    expect(matchesPhotoFilters(photo("a", null), false, { ...none, rawFilter: "with" })).toBe(false);
    expect(matchesPhotoFilters(photo("a", null), true, { ...none, rawFilter: "without" })).toBe(false);
    expect(matchesPhotoFilters(photo("a", null), false, { ...none, rawFilter: "without" })).toBe(true);
  });

  it("keeps only 5-star photos when top rated is on", () => {
    const topRated = { ...none, onlyTopRated: true };
    expect(matchesPhotoFilters(photo("a", null, 5), false, topRated)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null, 4), false, topRated)).toBe(false);
    expect(matchesPhotoFilters(photo("a", null, null), false, topRated)).toBe(false);
  });

  it("includes both ends of the date range, the whole last day", () => {
    const range = { ...none, dateFrom: "2024-05-01", dateTo: "2024-05-31" };
    expect(matchesPhotoFilters(photo("a", "2024-04-30T23:59:59Z"), false, range)).toBe(false);
    expect(matchesPhotoFilters(photo("a", "2024-05-01T00:00:00Z"), false, range)).toBe(true);
    expect(matchesPhotoFilters(photo("a", "2024-05-31T23:00:00Z"), false, range)).toBe(true);
    expect(matchesPhotoFilters(photo("a", "2024-06-01T00:00:00Z"), false, range)).toBe(false);
  });

  it("lets an undated photo through a date range", () => {
    expect(
      matchesPhotoFilters(photo("a", null), false, { ...none, dateFrom: "2024-05-01", dateTo: "2024-05-31" }),
    ).toBe(true);
  });
});

describe("matchesMediaFilter", () => {
  it("keeps photos, videos or both", () => {
    expect(matchesMediaFilter("image", "photos")).toBe(true);
    expect(matchesMediaFilter("video", "photos")).toBe(false);
    expect(matchesMediaFilter("image", "videos")).toBe(false);
    expect(matchesMediaFilter("video", "videos")).toBe(true);
    expect(matchesMediaFilter("image", "both")).toBe(true);
    expect(matchesMediaFilter("video", "both")).toBe(true);
  });

  it("treats an unknown kind as a photo", () => {
    expect(matchesMediaFilter(undefined, "photos")).toBe(true);
    expect(matchesMediaFilter(undefined, "videos")).toBe(false);
  });
});

describe("sortPhotos", () => {
  const photos = [
    photo("mid", "2023-01-01T00:00:00Z", 4),
    photo("old", "2020-01-01T00:00:00Z", null),
    photo("new", "2024-01-01T00:00:00Z", 1),
    photo("undated", null, 5),
  ];
  const ids = (list: typeof photos) => list.map((p) => p.id);

  it("leaves the server's order (and the same array) for newest", () => {
    expect(sortPhotos(photos, "newest")).toBe(photos);
  });

  it("sorts oldest first, undated first of all", () => {
    expect(ids(sortPhotos(photos, "oldest"))).toEqual(["undated", "old", "mid", "new"]);
  });

  it("sorts by rating either way, unrated as a 3", () => {
    expect(ids(sortPhotos(photos, "ratingHigh"))).toEqual(["undated", "mid", "old", "new"]);
    expect(ids(sortPhotos(photos, "ratingLow"))).toEqual(["new", "old", "mid", "undated"]);
  });

  it("doesn't reorder the array it was given", () => {
    sortPhotos(photos, "oldest");
    expect(ids(photos)).toEqual(["mid", "old", "new", "undated"]);
  });
});

describe("countPhotoFilters", () => {
  it("counts nothing at the defaults", () => {
    expect(countPhotoFilters({ ...none, rawFilter: "without" })).toBe(0);
  });

  it("counts each filter off its default once", () => {
    expect(countPhotoFilters(none)).toBe(1);
    expect(countPhotoFilters({ ...none, onlyTopRated: true, dateFrom: "2024-01-01", dateTo: "2024-02-01" })).toBe(3);
    expect(countPhotoFilters({ ...none, rawFilter: "with", dateTo: "2024-02-01" })).toBe(2);
  });
});
