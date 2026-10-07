// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Input validation on the originals routes: a malformed id is "Not found" like an unknown one,
// and a server answers "desktop only" before it looks at a reveal request's body.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000801";
const TOKEN = "lifer_test_originals_routes_801";

describe.skipIf(!url)("originals routes input", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;

  const call = (method: "GET" | "POST", route: string, payload?: unknown, token: string | null = TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: token ? { [cookieName]: token } : {} });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-originals-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { originalsRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'originals-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(originalsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("answers a malformed original id with the same 404 as an unknown one", async () => {
    for (const id of ["nope", "eeeeeeee-0000-4000-8000-0000000008ff"]) {
      const res = await call("GET", `/api/originals/${id}/download`);
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Not found" }]);
    }
  });

  it("asks for a session before anything else", async () => {
    expect((await call("GET", "/api/originals/nope/download", undefined, null)).statusCode).toBe(401);
    expect((await call("POST", "/api/originals/reveal", { path: 5 }, null)).statusCode).toBe(401);
  });

  it("says reveal is desktop only on a server, whatever the body", async () => {
    for (const body of [{}, { path: 5 }, { path: "/x" }]) {
      const res = await call("POST", "/api/originals/reveal", body);
      expect([res.statusCode, res.json()]).toEqual([
        404,
        { error: "Only available in the desktop app", code: "desktop_only" },
      ]);
    }
  });
});
