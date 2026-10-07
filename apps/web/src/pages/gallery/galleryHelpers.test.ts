import { describe, expect, it } from "vitest";
import {
  anySelectedIn,
  appendNew,
  countActiveFilters,
  describeSearchReading,
  galleryCountText,
  galleryParams,
  groupItemsByRegion,
  itemShotData,
  selectionHasRaw,
  selectionNoun,
  toggleInSet,
  UNKNOWN_REGION_GROUP_KEY,
  withFeatured,
} from "./galleryHelpers";
import type { GalleryItem, GalleryQuery } from "./types";

function item(photoId: string, partial: Partial<GalleryItem> = {}): GalleryItem {
  return {
    photoId,
    width: null,
    height: null,
    captureId: `c-${photoId}`,
    speciesId: "moose",
    scientificName: "Alces alces",
    commonName: "Moose",
    taxonClass: "mammalia",
    takenAt: null,
    cameraModel: null,
    lens: null,
    focalLengthMm: null,
    aperture: null,
    shutter: null,
    iso: null,
    qualityRating: null,
    lat: null,
    lon: null,
    regionId: null,
    regionName: null,
    kind: "image",
    durationSeconds: null,
    tags: [],
    isFeatured: false,
    hasRawOriginal: false,
    originalRef: null,
    originalManaged: null,
    originalKind: null,
    rawRef: null,
    ...partial,
  };
}

// The Gallery's defaults: no search or filters, photos only, no RAW.
const defaults: GalleryQuery = {
  searchQuery: "",
  onlyHidden: false,
  onlyTopRated: false,
  onlyFeatured: false,
  missingDate: false,
  selectedTaxa: new Set(),
  rawFilter: "without",
  mediaFilter: "photos",
  dateFrom: "",
  dateTo: "",
  regionId: null,
  tag: null,
  scopeTripId: null,
  scopeAlbumId: null,
  sortBy: "newest",
};

describe("galleryParams", () => {
  it("sends only the default presets by default", () => {
    expect(galleryParams(defaults).toString()).toBe("excludeHasRaw=1&excludeVideo=1");
  });

  it("sends every filter, in a fixed order", () => {
    const params = galleryParams({
      ...defaults,
      searchQuery: "owl flying",
      onlyHidden: true,
      onlyTopRated: true,
      onlyFeatured: true,
      missingDate: true,
      selectedTaxa: new Set(["aves", "insecta"]),
      rawFilter: "with",
      mediaFilter: "videos",
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      regionId: "r1",
      tag: "nest",
      scopeTripId: "t1",
      scopeAlbumId: "a1",
    });
    expect(params.toString()).toBe(
      "q=owl+flying&hidden=1&onlyTopRated=1&onlyFeatured=1&missingDate=1&taxa=aves%2Cinsecta&onlyHasRaw=1&onlyVideo=1" +
        "&dateFrom=2024-01-01&dateTo=2024-12-31&regionId=r1&tag=nest&tripId=t1&albumId=a1",
    );
  });

  it("sends no RAW or media filter for Any and Both", () => {
    expect(galleryParams({ ...defaults, rawFilter: "any", mediaFilter: "both" }).toString()).toBe("");
  });
});

describe("countActiveFilters", () => {
  it("counts nothing at the defaults, whatever the search or missing-date view", () => {
    expect(countActiveFilters(defaults)).toBe(0);
    expect(countActiveFilters({ ...defaults, searchQuery: "owl", missingDate: true, sortBy: "oldest" })).toBe(0);
  });

  it("counts a date range once, with one or both ends", () => {
    expect(countActiveFilters({ ...defaults, dateFrom: "2024-01-01" })).toBe(1);
    expect(countActiveFilters({ ...defaults, dateFrom: "2024-01-01", dateTo: "2024-02-01" })).toBe(1);
  });

  it("counts presets moved off their defaults", () => {
    expect(countActiveFilters({ ...defaults, rawFilter: "any", mediaFilter: "both" })).toBe(2);
  });

  it("counts each filter once", () => {
    expect(
      countActiveFilters({
        ...defaults,
        onlyHidden: true,
        onlyTopRated: true,
        onlyFeatured: true,
        selectedTaxa: new Set(["aves", "mammalia"]),
        dateTo: "2024-01-01",
        regionId: "r",
        tag: "t",
        scopeTripId: "trip",
        scopeAlbumId: "album",
      }),
    ).toBe(9);
  });
});

