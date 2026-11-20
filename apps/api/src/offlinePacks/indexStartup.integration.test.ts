// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A desktop start: the list, the updates check and more lists arrive together, and the saved
// 22 MB index must be read once, off the main thread, while other requests keep moving.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000601";
const TOKEN = "lifer_test_pack_startup_601";
const appData = mkdtempSync(path.join(os.tmpdir(), "lifer-index-startup-"));
const loads: string[] = [];
vi.mock("./indexLoader.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("./indexLoader.js")>();
  return {
    ...real,
    loadIndexFile: (file: string, opts?: { writeLiteTo?: string }) => {
      loads.push(path.basename(file));
      return real.loadIndexFile(file, opts);
    },
  };
});

describe.skipIf(!url)("pack list at startup from a saved 22 MB index", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    const pool = Array.from({ length: 40_000 }, (_, i) => `Genus${i % 3000} species${i}`);
    const packs = Array.from({ length: 5_600 }, (_, i) => ({
      id: `test-startup-${i}`,
      type: "region",
      region: `Country ${i % 250}`,
      taxon: "aves",
      sizeBytes: 100_000 + i,
      speciesCount: 160,
      contentVersion: `v${i}`,
      scientificNames: Array.from({ length: 160 }, (_, j) => pool[(i * 37 + j * 101) % pool.length]),
      url: "https://packs.invalid/shard.bin",
    }));
    writeFileSync(
      path.join(appData, "pack-index-cache.json"),
      JSON.stringify({ generatedAt: "2026-11-12T00:00:00Z", packs }),
    );
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    process.env.APP_DATA_DIR = appData;
    // Nothing listens there: the saved copy is all there is.
    process.env.PACK_INDEX_URL = "http://127.0.0.1:9/pack-index.json";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { offlinePacksRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-startup@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(offlinePacksRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(appData, { recursive: true, force: true });
  });

  it("serves the startup burst from one shared load, without stalling the event loop", async () => {
    const delay = monitorEventLoopDelay({ resolution: 10 });
    delay.enable();
    const responses = await Promise.all([
      get("/api/offline-packs/index"),
      get("/api/offline-packs/index"),
      get("/api/offline-packs/updates-summary"),
      get("/api/offline-packs/index"),
    ]);
    delay.disable();
    for (const res of responses) expect(res.statusCode).toBe(200);
    expect(responses[0].json().packs).toHaveLength(5_600);
    expect(responses[0].json().packs[0]).not.toHaveProperty("scientificNames");
    // One read of the saved file for all four requests.
    expect(loads.filter((f) => f === "pack-index-cache.json")).toHaveLength(1);
    // Leaves room for test-runner noise; measured around 60 to 100 ms here.
    expect(delay.max / 1e6).toBeLessThan(150);
    // The next start reads the lite copy it left behind.
    const { resetPackIndexCache } = await import("./index.js");
    resetPackIndexCache();
    loads.length = 0;
    expect((await get("/api/offline-packs/index")).statusCode).toBe(200);
    expect(loads[0]).toBe("pack-index-lite-cache.json");
  }, 60_000);
});
