import { describe, expect, it } from "vitest";
import { buildPreview, planEdits, plannedAlbums, type Group } from "./plan.js";
import type { ChangeSet, PhotoChange } from "./types.js";

const photo = (over: Partial<PhotoChange>): PhotoChange => ({
  captureId: "c1",
  path: "/p/a.jpg",
  rating: null,
  flag: null,
  label: null,
  keywords: [],
  keywordPaths: [],
  caption: null,
  lat: null,
  lon: null,
  takenAt: null,
  current: { rating: null, flag: null, lat: null, lon: null, tags: [] },
  ...over,
});
const set = (photos: PhotoChange[], over: Partial<ChangeSet> = {}): ChangeSet => ({
  photos,
  albums: [],
  unmapped: [],
  notInLifer: [],
  total: photos.length,
  ...over,
});
const all = new Set<Group>(["ratings", "flags", "keywords", "locations", "albums", "smartAlbums"]);

describe("planEdits", () => {
  it("fills what Lifer lacks and keeps what Lifer has", () => {
    const cs = set([
      photo({ captureId: "a", rating: 4 }),
      photo({
        captureId: "b",
        rating: 4,
        current: { rating: 2, flag: null, lat: null, lon: null, tags: [] },
      }),
    ]);
    expect(planEdits(cs, all, false)).toEqual([{ id: "a", rating: 4 }]);
    expect(planEdits(cs, all, true).map((e) => e.id)).toEqual(["a", "b"]);
  });

  it("adds only new keywords, ignoring case, and leaves out groups that are off", () => {
    const cs = set([
      photo({
        keywords: ["Heron", "heron", "Pond"],
        rating: 5,
        current: { rating: null, flag: null, lat: null, lon: null, tags: ["pond"] },
      }),
    ]);
    expect(planEdits(cs, new Set<Group>(["keywords"]), false)).toEqual([{ id: "c1", tags: ["pond", "Heron"] }]);
  });

  it("treats a point within about 100 m as the same place", () => {
    const near = photo({
      lat: 49.0005,
      lon: -123,
      current: { rating: null, flag: null, lat: 49, lon: -123, tags: [] },
    });
    expect(planEdits(set([near]), all, true)).toEqual([]);
  });

  it("skips photos that are not in Lifer and writes a capture once", () => {
    const cs = set([photo({ captureId: null, current: null, rating: 3 }), photo({ rating: 3 }), photo({ rating: 3 })]);
    expect(planEdits(cs, all, false)).toHaveLength(1);
  });
});

describe("buildPreview", () => {
  it("counts conflicts apart from changes and reports what has nowhere to go", () => {
    const cs = set(
      [
        photo({ captureId: "a", rating: 4, label: "Red", caption: "x" }),
        photo({ captureId: "b", rating: 4, current: { rating: 2, flag: null, lat: null, lon: null, tags: [] } }),
        photo({ captureId: null, current: null, path: "/p/new.jpg" }),
      ],
      { notInLifer: ["/p/new.jpg"] },
    );
    const preview = buildPreview(cs);
    expect(preview.matched).toBe(2);
    expect(preview.notInLifer).toBe(1);
    expect(preview.groups[0]).toMatchObject({ group: "ratings", total: 2, willChange: 1, conflicts: 1 });
    expect(preview.leftOut).toEqual({ labels: 1, captions: 1 });
  });
});

describe("plannedAlbums", () => {
  it("follows the album and smart album switches", () => {
    const cs = set([], {
      albums: [
        { name: "A", path: [], captureIds: ["x"], missing: 0, rules: null },
        { name: "B", path: [], captureIds: [], missing: 0, rules: { version: 2, query: {} } },
      ],
    });
    expect(plannedAlbums(cs, new Set<Group>(["smartAlbums"])).map((a) => a.name)).toEqual(["B"]);
    expect(plannedAlbums(cs, new Set<Group>(["albums"])).map((a) => a.name)).toEqual(["A"]);
  });
});
