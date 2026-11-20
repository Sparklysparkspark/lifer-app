import { describe, expect, it } from "vitest";
import {
  appearanceFromParams,
  shotTypeForSearch,
  anySelectedIn,
  appendNew,
  countActiveFilters,
  describeSearchReading,
  galleryCountText,
  galleryParams,
  effectiveGalleryGroupBy,
  groupGalleryItems,
  groupItemsByRegion,
  itemShotData,
  selectionHasRaw,
  selectionLocated,
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
    locationLabel: null,
    kind: "image",
    durationSeconds: null,
    tags: [],
    lifeStage: null,
    sex: null,
    plumage: null,
    morph: null,
    isFeatured: false,
    hasRawOriginal: false,
    inatStatus: null,
    inatObservationId: null,
    originalRef: null,
    originalManaged: null,
    originalKind: null,
    rawRef: null,
    taxonOrder: "Artiodactyla",
    family: "Cervidae",
    sortOrder: null,
    isOtherTaxa: false,
    inatIconicTaxon: null,
    tier: "common",
    localTier: null,
    cullVerdict: null,
    cullLabel: null,
    hidden: false,
    matchScore: null,
    ...partial,
  };
}

// The Gallery's defaults: no search or filters, photos only, no RAW.
const defaults: GalleryQuery = {
  searchQuery: "",
  onlyHidden: false,
  ratingMin: null,
  ratingMax: null,
  unrated: false,
  animalsMin: null,
  animalsMax: null,
  onlyFeatured: false,
  notOnInat: false,
  missingDate: false,
  missingCoordinates: false,
  shotActions: new Set(),
  shotFramings: new Set(),
  tiers: [],
  tierRegionId: null,
  selectedTaxa: new Set(),
  rawFiles: "show",
  editedRaw: "any",
  mediaFilter: "photos",
  dateFrom: "",
  dateTo: "",
  regionIds: [],
  tags: [],
  places: [],
  appearance: { lifeStage: [], sex: [], plumage: [], morph: [] },
  scopeTripId: null,
  scopeAlbumId: null,
  sortBy: "newest",
};

describe("galleryParams", () => {
  it("sends only the default presets by default", () => {
    expect(galleryParams(defaults).toString()).toBe("excludeVideo=1");
  });

  it("sends notOnInat and counts it as an active filter", () => {
    const q = { ...defaults, notOnInat: true };
    expect(galleryParams(q).get("notOnInat")).toBe("1");
    expect(countActiveFilters(q)).toBe(countActiveFilters(defaults) + 1);
  });

  it("sends every filter, in a fixed order", () => {
    const params = galleryParams({
      ...defaults,
      searchQuery: "owl flying",
      onlyHidden: true,
      ratingMin: 3,
      ratingMax: 4,
      onlyFeatured: true,
      missingDate: true,
      selectedTaxa: new Set(["aves", "insecta"]),
      editedRaw: "with",
      mediaFilter: "videos",
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      regionIds: ["r1", "r2"],
      tags: ["nest"],
      places: ["Pigeon Lake"],
      scopeTripId: "t1",
      scopeAlbumId: "a1",
    });
    expect(params.toString()).toBe(
      "q=owl+flying&hidden=1&ratingMin=3&ratingMax=4&onlyFeatured=1&missingDate=1&taxa=aves%2Cinsecta&onlyHasRaw=1&onlyVideo=1" +
        "&dateFrom=2024-01-01&dateTo=2024-12-31&regionId=r1&regionId=r2&tag=nest&place=Pigeon+Lake&tripId=t1&albumId=a1",
    );
  });

  it("sends no RAW or media filter for Any and Both", () => {
    expect(galleryParams({ ...defaults, rawFiles: "show", mediaFilter: "both" }).toString()).toBe("");
  });
});

describe("countActiveFilters", () => {
  it("counts nothing at the defaults, whatever the search or sort", () => {
    expect(countActiveFilters(defaults)).toBe(0);
    expect(countActiveFilters({ ...defaults, searchQuery: "owl", sortBy: "oldest" })).toBe(0);
  });

  it("counts a date range once, with one or both ends", () => {
    expect(countActiveFilters({ ...defaults, dateFrom: "2024-01-01" })).toBe(1);
    expect(countActiveFilters({ ...defaults, dateFrom: "2024-01-01", dateTo: "2024-02-01" })).toBe(1);
  });

  it("counts presets moved off their defaults", () => {
    expect(countActiveFilters({ ...defaults, rawFiles: "hide", editedRaw: "without", mediaFilter: "both" })).toBe(3);
  });

  it("counts each filter once", () => {
    expect(
      countActiveFilters({
        ...defaults,
        onlyHidden: true,
        ratingMin: 3,
        ratingMax: 4,
        onlyFeatured: true,
        missingDate: true,
        shotActions: new Set(["flying"]),
        shotFramings: new Set(["close"]),
        tiers: ["rare", "common"],
        selectedTaxa: new Set(["aves", "mammalia"]),
        dateTo: "2024-01-01",
        regionIds: ["r", "s"],
        tags: ["t"],
        scopeTripId: "trip",
        scopeAlbumId: "album",
      }),
    ).toBe(12);
  });
});

