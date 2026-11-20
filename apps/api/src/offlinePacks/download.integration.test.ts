// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run offlinePacks/download
// Queueing onto a running pack download, its lanes, and the hotspot step. The index, the pack
// bytes and the apply steps are stubbed; each pack's download waits until the test releases it.
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PackDownloadStatus } from "@lifer/shared";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000571";
const TOKEN = "lifer_test_pack_queue_571";
const PREFIX = "zzq-";

const ids = ["a", "b", "c", "d"].map((x) => PREFIX + x);
const SEA = `${PREFIX}seazone`;
const entry = (id: string) => ({
  id,
  type: "region",
  region: id,
  taxon: null,
  sizeBytes: 1,
  speciesCount: 0,
  contentVersion: "v1",
  scientificNames: [],
  url: `https://packs.test/${id}`,
});

// Each download parks here until released (or the job's signal aborts it).
const pending = new Map<string, () => void>();
const downloaded: string[] = [];
const galleryByPack: Array<[string, boolean]> = [];
let lastApplied = "";
// Packs whose hotspot step parks until released, or fails.
const hotspotGate = new Map<string, () => void>();
const hotspotsHeld = new Set<string>();
const hotspotsFail = new Set<string>();

vi.mock("./index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./index.js")>()),
  assertTrustedPackUrl: () => {},
  invalidatePackSizes: () => {},
  fetchPackIndex: async () => ({
    generatedAt: "now",
    photoStore: { indexUrl: "https://packs.test/photos.json" },
    packs: [...ids, SEA].map(entry),
  }),
  computePackStatuses: async () => ({
    generatedAt: "now",
    sizesPending: false,
    packs: ids.flatMap((id) => [
      { ...entry(id), downloaded: false, updateAvailable: false },
      { ...entry(id), id: `${id}.small`, variant: "small", downloaded: false, updateAvailable: false },
    ]),
  }),
}));
vi.mock("@lifer/core/lib/resumableDownload.js", () => ({
  downloadResumable: (_url: string, _file: string, opts: { signal: AbortSignal; label: string }) =>
    new Promise((resolve, reject) => {
      // A ".small" pack shares its full pack's URL, so the label (the quoted id) tells them apart.
      const id = opts.label.replace(/"/g, "");
      opts.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      pending.set(id, () => {
        pending.delete(id);
        downloaded.push(id);
        resolve({ bytes: 1 });
      });
    }),
}));
vi.mock("./apply.js", () => ({
  prefetchPackProvinces: async () => new Map(),
  applyPack: async (_client: unknown, tmpFile: string) => {
    lastApplied = path.basename(tmpFile).replace(/\.pack\.tar\.gz$/, "");
    return {
      skippedNames: [],
      speciesCount: 0,
      touched: [],
      allChildRegionIds: [],
      territoryChildRegionIds: [],
      // The pack id stands in for its hotspots, so the stub below knows whose they are.
      hotspots: [{ regionId: lastApplied, species: [] }],
      // Pack "a" (either variant) depends on the sea zone.
      manifest: { seaZoneDependencies: lastApplied.startsWith(ids[0]) ? [{ packFile: `${SEA}.pack.tar.gz` }] : [] },
    };
  },
  applyPackHotspots: async (_client: unknown, [{ regionId: id }]: Array<{ regionId: string }>) => {
    if (hotspotsHeld.has(id)) await new Promise<void>((resolve) => hotspotGate.set(id, resolve));
    if (hotspotsFail.has(id)) throw new Error("hotspots failed");
    return 0;
  },
}));
vi.mock("./photoStore.js", () => ({
  fetchPhotoStoreIndex: async () => ({ species: {} }),
  missingPhotos: async (_pool: unknown, _index: unknown, _ids: unknown, includeGallery: boolean) => {
    galleryByPack.push([lastApplied, includeGallery]);
    return [];
  },
  downloadPhotos: async () => ({ failed: 0 }),
}));
vi.mock("../species/catalogSeedUpdate.js", () => ({
  catalogFirstBootState: () => "done",
  catalogLoadProgress: () => null,
  catalogUpdate: { status: { running: false } },
  checkCatalogUpdate: async () => ({ available: false }),
  startCatalogUpdateJob: () => {},
  waitForFirstBootCatalog: async () => {},
}));
vi.mock("../species/withheldPhotos.js", () => ({ startWithheldPhotoFetch: () => {} }));
vi.mock("../species/speciesSplits.js", () => ({ resolveSpeciesSplits: async () => {} }));

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe.skipIf(!url)("queueing onto a running pack download", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const post = (route: string, payload: unknown) =>
    app.inject({ method: "POST", url: `/api${route}`, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const status = async () =>
    (
      await app.inject({ method: "GET", url: "/api/offline-packs/download/status", cookies: { [cookieName]: TOKEN } })
    ).json() as PackDownloadStatus;
  const versions = async (id: string) =>
    (await db.query(`SELECT content_version, hotspots_applied_version FROM downloaded_packs WHERE pack_id = $1`, [id]))
      .rows[0];
  const release = async (id: string) => {
    await until(() => pending.has(id), `${id} to start downloading`);
    pending.get(id)!();
  };
  const finished = async () => {
    let s = await status();
    for (let i = 0; i < 200 && s.running; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(s.running).toBe(false);
    return s;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { packDownloadRoutes } = await import("./download.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-queue@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(packDownloadRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id LIKE $1`, [`${PREFIX}%`]);
    downloaded.length = 0;
    galleryByPack.length = 0;
    pending.clear();
    hotspotGate.clear();
    hotspotsHeld.clear();
    hotspotsFail.clear();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id LIKE $1`, [`${PREFIX}%`]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("appends to the running job, dedupes, grows the total and keeps each pack's variant", async () => {
    expect((await post("/offline-packs/download", { packIds: [ids[0]] })).json()).toEqual({ started: true });
    await until(() => pending.has(ids[0]), "the first pack");

    // The current pack and a repeat are dropped; the small variant is its own pack.
    const added = await post("/offline-packs/download", { packIds: [ids[0], ids[1], ids[1], `${ids[2]}.small`] });
    expect([added.statusCode, added.json()]).toEqual([200, { started: false, queued: 2 }]);
    expect((await post("/offline-packs/download", { packIds: [ids[1]] })).json()).toEqual({
      started: false,
      queued: 0,
    });
    const batch = await post("/offline-packs/download-batch", { regionNames: [ids[3]], variant: "small" });
    expect(batch.json()).toEqual({ started: false, queued: 1, packIds: [`${ids[3]}.small`] });
    expect(await status()).toMatchObject({
      running: true,
      total: 4,
      packIds: [ids[0], ids[1], `${ids[2]}.small`, `${ids[3]}.small`],
    });

    await release(ids[0]);
    // Pack "a" queued its sea zone once set up, behind the packs already waiting.
    await until(() => pending.has(ids[1]) && galleryByPack.length > 0, "the second pack and the first set up");
    expect((await status()).total).toBe(5);
    // Already queued as a dependency, so not added twice.
    expect((await post("/offline-packs/download", { packIds: [SEA] })).json()).toEqual({ started: false, queued: 0 });
    for (const id of [ids[1], `${ids[2]}.small`, `${ids[3]}.small`, SEA]) await release(id);

    expect(await finished()).toMatchObject({ processed: 5, total: 5, cancelled: false });
    expect(downloaded).toEqual([ids[0], ids[1], `${ids[2]}.small`, `${ids[3]}.small`, SEA]);
    expect(galleryByPack).toEqual([
      [ids[0], true],
      [ids[1], true],
      [`${ids[2]}.small`, false],
      [`${ids[3]}.small`, false],
      [SEA, true],
    ]);
  });

  it("cancel stops the current pack and drops the queued ones", async () => {
    expect((await post("/offline-packs/download", { packIds: [ids[1]] })).json()).toEqual({ started: true });
    await until(() => pending.has(ids[1]), "the first pack");
    expect((await post("/offline-packs/download", { packIds: [ids[2], ids[3]] })).json()).toEqual({
      started: false,
      queued: 2,
    });
    expect((await post("/offline-packs/download/cancel", {})).json()).toEqual({ cancelled: true });
    expect(await finished()).toMatchObject({ cancelled: true, processed: 0 });
    expect(downloaded).toEqual([]);

    // The next request starts a fresh job with only what it asks for.
    expect((await post("/offline-packs/download", { packIds: [ids[3]] })).json()).toEqual({ started: true });
    await release(ids[3]);
    expect(await finished()).toMatchObject({ total: 1, processed: 1, packIds: [ids[3]] });
    expect(downloaded).toEqual([ids[3]]);
  });

  it("reports lanes: a pack is usable before its hotspots land, and the job waits for them", async () => {
    hotspotsHeld.add(ids[3]);
    await post("/offline-packs/download", { packIds: [ids[3]] });
    await release(ids[3]);
    await until(() => hotspotGate.has(ids[3]), "the hotspot step");
    expect(await status()).toMatchObject({
      running: true,
      lanes: {
        download: { processed: 1, total: 1, currentItem: null },
        setup: { processed: 1, total: 1, step: "hotspots", currentItem: ids[3] },
      },
    });
    expect(await versions(ids[3])).toEqual({ content_version: "v1", hotspots_applied_version: null });

    hotspotGate.get(ids[3])!();
    expect(await finished()).toMatchObject({ processed: 1, lanes: { setup: { processed: 1, step: null } } });
    expect(await versions(ids[3])).toEqual({ content_version: "v1", hotspots_applied_version: "v1" });
  });

  it("applies again at startup a pack whose hotspots didn't land, then skips it", async () => {
    hotspotsFail.add(ids[1]);
    await post("/offline-packs/download", { packIds: [ids[1]] });
    await release(ids[1]);
    expect((await finished()).error).toMatch(/hotspots failed/);
    expect(await versions(ids[1])).toEqual({ content_version: "v1", hotspots_applied_version: null });

    hotspotsFail.clear();
    const { resumePendingPackHotspots } = await import("./download.js");
    await resumePendingPackHotspots();
    await release(ids[1]);
    expect((await finished()).error).toBeNull();
    expect(await versions(ids[1])).toEqual({ content_version: "v1", hotspots_applied_version: "v1" });

    downloaded.length = 0;
    await post("/offline-packs/download", { packIds: [ids[1]] });
    expect(await finished()).toMatchObject({ processed: 1, error: null });
    expect(downloaded).toEqual([]);
  });

  it("stopping downloads drops the queue but finishes setting up what's on disk", async () => {
    hotspotsHeld.add(ids[2]);
    await post("/offline-packs/download", { packIds: [ids[2], ids[3], ids[1]] });
    await release(ids[2]);
    await until(() => hotspotGate.has(ids[2]) && pending.has(ids[3]), "one pack setting up and the next downloading");
    expect((await post("/offline-packs/download/cancel", { downloadsOnly: true })).json()).toEqual({ cancelled: true });

    hotspotGate.get(ids[2])!();
    expect(await finished()).toMatchObject({ cancelled: false, error: null, processed: 1, total: 1 });
    expect(downloaded).toEqual([ids[2]]);
    expect(await versions(ids[2])).toEqual({ content_version: "v1", hotspots_applied_version: "v1" });
  });
});
