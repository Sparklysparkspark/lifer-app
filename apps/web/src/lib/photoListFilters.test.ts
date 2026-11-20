import { describe, expect, it } from "vitest";
import { matchesMediaFilter, matchesPhotoFilters, sortPhotos, type PhotoFilters } from "./photoListFilters";

const none: PhotoFilters = {
  rawFiles: "show",
  editedRaw: "any",
  ratingMin: null,
  ratingMax: null,
  unrated: false,
  missingDate: false,
  dateFrom: "",
  dateTo: "",
};
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

  it("keeps a star range, both ends inclusive, and never an unrated photo in it", () => {
    const range = { ...none, ratingMin: 3, ratingMax: 4 };
    expect(matchesPhotoFilters(photo("a", null, 3), EDITED, range)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null, 4), EDITED, range)).toBe(true);
    expect(matchesPhotoFilters(photo("a", null, 5), EDITED, range)).toBe(false);
    expect(matchesPhotoFilters(photo("a", null, null), EDITED, range)).toBe(false);
  });

  it("keeps only unrated photos, or only undated ones", () => {
    expect(matchesPhotoFilters(photo("a", null, null), EDITED, { ...none, unrated: true })).toBe(true);
    expect(matchesPhotoFilters(photo("a", null, 2), EDITED, { ...none, unrated: true })).toBe(false);
    expect(matchesPhotoFilters(photo("a", null), EDITED, { ...none, missingDate: true })).toBe(true);
    expect(matchesPhotoFilters(photo("a", "2024-05-01T00:00:00Z"), EDITED, { ...none, missingDate: true })).toBe(false);
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
    expect(matchesMediaFilter("audio", "photos")).toBe(false);
    expect(matchesMediaFilter("audio", "recordings")).toBe(true);
    expect(matchesMediaFilter("image", "recordings")).toBe(false);
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

describe("sortPhotos species orders", () => {
  const sp = (id: string, takenAt: string | null, fields: Record<string, unknown>) => ({ id, takenAt, ...fields });
  const duck = {
    commonName: "Mallard",
    scientificName: "Anas platyrhynchos",
    taxonClass: "aves",
    taxonOrder: "Anseriformes",
    tier: "common",
  };
  const owl = {
    commonName: "Barn Owl",
    scientificName: "Tyto alba",
    taxonClass: "aves",
    taxonOrder: "Strigiformes",
    tier: "rare",
  };
  const moose = {
    commonName: "Moose",
    scientificName: "Alces alces",
    taxonClass: "mammalia",
    taxonOrder: "Artiodactyla",
    tier: null,
  };
  const photos = [
    sp("moose", "2024-01-01T00:00:00Z", moose),
    sp("owl-old", "2020-01-01T00:00:00Z", owl),
    sp("duck", "2022-01-01T00:00:00Z", duck),
    sp("owl-undated", null, owl),
    sp("owl-new", "2023-01-01T00:00:00Z", owl),
  ];
  const ids = (list: typeof photos) => list.map((p) => p.id);

  it("orders by species, newest first within one", () => {
    expect(ids(sortPhotos(photos, "taxonomic"))).toEqual(["duck", "owl-new", "owl-old", "owl-undated", "moose"]);
    expect(ids(sortPhotos(photos, "name"))).toEqual(["owl-new", "owl-old", "owl-undated", "duck", "moose"]);
    expect(ids(sortPhotos(photos, "scientific"))).toEqual(["moose", "duck", "owl-new", "owl-old", "owl-undated"]);
    expect(ids(sortPhotos(photos, "rarity"))).toEqual(["owl-new", "owl-old", "owl-undated", "duck", "moose"]);
  });
});