describe("appendNew", () => {
  it("adds only photos not already there", () => {
    const prev = [item("a"), item("b")];
    expect(appendNew(prev, [item("b"), item("c")]).map((i) => i.photoId)).toEqual(["a", "b", "c"]);
  });

  it("returns the same array when nothing is new", () => {
    const prev = [item("a")];
    expect(appendNew(prev, [])).toBe(prev);
    expect(appendNew(prev, [item("a")])).toBe(prev);
  });
});

describe("anySelectedIn", () => {
  it("is true when any id is selected", () => {
    expect(anySelectedIn(new Set(["a", "b"]), new Set(["b"]))).toBe(true);
    expect(anySelectedIn(new Set(["a"]), new Set(["b"]))).toBe(false);
    expect(anySelectedIn(undefined, new Set(["b"]))).toBe(false);
  });
});

describe("toggleInSet", () => {
  it("adds a missing value and removes a present one, leaving the original alone", () => {
    const start = new Set(["a"]);
    expect([...toggleInSet(start, "b")]).toEqual(["a", "b"]);
    expect([...toggleInSet(start, "a")]).toEqual([]);
    expect([...start]).toEqual(["a"]);
  });
});

describe("describeSearchReading", () => {
  const none = { species: [], groups: [], places: [], dates: [], description: null };

  it("is null without an interpretation or anything beyond the query", () => {
    expect(describeSearchReading(undefined)).toBeNull();
    expect(describeSearchReading(none)).toBeNull();
    expect(describeSearchReading({ ...none, description: "swimming" })).toBeNull();
  });

  it("lists the subject, places and dates, then what it looks like", () => {
    expect(
      describeSearchReading({
        species: [],
        groups: ["ducks"],
        places: ["Washington"],
        dates: ["2024"],
        description: "swimming",
      }),
    ).toBe("ducks · Washington · 2024 · looks like “swimming”");
  });

  it("names three species and counts the rest", () => {
    expect(describeSearchReading({ ...none, species: ["A", "B", "C", "D", "E"], groups: ["owls"] })).toBe(
      "A, B, C, +2 more, owls",
    );
  });

  it("skips an empty subject", () => {
    expect(describeSearchReading({ ...none, places: ["Yukon"] })).toBe("Yukon");
  });
});

describe("itemShotData", () => {
  it("passes the photo's camera settings through", () => {
    expect(itemShotData(item("a"))).toBeNull();
    expect(itemShotData(item("a", { iso: 800, aperture: 5.6 }))).toContain("800");
  });
});

