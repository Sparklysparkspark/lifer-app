// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Pack sizes include the photos a download fetches after the checklist. Those are worked out from
// the photo store index (a large download), so the last per-pack figures are saved in app data:
// a restart, or one with no network, prices packs at once instead of showing checklist-only sizes.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000611";
const TOKEN = "lifer_test_pack_sizes_611";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000612";
const PACK = "test-sizes-canada-squamata";
const CHECKLIST = 4_000;
const appData = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-sizes-"));
const SIZES_FILE = path.join(appData, "pack-photo-sizes-cache.json");

// Main photo (display + thumb) 300 KB, one gallery photo 2 MB.
const store = {
  v: 1,
  builtAt: "2026-11-01T00:00:00Z",
  shards: [],
  species: {
    [SPECIES]: {
      d: [0, 0, 200_000, "a"],
      t: [0, 0, 100_000, "b"],
      g: { "https://photos.invalid/1.jpg": { d: [0, 0, 1_500_000, "c"], t: [0, 0, 500_000, "d"] } },
    },
  },
};
// What the photo store answers: the index, a failure, or nothing yet.
let storeAnswer: "ok" | "fail" | "hang" = "ok";
let fetched: typeof store | null = null;
vi.mock("./photoStore.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./photoStore.js")>()),
  fetchPhotoStoreIndex: async () => {
    if (storeAnswer === "fail") throw new Error("getaddrinfo ENOTFOUND photos.invalid");
    if (storeAnswer === "hang") return new Promise(() => {});
    fetched = store;
    return store;
  },
  lastPhotoStoreIndex: () => fetched,
}));

describe.skipIf(!url)("pack photo sizes saved for the next start", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let reset: () => void;
  const list = async () => {
    const res = await app.inject({ method: "GET", url: "/api/offline-packs/index", cookies: { [cookieName]: TOKEN } });
    expect(res.statusCode).toBe(200);
    return res.json() as { sizesPending?: boolean; packs: Array<{ id: string; sizeBytes: number }> };
  };
  const size = (body: Awaited<ReturnType<typeof list>>, id: string) => body.packs.find((p) => p.id === id)?.sizeBytes;
  // A restart: memory forgotten, files in app data kept.
  const restart = () => {
    reset();
    fetched = null;
  };

  beforeAll(async () => {
    writeFileSync(
      path.join(appData, "pack-index-cache.json"),
      JSON.stringify({
        generatedAt: "2026-11-01T00:00:00Z",
        photoStore: { indexUrl: "https://packs.invalid/lifer-photo-store.json.gz" },
        packs: [
          {
            id: PACK,
            type: "region",
            region: "Canada",
            taxon: "squamata",
            sizeBytes: CHECKLIST,
            speciesCount: 1,
            contentVersion: "v1",
            scientificNames: ["Zzsizes testus"],
            url: "https://packs.invalid/a.zip",
          },
        ],
      }),
    );
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    process.env.APP_DATA_DIR = appData;
    // Nothing listens there: no new pack index arrives during the test.
    process.env.PACK_INDEX_URL = "http://127.0.0.1:9/pack-index.json";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    ({ resetPackIndexCache: reset } = await import("./index.js"));
    const { offlinePacksRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-sizes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, is_other_taxa)
       VALUES ($1, 990611, 'Zzsizes testus', 'squamata', false)`,
      [SPECIES],
    );
    app = Fastify();
    await app.register(cookie);
    await app.register(offlinePacksRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(() => {
    storeAnswer = "ok";
    restart();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(appData, { recursive: true, force: true });
  });

  // Asks until the species names (read in a worker) are in and sizes are worked out.
  async function settledList() {
    for (let i = 0; i < 100; i++) {
      const body = await list();
      if (!body.sizesPending) return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("sizes stayed pending");
  }

  it("prices each variant with its photos and saves the figures", async () => {
    rmSync(SIZES_FILE, { force: true });
    const body = await settledList();
    expect(size(body, PACK)).toBe(CHECKLIST + 300_000 + 2_000_000);
    expect(size(body, `${PACK}.small`)).toBe(CHECKLIST + 300_000);
    await vi.waitFor(() => expect(existsSync(SIZES_FILE)).toBe(true));
  });

  it("on a restart, answers at once with the saved sizes while the photo store is still coming", async () => {
    await vi.waitFor(() => expect(existsSync(SIZES_FILE)).toBe(true));
    storeAnswer = "hang";
    const started = Date.now();
    const body = await list();
    // No wait on the photo store, and no checklist-only size.
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(body.sizesPending).toBeUndefined();
    expect(size(body, PACK)).toBe(CHECKLIST + 2_300_000);
    expect(size(body, `${PACK}.small`)).toBe(CHECKLIST + 300_000);
  });

  it("offline, still shows the saved sizes", async () => {
    storeAnswer = "fail";
    const body = await list();
    expect(body.sizesPending).toBeUndefined();
    expect(size(body, PACK)).toBe(CHECKLIST + 2_300_000);
  });

  it("with nothing saved and no photo store, says the sizes are pending instead of passing off the checklist alone", async () => {
    rmSync(SIZES_FILE, { force: true });
    storeAnswer = "fail";
    const body = await list();
    expect(body.sizesPending).toBe(true);
  });

  it("doesn't reuse saved sizes once the photos on this computer changed", async () => {
    await settledList();
    await vi.waitFor(() => expect(existsSync(SIZES_FILE)).toBe(true));
    await db.query(`UPDATE species SET reference_display_path = '/tmp/x.webp' WHERE id = $1`, [SPECIES]);
    try {
      restart();
      storeAnswer = "fail";
      expect((await list()).sizesPending).toBe(true);
    } finally {
      await db.query(`UPDATE species SET reference_display_path = NULL WHERE id = $1`, [SPECIES]);
    }
  });
});
