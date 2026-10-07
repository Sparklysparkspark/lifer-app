import { describe, expect, it } from "vitest";
import type { CollectionItem } from "@lifer/shared";
import {
  RECENT_SYNC_MS,
  SYNC_INTERVAL_MS,
  isSyncDue,
  planThumbs,
  squareCrop,
  syncOfflineCache,
  thumbKey,
  thumbSource,
  toCacheItems,
  type SyncStart,
} from "./offlineCache";

function item(
  id: string,
  state: CollectionItem["state"],
  coverPhotoUrl: string | null,
  extra: Partial<CollectionItem> = {},
) {
  return {
    speciesId: id,
    scientificName: `Species ${id}`,
    commonName: `Common ${id}`,
    taxonClass: "aves",
    family: "Turdidae",
    state,
    coverPhotoUrl,
    cardCropX: null,
    cardCropY: null,
    cardCropSize: null,
    referenceFocalX: null,
    referenceFocalY: null,
    ...extra,
  } as CollectionItem;
}

describe("isSyncDue", () => {
  const now = 1_000_000_000;
  it("syncs when never synced", () => {
    expect(isSyncDue(null, now, false)).toBe(true);
  });
  it("syncs on page load unless one just finished", () => {
    expect(isSyncDue(now - RECENT_SYNC_MS + 1, now, true)).toBe(false);
    expect(isSyncDue(now - RECENT_SYNC_MS, now, true)).toBe(true);
  });
  it("syncs every half hour after that", () => {
    expect(isSyncDue(now - RECENT_SYNC_MS, now, false)).toBe(false);
    expect(isSyncDue(now - SYNC_INTERVAL_MS, now, false)).toBe(true);
  });
  it("treats a clock that went backwards as stale", () => {
    expect(isSyncDue(now + 60_000, now, false)).toBe(true);
  });
});

describe("thumbSource and thumbKey", () => {
  it("only uses the server's own thumbnails", () => {
    expect(thumbSource({ coverPhotoUrl: "/api/photos/1/thumb" })).toBe("/api/photos/1/thumb");
    expect(thumbSource({ coverPhotoUrl: "https://inaturalist-open-data.s3.amazonaws.com/x.jpg" })).toBeNull();
    expect(thumbSource({ coverPhotoUrl: null })).toBeNull();
  });
  it("changes when the crop changes", () => {
    const plain = item("a", "collected", "/api/photos/1/thumb");
    const cropped = item("a", "collected", "/api/photos/1/thumb", { cardCropX: 10, cardCropY: 5, cardCropSize: 50 });
    expect(thumbKey(plain, "/api/photos/1/thumb")).toBe("/api/photos/1/thumb");
    expect(thumbKey(cropped, "/api/photos/1/thumb")).toBe("/api/photos/1/thumb#10,5,50,,");
  });
});

describe("planThumbs", () => {
  const items = [
    item("u1", "unseen", "/api/species/u1/reference-photo/thumb?v=1"),
    item("s1", "seen", "/api/species/s1/reference-photo/thumb?v=1"),
    item("c1", "collected", "/api/photos/c1/thumb"),
    item("ext", "collected", "https://example.org/x.jpg"),
    item("c2", "collected", "/api/photos/c2/thumb"),
  ];

  it("puts collected first, then seen, then the rest, and caps the count", () => {
    const { fetch } = planThumbs(items, {}, 3);
    expect(fetch.map((j) => j.speciesId)).toEqual(["c1", "c2", "s1"]);
  });

  it("reuses thumbnails whose key hasn't changed", () => {
    const { fetch, keep } = planThumbs(items, { c1: "/api/photos/c1/thumb", c2: "/api/photos/OLD/thumb" }, 10);
    expect([...keep.keys()]).toEqual(["c1"]);
    expect(fetch.map((j) => j.speciesId)).toEqual(["c2", "s1", "u1"]);
  });
});

describe("toCacheItems", () => {
  it("keeps only what the offline view needs", () => {
    const [cached] = toCacheItems([item("a", "collected", "/api/photos/a/thumb")], new Map([["a", "k"]]));
    expect(cached).toEqual({
      speciesId: "a",
      commonName: "Common a",
      scientificName: "Species a",
      taxonClass: "aves",
      family: "Turdidae",
      state: "collected",
      thumbKey: "k",
    });
  });
});

