// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// With the published index unreachable, the pack list still reports what's installed here, says
// the index is unavailable, and doesn't wait on the network again for a minute.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000571";
const TOKEN = "lifer_test_pack_offline_571";
const PACK = "test-offline-canada-aves";
const appData = mkdtempSync(path.join(os.tmpdir(), "lifer-offline-index-"));

// The list answers at once and refreshes in the background; this waits for that refresh to end.
async function refreshSettled(): Promise<void> {
  const { packIndexRemoteState } = await import("./index.js");
  while (packIndexRemoteState().refreshing) await new Promise((r) => setTimeout(r, 50));
}

describe.skipIf(!url)("pack list without the published index", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let reset: () => void;
  const fetchMock = vi.fn(async () => {
    throw new Error("connect ETIMEDOUT");
  });
  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    process.env.APP_DATA_DIR = appData;
    process.env.PACK_INDEX_URL = "https://packs.invalid/pack-index.json";
    vi.stubGlobal("fetch", fetchMock);
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    ({ resetPackIndexCache: reset } = await import("./index.js"));
    const { offlinePacksRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-offline@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, content_version, region, taxon, species_count, bytes)
       VALUES ($1, 'v1', 'Canada', 'aves', 12, 3456)`,
      [PACK],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(offlinePacksRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(() => {
    reset();
    fetchMock.mockClear();
    rmSync(path.join(appData, "pack-index-cache.json"), { force: true });
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    vi.unstubAllGlobals();
    rmSync(appData, { recursive: true, force: true });
  });

  it("lists the installed pack at once, calls a timeout slow (not offline), and backs off before asking again", async () => {
    const res = await get("/api/offline-packs/index");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Answered without waiting on the network, while the list is fetched in the background.
    expect(body.indexUnavailable).toBe(true);
    expect(body.indexRefreshing).toBe(true);
    expect(body.packs).toContainEqual(
      expect.objectContaining({ id: PACK, region: "Canada", taxon: "aves", downloaded: true, updateAvailable: false }),
    );
    expect(body).toHaveProperty("freeBytes");

    await refreshSettled();
    expect((await get("/api/offline-packs/index")).json().remote).toBe("slow");
    const calls = fetchMock.mock.calls.length;
    await get("/api/offline-packs/index");
    expect((await get("/api/offline-packs/updates-summary")).json()).toMatchObject({ updateCount: 0 });
    expect(fetchMock.mock.calls.length).toBe(calls);
  }, 60_000);

  it("answers at once from the last index saved on this computer", async () => {
    writeFileSync(
      path.join(appData, "pack-index-cache.json"),
      JSON.stringify({
        generatedAt: "2026-11-01T00:00:00Z",
        packs: [
          {
            id: PACK,
            type: "region",
            region: "Canada",
            taxon: "aves",
            sizeBytes: 3456,
            speciesCount: 12,
            contentVersion: "v2",
            scientificNames: [],
            url: "https://packs.invalid/a.zip",
          },
          {
            id: "test-offline-canada-squamata",
            type: "region",
            region: "Canada",
            taxon: "squamata",
            sizeBytes: 999,
            speciesCount: 3,
            contentVersion: "v1",
            scientificNames: [],
            url: "https://packs.invalid/b.zip",
          },
        ],
      }),
    );
    const body = (await get("/api/offline-packs/index")).json();
    // Answered at once from the saved copy, which counts as having an index.
    expect(body.indexUnavailable).toBeUndefined();
    expect(body.generatedAt).toBe("2026-11-01T00:00:00Z");
    const ids = body.packs.map((p: { id: string }) => p.id);
    expect(ids.filter((id: string) => id === PACK)).toHaveLength(1);
    expect(body.packs).toContainEqual(
      expect.objectContaining({ id: "test-offline-canada-squamata", downloaded: false, sizeBytes: 999 }),
    );
    // The saved list is newer than what's installed, so its update is offered.
    expect(body.packs.find((p: { id: string }) => p.id === PACK).updateAvailable).toBe(true);
  });
});