describe("groupItemsByRegion", () => {
  it("groups alphabetically, keeps each photo's index, and pools photos with no region", () => {
    const items = [
      item("a", { regionId: "y", regionName: "Yukon" }),
      // A name without a region id is a leftover, not a region.
      item("b", { regionName: "Stale" }),
      item("c", { regionId: "bc", regionName: "British Columbia" }),
      item("d", { regionId: "y", regionName: "Yukon" }),
    ];
    const groups = groupItemsByRegion(items);
    expect(groups.map((g) => g.label)).toEqual(["British Columbia", "Unknown region", "Yukon"]);
    expect(groups[2].entries.map((e) => [e.item.photoId, e.i])).toEqual([
      ["a", 0],
      ["d", 3],
    ]);
    expect(groups.flatMap((g) => g.entries.map((e) => e.item.photoId)).sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("pools regions with no name into the one Unknown region group, with unique keys", () => {
    const items = [
      item("a", { regionId: "r1", regionName: null }),
      item("b"),
      item("c", { regionId: "r2", regionName: "  " }),
      item("d", { regionId: "y", regionName: "Yukon" }),
      // Same name, different region: still two groups, told apart by key.
      item("e", { regionId: "y2", regionName: "Yukon" }),
    ];
    const groups = groupItemsByRegion(items);
    expect(groups.map((g) => [g.key, g.label])).toEqual([
      [UNKNOWN_REGION_GROUP_KEY, "Unknown region"],
      ["y", "Yukon"],
      ["y2", "Yukon"],
    ]);
    expect(groups[0].entries.map((e) => [e.item.photoId, e.i])).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
    expect(new Set(groups.map((g) => g.key)).size).toBe(groups.length);
  });
});

describe("withFeatured", () => {
  const items = [
    item("old", { isFeatured: true }),
    item("new"),
    item("bird", { speciesId: "chickadee", isFeatured: true }),
  ];
  const featured = (list: GalleryItem[]) => list.filter((i) => i.isFeatured).map((i) => i.photoId);

  it("features the photo and unfeatures its species' others", () => {
    expect(featured(withFeatured(items, items[1], true))).toEqual(["new", "bird"]);
  });

  it("unfeatures just the photo", () => {
    expect(featured(withFeatured(items, items[0], false))).toEqual(["bird"]);
    expect(featured(withFeatured(items, items[1], false))).toEqual(["old", "bird"]);
  });

  it("leaves other species' photos as they were", () => {
    expect(withFeatured(items, items[1], true)[2]).toBe(items[2]);
  });
});

describe("galleryCountText", () => {
  const base = {
    missingDate: false,
    loadedCount: 3,
    nextCursor: null,
    total: null,
    searchQuery: "",
    searchReading: null,
  };

  it("counts a fully loaded listing", () => {
    expect(galleryCountText(base)).toBe("3 photos");
    expect(galleryCountText({ ...base, loadedCount: 1 })).toBe("1 photo");
  });

  it("gives the total while more pages are coming, or says more are", () => {
    expect(galleryCountText({ ...base, nextCursor: "c", total: 500 })).toBe("500 photos");
    expect(galleryCountText({ ...base, nextCursor: "c" })).toBe("3 photos loaded, more as you scroll");
  });

  it("names the search and how it was read", () => {
    expect(galleryCountText({ ...base, searchQuery: "owl" })).toBe('3 photos matching "owl"');
    expect(galleryCountText({ ...base, searchQuery: "owl", searchReading: "owls · 2024" })).toBe(
      '3 photos matching "owl": owls · 2024',
    );
    expect(galleryCountText({ ...base, searchReading: "stale" })).toBe("3 photos");
  });

  it("frames the missing-date view as a to-do list", () => {
    expect(galleryCountText({ ...base, missingDate: true })).toBe("3 photos missing a date. Pick one below to fix it");
    expect(galleryCountText({ ...base, missingDate: true, nextCursor: "c", total: 9 })).toBe(
      "At least 3 photos missing a date. Pick one below to fix it",
    );
  });
});

describe("selectionNoun", () => {
  const items = [item("p"), item("v", { kind: "video" })];

  it("names the selection by what's in it", () => {
    expect(selectionNoun(items, new Set(["c-p"]))).toBe("photo");
    expect(selectionNoun(items, new Set(["c-v"]))).toBe("video");
    expect(selectionNoun(items, new Set(["c-p", "c-v"]))).toBe("file");
  });

  it("counts selected videos that aren't loaded yet", () => {
    expect(selectionNoun(items, new Set(["c-unloaded"]), ["c-unloaded"])).toBe("video");
    expect(selectionNoun(items, new Set(["c-p", "c-unloaded"]), ["c-unloaded", "c-other"])).toBe("file");
    expect(selectionNoun(items, new Set(["c-p"]), ["c-unloaded"])).toBe("photo");
  });
});

describe("selectionHasRaw", () => {
  const items = [item("p"), item("r", { hasRawOriginal: true })];

  it("checks loaded photos and select-all's list of the rest", () => {
    expect(selectionHasRaw(items, new Set(["c-p"]), undefined)).toBe(false);
    expect(selectionHasRaw(items, new Set(["c-r"]), undefined)).toBe(true);
    expect(selectionHasRaw(items, new Set(["c-x"]), new Set(["c-x"]))).toBe(true);
    expect(selectionHasRaw(items, new Set(), new Set(["c-x"]))).toBe(false);
  });
});
