import { describe, expect, it } from "vitest";
import { migratedDb } from "../store/testDb";
import { editMark, getMark } from "../store/marks";
import { libraryPhotos } from "../store/library";
import { getMeta } from "../store/meta";
import { listRegions, saveRegion } from "../store/regions";
import { getRegionTree } from "./regionTree";
import { backoffMs, resolveConflict, runSync, type HubMark, type SyncApi } from "./engine";
import { HubError, HubUnreachable } from "./hubApi";

const NOW = new Date("2026-10-25T10:00:00Z");
const hubMark = (name: string, over: Partial<HubMark> = {}): HubMark => ({
  scientificName: name,
  state: null,
  coverPhotoId: null,
  firstCollected: null,
  bestQuality: null,
  cardCropX: null,
  cardCropY: null,
  cardCropSize: null,
  isTarget: false,
  updatedAt: "2026-10-01T00:00:00.000000Z",
  ...over,
});
const capture = (n: number) => ({
  id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  updatedAt: `2026-10-01T00:00:${String(n % 60).padStart(2, "0")}.000000Z`,
  deletedAt: null,
  hiddenAt: null,
  scientificName: "Cygnus olor",
  takenAt: "2026-09-01T00:00:00Z",
  tags: [],
  qualityRating: null,
  locationLabel: null,
  regionId: null,
  photo: { id: `p${n}`, width: 1, height: 1, kind: "image" },
});

/** A tiny hub: paged feeds from arrays, marks with versions. */
function fakeHub(
  opts: {
    captures?: ReturnType<typeof capture>[];
    marks?: HubMark[];
    offline?: boolean;
    regions?: { regionId: string | null; name: string; packIds: string[]; speciesCount: number }[];
    smart?: { id: string; captureIds: string[] }[];
    tree?: { id: string; name: string; parentId: string | null; depth: number; speciesCount: number }[];
  } = {},
) {
  const calls: string[] = [];
  const marks = new Map((opts.marks ?? []).map((m) => [m.scientificName, m]));
  const captures = opts.captures ?? [];
  let version = 0;
  const api: SyncApi = {
    async get(path: string) {
      calls.push(path);
      if (opts.offline) throw new HubUnreachable();
      const url = new URL(`http://x${path}`);
      if (url.pathname === "/sync/changes") {
        const from = Number(url.searchParams.get("after")?.slice(-12) ?? -1);
        const rest = captures.filter((c) => Number(c.id.slice(-12)) > from).slice(0, 500);
        const last = rest.at(-1);
        const cur = last ? { since: last.updatedAt, after: last.id } : null;
        return { items: rest, purged: [], last: cur, next: rest.length === 500 ? cur : null } as never;
      }
      if (url.pathname === "/sync/user-species") return { items: [...marks.values()] } as never;
      if (url.pathname === "/sync/preferences")
        return {
          nameDisplay: null,
          namingStyles: [],
          sensitive: { enabled: true, added: [], removed: [], iucnStatuses: [] },
          geoprivacy: { spotDefault: "open" },
          regions: opts.regions ?? [],
        } as never;
      if (url.pathname === "/companion/v1/albums/smart") return { albums: opts.smart ?? [] } as never;
      if (url.pathname.endsWith("/checklist"))
        return {
          regionId: url.pathname.split("/")[3],
          name: "Norfolk",
          items: [
            {
              scientificName: "Cygnus olor",
              commonName: "Mute Swan",
              taxonClass: "aves",
              tier: "common",
              isVagrant: false,
              sensitiveByDefault: false,
            },
          ],
        } as never;
      if (url.pathname === "/sync/region-tree") return { regions: opts.tree ?? [] } as never;
      if (url.pathname === "/sync/search-vocab")
        return {
          regions: [{ id: "c", name: "Wonderland", parentId: null }],
          species: [
            {
              scientificName: "Cygnus olor",
              taxonOrder: "anseriformes",
              family: "anatidae",
              aliases: ["mute"],
              codes: ["mutswa"],
            },
          ],
        } as never;
      if (url.pathname === "/gallery") return { items: [], nextCursor: null } as never;
      return { items: [], purged: [], last: null, next: null } as never;
    },
    async post(path: string, body: unknown) {
      calls.push(path);
      if (opts.offline) throw new HubUnreachable();
      const applied: Record<string, string> = {};
      const conflicts: HubMark[] = [];
      for (const i of (body as { items: (HubMark & { baseUpdatedAt: string | null })[] }).items) {
        const mine = marks.get(i.scientificName);
        if (mine && mine.updatedAt !== i.baseUpdatedAt) {
          conflicts.push(mine);
          continue;
        }
        const next = { ...i, updatedAt: `2026-10-25T00:00:00.00000${++version}Z` };
        marks.set(i.scientificName, next);
        applied[i.scientificName] = next.updatedAt;
      }
      return { applied, conflicts } as never;
    },
  };
  return { api, calls, marks };
}

