// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Input validation on the library routes. No test here starts a reimport: every request either
// fails validation or stops in the handler before the job.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000821";
const TOKEN = "lifer_test_library_routes_821";
const invalid = (message: RegExp) => ({ error: expect.stringMatching(message), code: "invalid_request" });

describe.skipIf(!url)("library routes input", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;

  const call = (method: "GET" | "POST", route: string, payload?: unknown, token: string | null = TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: token ? { [cookieName]: token } : {} });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-library-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { libraryRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'library-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(libraryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM ignored_library_files WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a malformed reimport request before starting anything", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ volumeId: "nas" }, /^Invalid body: volumeId must be an id/],
      [{ path: 7 }, /^Invalid body: path must be string$/],
      [{ path: "/x", organize: "yes" }, /^Invalid body: organize must be boolean$/],
      [{ folder: "/x" }, /^Invalid body: unexpected field folder$/],
    ];
    for (const [body, message] of cases) {
      const res = await call("POST", "/api/library/reimport", body);
      expect([res.statusCode, res.json()]).toEqual([400, invalid(message)]);
    }
    // Well-formed bodies reach the handler's own checks.
    const relative = await call("POST", "/api/library/reimport", { path: "photos", organize: true });
    expect([relative.statusCode, relative.json()]).toEqual([400, { error: "path must be an absolute folder path" }]);
    const drive = await call("POST", "/api/library/reimport", { volumeId: "eeeeeeee-0000-4000-8000-0000000008ff" });
    expect([drive.statusCode, drive.json()]).toEqual([400, { error: "That drive isn't connected right now" }]);
    expect((await call("GET", "/api/library/reimport/status")).json()).toMatchObject({ running: false });
  });

  it("needs a content hash to ignore a file", async () => {
    for (const [body, message] of [
      [{}, /^Invalid body: contentHash is required$/],
      [{ contentHash: 5 }, /^Invalid body: contentHash must be string$/],
      [{ contentHash: "" }, /^Invalid body: contentHash /],
      [{ contentHash: "abc", all: true }, /^Invalid body: unexpected field all$/],
    ] as Array<[unknown, RegExp]>) {
      const res = await call("POST", "/api/library/ignore", body);
      expect([res.statusCode, res.json()]).toEqual([400, invalid(message)]);
    }
    const ok = await call("POST", "/api/library/ignore", { contentHash: "abc" });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    const rows = await db.query(`SELECT content_hash FROM ignored_library_files WHERE user_id = $1`, [USER]);
    expect(rows.rows).toEqual([{ content_hash: "abc" }]);
  });

  it("answers a preview index that isn't a list position with 404, as before", async () => {
    for (const index of ["x", "-1", "1.5"]) {
      const res = await call("GET", `/api/library/reimport/unmatched-preview/${index}`);
      expect([index, res.statusCode, res.json()]).toEqual([index, 404, { error: "Not found" }]);
    }
  });
});