describe("squareCrop", () => {
  it("uses the card crop, in percent of the width", () => {
    const crop = squareCrop(item("a", "collected", null, { cardCropX: 25, cardCropY: 10, cardCropSize: 50 }), 400, 300);
    expect(crop).toEqual({ sx: 100, sy: 40, size: 200 });
  });
  it("keeps the crop inside the image", () => {
    const crop = squareCrop(item("a", "collected", null, { cardCropX: 90, cardCropY: 90, cardCropSize: 50 }), 400, 300);
    expect(crop.sx + crop.size).toBeLessThanOrEqual(400);
    expect(crop.sy + crop.size).toBeLessThanOrEqual(300);
  });
  it("centres, or follows the reference focal point", () => {
    expect(squareCrop(item("a", "seen", null), 400, 300)).toEqual({ sx: 50, sy: 0, size: 300 });
    expect(squareCrop(item("a", "seen", null, { referenceFocalX: 0, referenceFocalY: 50 }), 400, 300)).toEqual({
      sx: 0,
      sy: 0,
      size: 300,
    });
  });
});

describe("syncOfflineCache", () => {
  function fakeDesktop(start: Partial<SyncStart> = {}) {
    const calls: { cmd: string; args: unknown; headers?: Record<string, string> }[] = [];
    const invoke = async (cmd: string, args?: unknown, options?: { headers?: Record<string, string> }) => {
      calls.push({ cmd, args, headers: options?.headers });
      if (cmd === "offline_cache_begin")
        return { syncedAt: null, thumbs: {}, maxThumbs: 100, maxThumbBytes: 1000, ...start };
      if (cmd === "offline_cache_commit") return 42;
      return undefined;
    };
    return { calls, invoke };
  }

  it("begins, sends new thumbnails as raw bytes, then commits the list", async () => {
    const desktop = fakeDesktop({ thumbs: { a: "/api/photos/a/thumb" } });
    const items = [
      item("a", "collected", "/api/photos/a/thumb"),
      item("b", "seen", "/api/species/b/reference-photo/thumb?v=1"),
      item("c", "unseen", null),
    ];
    const result = await syncOfflineCache({
      invoke: desktop.invoke,
      userId: "user-1",
      fetchCollection: async () => items,
      makeThumb: async () => new Uint8Array([0xff, 0xd8, 0xff, 0]),
    });
    expect(result).toEqual({ syncedAt: 42, species: 3, fetched: 1, reused: 1, failed: 0 });
    expect(desktop.calls.map((c) => c.cmd)).toEqual([
      "offline_cache_begin",
      "offline_cache_put_thumb",
      "offline_cache_commit",
    ]);
    expect(desktop.calls[0].args).toEqual({ userId: "user-1" });
    expect(desktop.calls[1].args).toBeInstanceOf(Uint8Array);
    expect(desktop.calls[1].headers).toEqual({ "x-lifer-user": "user-1", "x-lifer-species": "b" });
    const committed = (desktop.calls[2].args as { items: { speciesId: string; thumbKey: string | null }[] }).items;
    expect(committed.map((i) => [i.speciesId, i.thumbKey])).toEqual([
      ["a", "/api/photos/a/thumb"],
      ["b", "/api/species/b/reference-photo/thumb?v=1"],
      ["c", null],
    ]);
  });

  it("keeps an older thumbnail when the new one fails, and skips oversized ones", async () => {
    const desktop = fakeDesktop({ thumbs: { a: "/api/photos/OLD/thumb" }, maxThumbBytes: 3 });
    const result = await syncOfflineCache({
      invoke: desktop.invoke,
      userId: "u",
      fetchCollection: async () => [
        item("a", "collected", "/api/photos/a/thumb"),
        item("b", "seen", "/api/photos/b/thumb"),
      ],
      makeThumb: async (job) => {
        if (job.speciesId === "a") throw new Error("offline");
        return new Uint8Array(10);
      },
    });
    expect(result.failed).toBe(2);
    expect(desktop.calls.some((c) => c.cmd === "offline_cache_put_thumb")).toBe(false);
    const committed = (desktop.calls.at(-1)!.args as { items: { speciesId: string; thumbKey: string | null }[] }).items;
    expect(committed).toEqual([
      expect.objectContaining({ speciesId: "a", thumbKey: "/api/photos/OLD/thumb" }),
      expect.objectContaining({ speciesId: "b", thumbKey: null }),
    ]);
  });

  it("doesn't commit when the collection can't be fetched", async () => {
    const desktop = fakeDesktop();
    await expect(
      syncOfflineCache({
        invoke: desktop.invoke,
        userId: "u",
        fetchCollection: async () => {
          throw new Error("server gone");
        },
        makeThumb: async () => null,
      }),
    ).rejects.toThrow("server gone");
    expect(desktop.calls.map((c) => c.cmd)).toEqual(["offline_cache_begin"]);
  });
});
