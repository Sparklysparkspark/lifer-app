// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A weak signal is slow, not offline: a first-ever pack list waits for a host that answers after
// 8 s and trickles its body, and never reports the connection as offline.
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000591";
const TOKEN = "lifer_test_pack_slow_591";
const appData = mkdtempSync(path.join(os.tmpdir(), "lifer-slow-index-"));
const INDEX = JSON.stringify({
  generatedAt: "2026-11-09T00:00:00Z",
  packs: [
    {
      id: "test-slow-canada-aves",
      type: "region",
      region: "Canada",
      taxon: "aves",
      sizeBytes: 1234,
      speciesCount: 5,
      contentVersion: "v1",
      scientificNames: [],
      url: "https://packs.invalid/a.zip",
    },
  ],
});

describe.skipIf(!url)("pack list on a slow connection", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let host: http.Server;
  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    host = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        const mid = Math.floor(INDEX.length / 2);
        res.write(INDEX.slice(0, mid));
        setTimeout(() => res.end(INDEX.slice(mid)), 500);
      }, 8_000);
    });
    await new Promise<void>((resolve) => host.listen(0, "127.0.0.1", resolve));
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    process.env.APP_DATA_DIR = appData;
    process.env.PACK_INDEX_URL = `http://127.0.0.1:${(host.address() as AddressInfo).port}/pack-index.json`;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { offlinePacksRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-slow@test', 'x')`, [USER]);
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
    host.closeAllConnections();
    host.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(appData, { recursive: true, force: true });
  });

  it("answers at once on a first-ever list, then fills in from the slow host, never saying offline", async () => {
    const started = Date.now();
    const first = (await get("/api/offline-packs/index")).json();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(first.indexUnavailable).toBe(true);
    expect(first.indexRefreshing).toBe(true);
    // Asked again as the app does, until the list is in.
    let body = first;
    while (body.indexUnavailable) {
      expect(body.remote).not.toBe("offline");
      await new Promise((r) => setTimeout(r, 500));
      body = (await get("/api/offline-packs/index")).json();
    }
    expect(body.remote).toBe("online");
    expect(body.packs).toContainEqual(expect.objectContaining({ id: "test-slow-canada-aves", downloaded: false }));
  }, 40_000);
});