const deps = (db: Awaited<ReturnType<typeof migratedDb>>, api: SyncApi) => ({
  db,
  api,
  now: () => NOW,
  sleep: async () => undefined,
});

describe("pull", () => {
  it("pages through 1,200 captures with a cursor and resumes after it", async () => {
    const db = await migratedDb();
    const hub = fakeHub({ captures: Array.from({ length: 1200 }, (_, i) => capture(i)) });
    const first = await runSync(deps(db, hub.api));
    expect(first).toMatchObject({ reached: true, pulled: 1200 });
    expect((await libraryPhotos(db)).length).toBe(1200);
    expect(await getMeta(db, "cursor.captures")).toBeTruthy();
    const again = await runSync(deps(db, hub.api));
    expect(again.pulled).toBe(0);
  });

  it("takes the hub's marks but not over an edit still queued", async () => {
    const db = await migratedDb();
    await editMark(db, "Grus grus", { isTarget: true }, NOW);
    const hub = fakeHub({ offline: true });
    await runSync(deps(db, hub.api));
    const online = fakeHub({ marks: [hubMark("Anas crecca", { state: "seen" })] });
    await runSync(deps(db, online.api));
    expect(await getMark(db, "Anas crecca")).toMatchObject({
      state: "seen",
      hubVersion: "2026-10-01T00:00:00.000000Z",
    });
  });
});

describe("search vocabulary", () => {
  it("stores the region tree, aliases, order and family the hub sends", async () => {
    const db = await migratedDb();
    await runSync(deps(db, fakeHub({ captures: [capture(1)] }).api));
    expect(await db.all("SELECT id, name FROM search_regions")).toEqual([{ id: "c", name: "Wonderland" }]);
    expect(await db.all("SELECT aliases, codes FROM species_names")).toEqual([
      { aliases: '["mute"]', codes: '["mutswa"]' },
    ]);
    expect(await db.get("SELECT taxon_order, family FROM species WHERE scientific_name = 'Cygnus olor'")).toEqual({
      taxon_order: "anseriformes",
      family: "anatidae",
    });
  });
});

describe("preconfigured regions and smart albums", () => {
  const region = { regionId: "r1", name: "Norfolk", packIds: ["a"], speciesCount: 1 };

  it("keeps the hub's regions, refetches only when they change, and drops one removed on the hub", async () => {
    const db = await migratedDb();
    const hub = fakeHub({ regions: [region] });
    await runSync(deps(db, hub.api));
    expect(await listRegions(db)).toMatchObject([{ key: "hub:r1", name: "Norfolk", speciesCount: 1 }]);
    await runSync(deps(db, hub.api));
    expect(hub.calls.filter((c) => c.endsWith("/checklist"))).toHaveLength(1);
    await runSync(deps(db, fakeHub({ regions: [{ ...region, speciesCount: 2 }] }).api));
    expect(await getMeta(db, "regionSig.hub:r1")).toBe("a:2");
    await runSync(deps(db, fakeHub({ regions: [] }).api));
    expect(await listRegions(db)).toEqual([]);
  });

  it("keeps a province picked from the hub's tree while the hub lists it, and drops it when the hub does not", async () => {
    const db = await migratedDb();
    const tree = [
      { id: "r1", name: "Norfolk", parentId: null, depth: 2, speciesCount: 5 },
      { id: "bc", name: "British Columbia", parentId: "r1", depth: 3, speciesCount: 3 },
    ];
    await runSync(deps(db, fakeHub({ regions: [region], tree }).api));
    // The person picks BC: kept the same way a mirrored region is.
    await saveRegion(db, { key: "hub:bc", name: "British Columbia", source: "hub", hubRegionId: "bc" }, [], NOW);
    const hub = fakeHub({ regions: [region], tree });
    await runSync(deps(db, hub.api));
    expect((await listRegions(db)).map((r) => r.key).sort()).toEqual(["hub:bc", "hub:r1"]);
    expect(hub.calls).toContain("/sync/regions/bc/checklist");
    await runSync(deps(db, fakeHub({ regions: [region], tree: tree.slice(0, 1) }).api));
    expect((await listRegions(db)).map((r) => r.key)).toEqual(["hub:r1"]);
    expect(await getRegionTree(db)).toEqual(tree.slice(0, 1));
  });

  it("fills a smart album's members from the hub, replacing the last set", async () => {
    const db = await migratedDb();
    await runSync(deps(db, fakeHub({ smart: [{ id: "s1", captureIds: ["c1", "c2"] }] }).api));
    await runSync(deps(db, fakeHub({ smart: [{ id: "s1", captureIds: ["c2", "c3"] }] }).api));
    const rows = await db.all<{ capture_id: string }>(
      "SELECT capture_id FROM album_captures WHERE album_id = 's1' ORDER BY 1",
    );
    expect(rows.map((r) => r.capture_id)).toEqual(["c2", "c3"]);
  });
});

