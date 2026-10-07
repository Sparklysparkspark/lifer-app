// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Input validation on the iNaturalist routes: malformed bodies and ids are refused before any
// call to iNaturalist, and well-formed ones still reach the handler.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000811";
const TOKEN = "lifer_test_inaturalist_routes_811";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000812";
const invalid = (message: RegExp) => ({ error: expect.stringMatching(message), code: "invalid_request" });

describe.skipIf(!url)("iNaturalist routes input", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let savedConfig: unknown[] = [];

  const call = (method: "GET" | "POST" | "PUT", route: string, payload?: unknown, token: string | null = TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: token ? { [cookieName]: token } : {} });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { inaturalistRoutes } = await import("./routes.js");
    savedConfig = (await db.query(`SELECT * FROM inat_server_config`)).rows;
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(inaturalistRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      // The server config is one shared row: put back whatever was there.
      await db.query(`DELETE FROM inat_server_config`);
      for (const row of savedConfig as Array<{ client_id: string | null; redirect_uri: string | null }>) {
        await db.query(`INSERT INTO inat_server_config (id, client_id, redirect_uri) VALUES (true, $1, $2)`, [
          row.client_id,
          row.redirect_uri,
        ]);
      }
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("asks for a session before it looks at the body", async () => {
    expect((await call("POST", "/api/inaturalist/observations", { captureIds: "x" }, null)).statusCode).toBe(401);
  });

  it("refuses a malformed server config and saves a good one", async () => {
    const put = (body: unknown) => call("PUT", "/api/inaturalist/server-config", body);
    const cases: Array<[unknown, RegExp]> = [
      [{ clientId: 42 }, /^Invalid body: clientId /],
      [{ clearClientId: "yes" }, /^Invalid body: clearClientId must be boolean$/],
      [{ redirectUri: "", secret: "x" }, /^Invalid body: unexpected field secret$/],
    ];
    for (const [body, message] of cases) {
      const res = await put(body);
      expect([res.statusCode, res.json()]).toEqual([400, invalid(message)]);
    }
    // What the Settings page sends.
    const ok = await put({ clientId: "abc123", redirectUri: "https://lifer.example/api/inaturalist/callback" });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    const row = (await db.query(`SELECT client_id, redirect_uri FROM inat_server_config`)).rows[0];
    expect(row).toEqual({ client_id: "abc123", redirect_uri: "https://lifer.example/api/inaturalist/callback" });
    expect((await put({ clientId: null, redirectUri: "" })).statusCode).toBe(200);
  });

  it("refuses observation requests without well-formed capture ids", async () => {
    const post = (body: unknown) => call("POST", "/api/inaturalist/observations", body);
    const cases: Array<[unknown, RegExp]> = [
      [{}, /^Invalid body: captureIds is required$/],
      [{ captureIds: [] }, /^Invalid body: captureIds /],
      [{ captureIds: CAPTURE }, /^Invalid body: captureIds must be array$/],
      [{ captureIds: ["nope"] }, /^Invalid body: captureIds\.0 must be an id/],
      [{ captureIds: [CAPTURE], regionId: "Alaska" }, /^Invalid body: regionId must be an id/],
      [{ captureIds: [CAPTURE], speciesId: CAPTURE }, /^Invalid body: unexpected field speciesId$/],
    ];
    for (const [body, message] of cases) {
      const res = await post(body);
      expect([res.statusCode, res.json()]).toEqual([400, invalid(message)]);
    }
    // Well-formed: the handler runs and finds no linked account.
    const res = await post({ captureIds: [CAPTURE] });
    expect([res.statusCode, res.json()]).toEqual([409, { error: "iNaturalist account not connected" }]);
  });

  it("treats a non-numeric observation id as not found", async () => {
    const bad = await call("POST", "/api/inaturalist/observations/abc/confirm");
    expect([bad.statusCode, bad.json()]).toEqual([404, { error: "Observation not found or already confirmed" }]);
    const good = await call("POST", "/api/inaturalist/observations/12345/confirm");
    expect([good.statusCode, good.json()]).toEqual([409, { error: "iNaturalist account not connected" }]);
  });

  it("lets iNaturalist's callback through with its own extra parameters", async () => {
    const res = await call("GET", "/api/inaturalist/callback?code=abc&error_description=x", undefined, null);
    expect([res.statusCode, res.json()]).toEqual([400, { error: "Missing code or state" }]);
  });
});
