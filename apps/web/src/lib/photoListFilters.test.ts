import { describe, expect, it } from "vitest";
import {
  countPhotoFilters,
  matchesMediaFilter,
  matchesPhotoFilters,
  sortPhotos,
  type PhotoFilters,
} from "./photoListFilters";

const none: PhotoFilters = { rawFiles: "show", editedRaw: "any", onlyTopRated: false, dateFrom: "", dateTo: "" };
const EDITED = { hasRaw: false, rawOnly: false };
const EDITED_WITH_RAW = { hasRaw: true, rawOnly: false };
const RAW_ONLY = { hasRaw: true, rawOnly: true };

function photo(id: string, takenAt: string | null, qualityRating: number | null = null) {
  return { id, takenAt, qualityRating };
}

describe("matchesPhotoFilters", () => {
  it("passes everything with no filters", () => {
    for (const raw of [EDITED, EDITED_WITH_RAW, RAW_ONLY])
      expect(matchesPhotoFilters(photo("a", null), raw, none)).toBe(true);
  });

  it("shows, hides or keeps only the RAW-only photos", () => {
    const hide = { ...none, rawFiles: "hide" as const };
    const only = { ...none, rawFiles: "only" as const };
    expect(matchesPhotoFilters(photo("a", null), RAW_ONLY, hide)).toBe(false);
    expect(matchesPhotoFilters(photo("a", null), EDITED_WITH_RAW, hide)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null), RAW_ONLY, only)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null), EDITED_WITH_RAW, only)).toBe(false);
  });

  it("filters edited photos on whether their RAW came with them, and never a RAW-only one", () => {
    const withRaw = { ...none, editedRaw: "with" as const };
    const withoutRaw = { ...none, editedRaw: "without" as const };
    expect(matchesPhotoFilters(photo("a", null), EDITED_WITH_RAW, withRaw)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null), EDITED, withRaw)).toBe(false);
    expect(matchesPhotoFilters(photo("a", null), EDITED_WITH_RAW, withoutRaw)).toBe(false);
    expect(matchesPhotoFilters(photo("a", null), EDITED, withoutRaw)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null), RAW_ONLY, withoutRaw)).toBe(true);
  });

  it("keeps only 5-star photos when top rated is on", () => {
    const topRated = { ...none, onlyTopRated: true };
    expect(matchesPhotoFilters(photo("a", null, 5), EDITED, topRated)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null, 4), EDITED, topRated)).toBe(false);
    expect(matchesPhotoFilters(photo("a", null, null), EDITED, topRated)).toBe(false);
  });

  it("includes both ends of the date range, the whole last day", () => {
    const range = { ...none, dateFrom: "2024-05-01", dateTo: "2024-05-31" };
    expect(matchesPhotoFilters(photo("a", "2024-04-30T23:59:59Z"), EDITED, range)).toBe(false);
    expect(matchesPhotoFilters(photo("a", "2024-05-01T00:00:00Z"), EDITED, range)).toBe(true);
    expect(matchesPhotoFilters(photo("a", "2024-05-31T23:00:00Z"), EDITED, range)).toBe(true);
    expect(matchesPhotoFilters(photo("a", "2024-06-01T00:00:00Z"), EDITED, range)).toBe(false);
  });

  it("lets an undated photo through a date range", () => {
    expect(
      matchesPhotoFilters(photo("a", null), EDITED, { ...none, dateFrom: "2024-05-01", dateTo: "2024-05-31" }),
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
    expect(countPhotoFilters({ ...none, rawFiles: "hide" })).toBe(0);
  });

  it("counts each filter off its default once", () => {
    const defaults = { ...none, rawFiles: "hide" as const };
    expect(countPhotoFilters({ ...defaults, onlyTopRated: true, dateFrom: "2024-01-01", dateTo: "2024-02-01" })).toBe(
      2,
    );
    expect(countPhotoFilters({ ...defaults, rawFiles: "show", editedRaw: "with", dateTo: "2024-02-01" })).toBe(3);
  });
});