describe("push", () => {
  it("sends a queued mark with its base version and stores the new version", async () => {
    const db = await migratedDb();
    await editMark(db, "Grus grus", { isTarget: true }, NOW);
    const hub = fakeHub();
    const res = await runSync(deps(db, hub.api));
    expect(res.pushed).toBe(1);
    expect((await getMark(db, "Grus grus"))?.hubVersion).toBe(hub.marks.get("Grus grus")?.updatedAt);
    expect(await db.all("SELECT * FROM outbox")).toEqual([]);
  });

  it("takes the hub's copy when the hub changed the mark since (newest wins)", async () => {
    const db = await migratedDb();
    const seen = fakeHub({ marks: [hubMark("Grus grus", { state: "seen" })] });
    await runSync(deps(db, seen.api));
    await editMark(db, "Grus grus", { state: null, isTarget: true }, NOW);
    seen.marks.set("Grus grus", hubMark("Grus grus", { state: "collected", updatedAt: "2026-10-20T00:00:00.000000Z" }));
    const res = await runSync(deps(db, seen.api));
    expect(res.replaced).toBe(1);
    expect(await getMark(db, "Grus grus")).toMatchObject({ state: "collected", isTarget: false });
    expect(await db.all("SELECT * FROM outbox")).toEqual([]);
  });

  it("merges a standalone mark into a library it never saw: stronger state, targets kept, then pushed", async () => {
    const db = await migratedDb();
    await editMark(db, "Grus grus", { state: "seen", isTarget: true }, NOW);
    const hub = fakeHub({ marks: [hubMark("Grus grus", { state: "collected" })] });
    const res = await runSync(deps(db, hub.api));
    expect(res.pushed).toBe(1);
    expect(hub.marks.get("Grus grus")).toMatchObject({ state: "collected", isTarget: true });
  });

  it("keeps edits queued with a growing wait when the hub is unreachable", async () => {
    const db = await migratedDb();
    await editMark(db, "Grus grus", { isTarget: true }, NOW);
    const res = await runSync(deps(db, fakeHub({ offline: true }).api));
    expect(res).toMatchObject({ reached: false, pushed: 0 });
    const row = await db.get<{ attempts: number; next_try_at: string }>("SELECT * FROM outbox");
    expect(row?.attempts).toBe(1);
    expect(row!.next_try_at > NOW.toISOString()).toBe(true);
    // Not due yet: a second run does not try to send it.
    const hub = fakeHub();
    await runSync(deps(db, hub.api));
    expect((await db.get<{ attempts: number }>("SELECT * FROM outbox"))?.attempts).toBe(1);
  });

  it("drops a mark the hub's catalogue lacks instead of retrying forever", async () => {
    const db = await migratedDb();
    await editMark(db, "Nonexistus bird", { state: "seen" }, NOW);
    const api: SyncApi = { get: fakeHub().api.get, post: async () => ({ applied: {}, conflicts: [] }) as never };
    await runSync(deps(db, api));
    expect(await db.all("SELECT * FROM outbox")).toEqual([]);
  });

  it("reports a refused key", async () => {
    const db = await migratedDb();
    const api: SyncApi = {
      get: async () => {
        throw new HubError(401);
      },
      post: async () => {
        throw new HubError(401);
      },
    };
    expect(await runSync(deps(db, api))).toMatchObject({ unauthorized: true });
  });

  it("retries a hub that answers 503 twice, then gives up quietly", async () => {
    const db = await migratedDb();
    let n = 0;
    const api: SyncApi = {
      get: async () => {
        n++;
        throw new HubError(503);
      },
      post: async () => ({}) as never,
    };
    const res = await runSync(deps(db, api));
    expect(res.reached).toBe(false);
    expect(n).toBe(3);
  });
});

describe("conflict rule and backoff", () => {
  it("resolveConflict", () => {
    const local = {
      scientificName: "a b",
      state: "seen" as const,
      isTarget: false,
      coverPhotoId: null,
      firstCollected: null,
      bestQuality: null,
      cardCropX: null,
      cardCropY: null,
      cardCropSize: null,
      hubVersion: "v1",
    };
    expect(resolveConflict(local, hubMark("a b", { state: null })).mark.state).toBe(null);
    expect(resolveConflict({ ...local, hubVersion: null }, hubMark("a b", { state: null })).requeue).toBe(true);
  });
  it("backoffMs doubles to a cap", () => {
    expect(backoffMs(1)).toBe(10_000);
    expect(backoffMs(30)).toBe(15 * 60_000);
  });
});
