import { describe, expect, it } from "vitest";
import { migratedDb } from "../store/testDb";
import { DEFAULT_SETTINGS, type Settings } from "../store/settings";
import { applyCaptureChanges } from "../store/library";
import {
  FULL_LIFETIME_MS,
  MediaHttpError,
  clearKind,
  downloadsAllowed,
  enforceThumbCap,
  fetchFull,
  fetchMedia,
  planEviction,
  hubPath,
  mediaPath,
  referenceId,
  squareId,
  showcaseMissing,
  usage,
  type MediaDeps,
  type MediaFs,
} from "./cache";
import { MediaQueue } from "./queue";
import { MediaService } from "./service";

async function setup(over: Partial<Settings> = {}, fsOver: Partial<MediaFs> = {}) {
  const db = await migratedDb();
  const files = new Map<string, number>();
  let clock = 1_000_000;
  const fs: MediaFs = {
    download: async (t, path) => (files.set(path, 100), 100),
    remove: async (p) => void files.delete(p),
    ensureDir: async () => undefined,
    ...fsOver,
  };
  const deps: MediaDeps = {
    db,
    fs,
    dirs: { thumb: "/c/thumb", view: "/c/view", phone: "/d/showcase", full: "/c/full" },
    target: (p) => ({ url: `https://hub/api${p}`, headers: {} }),
    now: () => clock,
    settings: () => ({ ...DEFAULT_SETTINGS, ...over }),
    metered: async () => false,
  };
  return { db, deps, files, tick: (ms: number) => (clock += ms) };
}

describe("eviction", () => {
  it("removes least recently used first until under the cap", () => {
    const rows = [
      { photo_id: "a", kind: "thumb" as const, bytes: 40, last_used: 3 },
      { photo_id: "b", kind: "thumb" as const, bytes: 40, last_used: 1 },
      { photo_id: "c", kind: "thumb" as const, bytes: 40, last_used: 2 },
    ];
    expect(planEviction(rows, 80).map((r) => r.photo_id)).toEqual(["b"]);
    expect(planEviction(rows, 0)).toHaveLength(3);
    expect(planEviction(rows, 1000)).toEqual([]);
  });

  it("enforces the cap on thumbnails only and deletes the files", async () => {
    const { deps, files, tick } = await setup();
    for (const id of ["a", "b", "c"]) {
      await fetchMedia(deps, "thumb", id);
      tick(10);
    }
    await fetchMedia(deps, "phone", "showcase1");
    expect(await enforceThumbCap(deps, 250)).toBe(1);
    expect(files.has("/c/thumb/a.img")).toBe(false);
    expect(files.has("/d/showcase/showcase1.webp")).toBe(true);
    expect(await usage(deps.db)).toMatchObject({ thumb: 200, phone: 100 });
  });
});

describe("downloads", () => {
  it("is MR14: Wi-Fi only refuses a metered connection", async () => {
    const { deps } = await setup({ wifiOnly: true });
    expect(await downloadsAllowed({ ...deps, metered: async () => true })).toBe(false);
    expect(await downloadsAllowed(deps)).toBe(true);
    expect(
      await downloadsAllowed({ settings: () => ({ ...DEFAULT_SETTINGS, wifiOnly: false }), metered: async () => true }),
    ).toBe(true);
  });

  it("serves a cached copy without downloading again, and records nothing for a failed download", async () => {
    let calls = 0;
    const { deps } = await setup({}, { download: async () => (calls++, Promise.reject(new Error("net"))) });
    await expect(fetchMedia(deps, "thumb", "x")).rejects.toThrow();
    expect(await usage(deps.db)).toEqual({ thumb: 0, phone: 0, full: 0 });
    const ok = await setup();
    await fetchMedia(ok.deps, "thumb", "x");
    const spy = ok.deps.fs.download;
    ok.deps.fs.download = async (...a) => (calls++, spy(...a));
    calls = 0;
    await fetchMedia(ok.deps, "thumb", "x");
    expect(calls).toBe(0);
  });

  it("full size lives an hour, then is purged by the next request", async () => {
    const { deps, files, tick } = await setup();
    expect((await fetchFull(deps, "p1")).ok).toBe(true);
    tick(FULL_LIFETIME_MS + 1);
    await fetchFull(deps, "p2");
    expect(files.has("/c/full/p1.jpg")).toBe(false);
    expect(files.has("/c/full/p2.jpg")).toBe(true);
  });

  it("tells offline from unavailable for full size", async () => {
    const off = await setup({}, { download: async () => Promise.reject(new Error("net")) });
    expect(await fetchFull(off.deps, "p")).toEqual({ ok: false, reason: "offline" });
    const gone = await setup({}, { download: async () => Promise.reject(new MediaHttpError(409)) });
    expect(await fetchFull(gone.deps, "p")).toEqual({ ok: false, reason: "unavailable" });
  });
});

