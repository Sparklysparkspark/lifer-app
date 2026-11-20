// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run offlinePacks/mapDetail
// Detailed maps: listing with free space, a download checked against the index's sha256, removal.
// The index and the file come from a local HTTP server; maps go to a temporary app data folder.
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000611";
const TOKEN = "lifer_test_map_detail_611";
const BYTES = Buffer.from("pretend pmtiles");

describe.skipIf(!url)("detailed map downloads", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let server: http.Server;
  let cookieName: string;
  let dataDir: string;
  const sha = createHash("sha256").update(BYTES).digest("hex");

  const req = (method: "GET" | "POST" | "DELETE", route: string, payload?: object) =>
    app.inject({ method, url: `/api${route}`, payload, cookies: { [cookieName]: TOKEN } });
  const status = async () => (await req("GET", "/offline-packs/maps/status")).json();

  beforeAll(async () => {
    server = http.createServer((request, res) => {
      if (request.url === "/index.json") {
        res.setHeader("content-type", "application/json");
        return res.end(
          JSON.stringify({
            generatedAt: "now",
            extracts: [
              { code: "BEL", name: "Belgium", file: "detail-bel-1.pmtiles", sizeBytes: BYTES.length, sha256: sha },
              { code: "LUX", name: "Luxembourg", file: "detail-lux-1.pmtiles", sizeBytes: 1e18, sha256: sha },
            ],
          }),
        );
      }
      if (request.url === "/detail-bel-1.pmtiles") return res.end(BYTES);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    dataDir = mkdtempSync(path.join(os.tmpdir(), "lifer-map-detail-"));
    process.env.APP_DATA_DIR = dataDir;
    process.env.MAP_DETAIL_INDEX_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/index.json`;
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { mapDetailRoutes } = await import("./mapDetail.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'map-detail@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(mapDetailRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    server?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("lists published maps with their sizes and the free space", async () => {
    const s = await status();
    expect(s.available).toBe(true);
    expect(s.freeBytes).toBeGreaterThan(0);
    expect(s.extracts.map((e: { code: string; downloaded: boolean }) => [e.code, e.downloaded])).toEqual([
      ["BEL", false],
      ["LUX", false],
    ]);
  });

  it("refuses a map larger than the free space before starting", async () => {
    const res = await req("POST", "/offline-packs/maps/download", { code: "LUX" });
    // DiskFullError; the app's error handler turns it into a 507 with the sizes.
    expect(res.statusCode).toBe(500);
    expect((await status()).running).toBe(false);
  });

  it("rejects a code that could be a path", async () => {
    expect((await req("POST", "/offline-packs/maps/download", { code: "../x" })).statusCode).toBe(400);
  });

  it("downloads, verifies and removes a map", async () => {
    expect((await req("POST", "/offline-packs/maps/download", { code: "BEL" })).json()).toEqual({ started: true });
    let s = await status();
    for (let i = 0; i < 200 && s.running; i++) {
      await new Promise((r) => setTimeout(r, 10));
      s = await status();
    }
    expect(s.error).toBeNull();
    const file = path.join(dataDir, "maps", "detail", "BEL.pmtiles");
    expect(existsSync(file)).toBe(true);
    expect(s.extracts.find((e: { code: string }) => e.code === "BEL")).toMatchObject({
      downloaded: true,
      updateAvailable: false,
    });
    const { installedMapDetails } = await import("./mapDetail.js");
    expect(installedMapDetails()).toEqual(["BEL"]);

    expect((await req("DELETE", "/offline-packs/maps/BEL")).json()).toEqual({ ok: true });
    expect(existsSync(file)).toBe(false);
  });
});