describe("appearance filter", () => {
  const appearance = { lifeStage: ["juvenile", "adult"], sex: ["male"], plumage: [], morph: ["Dark morph", "a, b"] };

  it("reads and writes the URL as repeated params, a morph with a comma kept whole", () => {
    const params = galleryParams({ ...defaults, appearance });
    expect(params.toString()).toBe(
      "excludeVideo=1&lifeStage=juvenile&lifeStage=adult&sex=male&morph=Dark+morph&morph=a%2C+b",
    );
    expect(appearanceFromParams(params)).toEqual(appearance);
    expect(appearanceFromParams(new URLSearchParams())).toEqual({ lifeStage: [], sex: [], plumage: [], morph: [] });
  });

  it("counts each kind with a value once", () => {
    expect(countActiveFilters({ ...defaults, appearance })).toBe(3);
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
  const none = { species: [], groups: [], scenes: [], places: [], dates: [], order: [], description: null };

  it("is null without an interpretation or anything beyond the query", () => {
    expect(describeSearchReading(undefined)).toBeNull();
    expect(describeSearchReading(none)).toBeNull();
    expect(describeSearchReading({ ...none, description: "swimming" })).toBeNull();
  });

  it("says how many animals after the subject", () => {
    const count = (c: { min: number; max: number | null; about: number | null; crowd: boolean }) =>
      describeSearchReading({ ...none, groups: ["birds"], count: c });
    expect(count({ min: 3, max: 3, about: null, crowd: false })).toBe("birds · 3 animals");
    expect(count({ min: 35, max: 70, about: 50, crowd: true })).toBe("birds · about 50 animals");
    expect(count({ min: 2, max: null, about: null, crowd: false })).toBe("birds · 2 or more animals");
    expect(count({ min: 30, max: null, about: null, crowd: true })).toBe("birds · a big crowd");
  });

  it("lists the subject, places and dates, then what it looks like", () => {
    expect(
      describeSearchReading({
        species: [],
        groups: ["ducks"],
        scenes: [],
        places: ["Washington"],
        dates: ["2024"],
        order: [],
        description: "swimming",
      }),
    ).toBe("ducks · Washington · 2024 · looks like “swimming”");
  });

  it("names three species and counts the rest", () => {
    expect(describeSearchReading({ ...none, species: ["A", "B", "C", "D", "E"], groups: ["owls"] })).toBe(
      "A, B, C, +2 more, owls",
    );
  });

  it("lists scene and colour words after the subject", () => {
    expect(describeSearchReading({ ...none, groups: ["ducks"], scenes: ["purple", "leaves"] })).toBe(
      "ducks · purple, leaves",
    );
  });

  it("skips an empty subject", () => {
    expect(describeSearchReading({ ...none, places: ["Yukon"] })).toBe("Yukon");
  });

  it("says filter, order and time words, styles, cameras and what was left out in plain words", () => {
    expect(
      describeSearchReading({
        ...none,
        groups: ["ducks"],
        readings: ["lifers", "sunset"],
        stars: { min: 4, max: null },
        excluded: ["mallards"],
      }),
    ).toBe("ducks · 4 or more stars · first photo of each species · around sunset · not mallards");
    expect(describeSearchReading({ ...none, styles: ["high key"], cameras: ["Canon EOS R5"] })).toBe(
      "high key · Canon EOS R5",
    );
    expect(describeSearchReading({ ...none, stars: { min: 5, max: 5 } })).toBe("5 stars");
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

  it("calls a selection of RAW-only photos RAWs", () => {
    const withRaws = [...items, item("r", { originalKind: "raw", hasRawOriginal: true })];
    expect(selectionNoun(withRaws, new Set(["c-r"]))).toBe("RAW");
    expect(selectionNoun(withRaws, new Set(["c-r", "c-p"]))).toBe("photo");
  });
});

describe("selectionHasRaw", () => {
  const items = [item("p"), item("r", { hasRawOriginal: true })];

  it("checks loaded photos and select-all's list of the rest", () => {
    expect(selectionHasRaw(items, new Set(["c-p"]), undefined)).toBe(false);
    expect(selectionHasRaw(items, new Set(["c-r"]), undefined)).toBe(true);
    // A RAW-only photo is its RAW: there's no separate one to offer deleting.
    const rawOnly = [item("o", { originalKind: "raw", hasRawOriginal: true })];
    expect(selectionHasRaw(rawOnly, new Set(["c-o"]), undefined)).toBe(false);
    expect(selectionHasRaw(items, new Set(["c-x"]), new Set(["c-x"]))).toBe(true);
    expect(selectionHasRaw(items, new Set(), new Set(["c-x"]))).toBe(false);
  });
});

describe("selectionLocated", () => {
  it("finds selected photos with coordinates, loaded or not", () => {
    const items = [item("a", { lat: "1", lon: "2" }), item("b"), item("c", { lat: "3", lon: "4" })];
    expect([...selectionLocated(items, new Set(["c-a", "c-b", "c-x"]), new Set(["c-x", "c-y"]))].sort()).toEqual([
      "c-a",
      "c-x",
    ]);
  });
});

describe("shotTypeForSearch", () => {
  const read = (q: string) => {
    const r = shotTypeForSearch(q);
    return r && { actions: [...r.actions], framings: [...r.framings] };
  };
  it("reads a search that only names a kind of shot as the axis it stands for", () => {
    expect(read("flight")).toEqual({ actions: ["flying"], framings: [] });
    expect(read("  Birds in Flight ")).toEqual({ actions: ["flying"], framings: [] });
    expect(read("portrait shots")).toEqual({ actions: [], framings: ["close"] });
    expect(read("behaviour")).toEqual({ actions: ["behavior"], framings: [] });
    expect(read("environmental")).toEqual({ actions: [], framings: ["environmental"] });
  });

  it("leaves anything more specific to the server's search", () => {
    expect(shotTypeForSearch("heron in flight")).toBeNull();
    expect(shotTypeForSearch("fli")).toBeNull();
  });
});

describe("galleryParams shot type", () => {
  it("writes the two axes in their own order, never the old shotKind", () => {
    const params = galleryParams({
      ...defaults,
      shotActions: new Set(["behavior", "flying"]),
      shotFramings: new Set(["environmental"]),
    });
    expect([params.get("action"), params.get("framing"), params.get("shotKind")]).toEqual([
      "flying,behavior",
      "environmental",
      null,
    ]);
  });
});

describe("groupGalleryItems", () => {
  const owl = { taxonClass: "aves", taxonOrder: "Strigiformes", family: "Strigidae" };
  const duck = { taxonClass: "aves", taxonOrder: "Anseriformes", family: "Anatidae" };
  const items = [
    item("a", { ...owl, tier: "rare", localTier: "common" }),
    item("b", { ...duck, tier: "common", localTier: null }),
    item("c", { ...owl, tier: "legendary", localTier: "rare" }),
    item("d", { tier: "occasional" }),
    item("e", { ...duck, tier: null }),
  ];
  const shape = (groupBy: Parameters<typeof groupGalleryItems>[1]) =>
    groupGalleryItems(items, groupBy)!.map((g) => [g.label, g.entries.map((e) => e.item.photoId).join("")]);
  const everyPhotoOnce = (groupBy: Parameters<typeof groupGalleryItems>[1]) =>
    expect(
      groupGalleryItems(items, groupBy)!
        .flatMap((g) => g.entries.map((e) => e.i))
        .sort(),
    ).toEqual([0, 1, 2, 3, 4]);

  it("is null when ungrouped", () => {
    expect(groupGalleryItems(items, "none")).toBeNull();
  });

  it("groups by first broad group and by family group in field-guide order, keeping photo order", () => {
    // Birds before mammals, and waterfowl lead the bird list, owls come later.
    expect(shape("broad")).toEqual([
      ["Waterfowl", "be"],
      ["Owls", "ac"],
      ["Hoofed Mammals", "d"],
    ]);
    expect(shape("group")).toEqual([
      ["Waterfowl", "be"],
      ["Owls", "ac"],
      ["Cervidae", "d"],
    ]);
    everyPhotoOnce("broad");
    everyPhotoOnce("group");
  });

  it("groups by tier rarest first, local tier falling back to the global one", () => {
    expect(shape("tier")).toEqual([
      ["Legendary", "c"],
      ["Rare", "a"],
      ["Occasional", "d"],
      ["Common", "be"],
    ]);
    expect(shape("localTier")).toEqual([
      ["Rare", "c"],
      ["Occasional", "d"],
      ["Common", "abe"],
    ]);
    everyPhotoOnce("tier");
    everyPhotoOnce("localTier");
  });

  it("keeps region grouping as it was", () => {
    const regioned = [item("a", { regionId: "y", regionName: "Yukon" }), item("b")];
    expect(groupGalleryItems(regioned, "region")).toEqual(groupItemsByRegion(regioned));
  });

  it("offers Rarity here only with a region filter", () => {
    expect(effectiveGalleryGroupBy("localTier", true)).toBe("localTier");
    expect(effectiveGalleryGroupBy("localTier", false)).toBe("tier");
    expect(effectiveGalleryGroupBy("region", false)).toBe("region");
  });
});