describe("showcase", () => {
  const cap = (id: string, name: string, rating: number | null, photo = `p-${id}`) => ({
    id,
    deletedAt: null,
    hiddenAt: null,
    scientificName: name,
    takenAt: "2026-01-01T00:00:00Z",
    tags: [],
    qualityRating: rating,
    locationLabel: null,
    regionId: null,
    photo: { id: photo, width: 1, height: 1, kind: "image" },
  });

  it("is one cover per species plus Featured, minus what is already saved", async () => {
    const { deps, db } = await setup();
    await applyCaptureChanges(db, [cap("1", "A a", 3), cap("2", "A a", 5), cap("3", "B b", null)], []);
    await fetchMedia(deps, "phone", "p-2");
    const plan = await showcaseMissing(deps, ["p-feat"]);
    expect(plan.total).toBe(3);
    expect(plan.ids.sort()).toEqual(["p-3", "p-feat"]);
  });

  it("can be limited to Featured and cleared", async () => {
    const { deps, db } = await setup({ showcaseFeaturedOnly: true });
    await applyCaptureChanges(db, [cap("1", "A a", 3)], []);
    expect((await showcaseMissing(deps, ["f"])).ids).toEqual(["f"]);
    await fetchMedia(deps, "phone", "f");
    await clearKind(deps, "phone");
    expect((await usage(db)).phone).toBe(0);
  });
});

describe("MediaQueue", () => {
  it("runs a few at a time, each photo once, and tells listeners", async () => {
    const started: string[] = [];
    const release: (() => void)[] = [];
    const q = new MediaQueue((id) => new Promise((res) => (started.push(id), release.push(() => res(`/p/${id}`)))), 2);
    const done: string[] = [];
    q.subscribe((id) => done.push(id));
    for (const id of ["a", "b", "c", "c"]) q.request(id);
    expect(started).toEqual(["a", "b"]);
    release[0]();
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toEqual(["a"]);
    expect(started).toEqual(["a", "b", "c"]);
  });

  it("does not hammer a photo that just failed", async () => {
    let t = 0;
    let n = 0;
    const q = new MediaQueue(
      async () => (n++, Promise.reject(new Error("x"))),
      1,
      () => t,
      1000,
    );
    q.request("a");
    await new Promise((r) => setTimeout(r, 0));
    q.request("a");
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(1);
    t = 2000;
    q.request("a");
    await new Promise((r) => setTimeout(r, 0));
    expect(n).toBe(2);
  });
});

describe("reference photos", () => {
  it("travel through the photo cache under a ref id and fetch from the phone reference routes", () => {
    const id = referenceId("Turdus migratorius");
    expect(id).toBe("ref~Turdus_migratorius");
    expect(referenceId("Larus × hybrid")).toBe("ref~Larus___hybrid");
    expect(hubPath("thumb", id)).toBe("/companion/v1/reference/Turdus_migratorius/thumb");
    expect(hubPath("view", id)).toBe("/companion/v1/reference/Turdus_migratorius/display");
    expect(hubPath("thumb", "abc")).toBe("/photos/abc/thumb");
    expect(mediaPath({ dirs: { thumb: "/t", view: "/v", phone: "/p", full: "/f" } }, "thumb", id)).toBe(
      "/t/ref_Turdus_migratorius.img",
    );
  });
});

describe("featured squares", () => {
  const crop = { x: 10, y: 20.5, size: 40 };
  const photo = "0c8e5c1e-1b2c-4d3e-8f90-a1b2c3d4e5f6";

  it("are named by owner, photo and crop, and fetched from the hub's square route into the showcase", () => {
    const id = squareId("species", "Turdus_migratorius", photo, crop);
    expect(id).toBe(`sq~species~Turdus_migratorius~${photo}~10.000_20.500_40.000`);
    expect(squareId("album", "a1", photo, null)).toBe(`sq~album~a1~${photo}~centre`);
    expect(hubPath("phone", id)).toBe(`/companion/v1/square/species/Turdus_migratorius?photo=${photo}`);
    expect(mediaPath({ dirs: { thumb: "/t", view: "/v", phone: "/p", full: "/f" } }, "phone", id)).toBe(
      `/p/sq_species_Turdus_migratorius_${photo}_10.000_20.500_40.000.webp`,
    );
  });

  it("are kept in the showcase, replaced when the crop changes, and refetched only then", async () => {
    const { deps, files, db } = await setup();
    const service = new MediaService(deps, () => true);
    const first = await service.square("species", "Turdus_migratorius", photo, crop);
    expect(first).toContain("/d/showcase/sq_species_");
    expect(await service.square("species", "Turdus_migratorius", photo, crop)).toBe(first);
    expect(files.size).toBe(1);

    const moved = await service.square("species", "Turdus_migratorius", photo, { ...crop, x: 30 });
    expect(moved).not.toBe(first);
    expect(files.has(first!)).toBe(false);
    expect(files.has(moved!)).toBe(true);
    expect((await db.all("SELECT * FROM media WHERE kind = 'phone'")).length).toBe(1);
    expect((await usage(db)).phone).toBe(100);
    // Another species' square is left alone, and the thumbnail cap never touches squares.
    await service.square("species", "Larus_argentatus", photo, null);
    expect(await enforceThumbCap(deps, 0)).toBe(0);
    expect(files.size).toBe(2);
  });

  it("are null with no hub or when the hub answers 404, so the cropped thumbnail stays", async () => {
    const off = await setup();
    expect(await new MediaService(off.deps, () => false).square("album", "a1", photo, null)).toBeNull();
    const refused = await setup({}, { download: async () => Promise.reject(new MediaHttpError(404)) });
    expect(await new MediaService(refused.deps, () => true).square("album", "a1", photo, null)).toBeNull();
  });
});
