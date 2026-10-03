import { describe, expect, it } from "vitest";
import {
  derivePaletteContext,
  filterEntries,
  flattenGroups,
  moveHighlight,
  pushRecentQuery,
  resolveHighlight,
  speciesPath,
  galleryPresetParams,
  galleryScopePath,
  type PaletteGroup,
} from "./palette";

const REGION = "3f2b1c4d-0000-4000-8000-000000000001";

describe("derivePaletteContext", () => {
  it("reads the collection region", () => {
    expect(derivePaletteContext("/", `?region=${REGION}&sort=name`)).toEqual({ regionId: REGION, scope: null });
  });
  it("reads a species page's regionId", () => {
    expect(derivePaletteContext("/species/abc", `?regionId=${REGION}`).regionId).toBe(REGION);
  });
  it("ignores region params on other pages and junk values", () => {
    expect(derivePaletteContext("/gallery", `?region=${REGION}`).regionId).toBeNull();
    expect(derivePaletteContext("/", "?region=<script>").regionId).toBeNull();
  });
  it("finds a trip or album scope", () => {
    expect(derivePaletteContext("/trips/t1", "").scope).toEqual({ kind: "trip", id: "t1" });
    expect(derivePaletteContext("/albums/a1/", "").scope).toEqual({ kind: "album", id: "a1" });
    expect(derivePaletteContext("/albums", "").scope).toBeNull();
  });
});

describe("speciesPath", () => {
  it("keeps the region", () => {
    expect(speciesPath("s1", REGION)).toBe(`/species/s1?regionId=${REGION}`);
    expect(speciesPath("s1", null)).toBe("/species/s1");
  });
});

describe("pushRecentQuery", () => {
  it("dedupes, puts newest first and caps", () => {
    expect(pushRecentQuery(["owl", "Heron"], "heron")).toEqual(["heron", "owl"]);
    expect(pushRecentQuery(["a", "b", "c"], "d", 3)).toEqual(["d", "a", "b"]);
    expect(pushRecentQuery(["a"], "  ")).toEqual(["a"]);
  });
});

describe("flattenGroups and highlight", () => {
  const item = (id: string) => ({ id, label: id, action: { type: "navigate" as const, to: "/" } });
  const groups: PaletteGroup[] = [
    { id: "species", title: "Species", items: [item("s1"), item("s2")] },
    { id: "photos", title: "Photos", items: [] },
    { id: "regions", title: "Regions", items: [item("r1")] },
  ];

  it("drops empty groups and flattens in order", () => {
    const flat = flattenGroups(groups);
    expect(flat.groups.map((g) => g.id)).toEqual(["species", "regions"]);
    expect(flat.items.map((i) => i.id)).toEqual(["s1", "s2", "r1"]);
  });

  it("wraps across groups", () => {
    expect(moveHighlight(2, 1, 3)).toBe(0);
    expect(moveHighlight(0, -1, 3)).toBe(2);
    expect(moveHighlight(-1, 1, 3)).toBe(0);
    expect(moveHighlight(0, 1, 0)).toBe(-1);
  });

  it("keeps the highlighted item across a refresh", () => {
    const { items } = flattenGroups(groups);
    expect(resolveHighlight(items, "r1")).toBe(2);
    expect(resolveHighlight(items, "gone")).toBe(0);
    expect(resolveHighlight([], "r1")).toBe(-1);
  });
});

describe("filterEntries", () => {
  it("matches keywords and strips them from the result", () => {
    const res = filterEntries([{ id: "x", label: "Trash", keywords: ["deleted"], action: { type: "navigate", to: "/trash" } }], "delet", 5);
    expect(res).toEqual([{ id: "x", label: "Trash", action: { type: "navigate", to: "/trash" } }]);
  });
});

describe("galleryPresetParams", () => {
  it("mirrors the Gallery's RAW and media presets", () => {
    expect(galleryPresetParams("without", "photos")).toEqual({ excludeHasRaw: "1", excludeVideo: "1" });
    expect(galleryPresetParams("with", "videos")).toEqual({ onlyHasRaw: "1", onlyVideo: "1" });
    expect(galleryPresetParams("any", "both")).toEqual({});
  });
});

describe("galleryScopePath", () => {
  it("uses tripId for trips and inAlbum for albums", () => {
    expect(galleryScopePath({ kind: "trip", id: "t1" }, "owl")).toBe("/gallery?tripId=t1&q=owl");
    expect(galleryScopePath({ kind: "album", id: "a1" }, "")).toBe("/gallery?inAlbum=a1");
  });
});
