// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Account and API key routes validate their bodies: the sign-in, setup and account forms keep the
// plain sentences people see, and API keys only take scopes that exist.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000621";
const EMAIL = "auth-routes@test";
const PASSWORD = "correct horse";
const TOKEN = "lifer_test_auth_routes_user_621";
const NO_SUCH = "eeeeeeee-0000-4000-8000-0000000006fd";
const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("auth and API key routes input validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let hashToken: (token: string) => string;

  const call = (method: "GET" | "POST" | "PUT" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  // Changing the password or email rotates sessions, so the test session is put back after.
  const restoreSession = () =>
    db.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day') ON CONFLICT DO NOTHING`,
      [hashToken(TOKEN), USER],
    );

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-auth-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    ({ hashToken } = await import("./session.js"));
    const { hashPassword } = await import("./password.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { authRoutes } = await import("./routes.js");
    const { apiKeyRoutes } = await import("./apiKeyRoutes.js");

    await db.query(`DELETE FROM users WHERE id = $1 OR email = $2`, [USER, EMAIL]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)`, [
      USER,
      EMAIL,
      await hashPassword(PASSWORD),
    ]);
    await restoreSession();

    app = Fastify();
    await app.register(cookie);
    await app.register(authRoutes, { prefix: "/api" });
    await app.register(apiKeyRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps the sign-in and setup forms' message for any malformed body", async () => {
    for (const route of ["/api/auth/login", "/api/auth/register"]) {
      for (const body of [undefined, {}, { email: EMAIL }, { email: "", password: "x" }, { email: 5, password: "x" }]) {
        const res = await app.inject({ method: "POST", url: route, payload: body as object });
        expect([route, body, res.statusCode, res.json()]).toEqual([
          route,
          body,
          400,
          { error: "email and password are required" },
        ]);
      }
    }
    // The setup page's own length rule still answers with its sentence.
    const short = await app.inject({
      method: "POST",
      url: "/api/auth/register",
      payload: { email: "a@b", password: "short" },
    });
    expect([short.statusCode, short.json()]).toEqual([400, { error: "Password must be at least 8 characters" }]);
  });

  it("signs in with what the web and desktop apps send, and refuses a wrong password alike", async () => {
    const ok = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { email: EMAIL, password: PASSWORD },
    });
    expect([ok.statusCode, ok.json()]).toEqual([200, { id: USER, email: EMAIL }]);
    for (const email of [EMAIL, "nobody@test"]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { email, password: "nope nope" },
      });
      expect([res.statusCode, res.json()]).toEqual([401, { error: "Invalid email or password" }]);
    }
  });

  it("refuses malformed account changes before checking the password", async () => {
    const pw = await call("PUT", "/api/auth/password", { currentPassword: PASSWORD });
    expect([pw.statusCode, pw.json()]).toEqual([400, { error: "currentPassword and newPassword are required" }]);
    const email = await call("PUT", "/api/auth/email", { currentPassword: PASSWORD, newEmail: ["x"] });
    expect([email.statusCode, email.json()]).toEqual([400, { error: "currentPassword and newEmail are required" }]);

    const changed = await call("PUT", "/api/auth/email", { currentPassword: PASSWORD, newEmail: " Auth-Routes@Test " });
    expect([changed.statusCode, changed.json()]).toEqual([200, { email: EMAIL }]);
    await restoreSession();
    const signedOut = await app.inject({ method: "PUT", url: "/api/auth/password", payload: {} });
    expect(signedOut.statusCode).toBe(401);
  });

  it("creates API keys only with real scopes and deletes them by id", async () => {
    const create = (body: unknown) => call("POST", "/api/api-keys", body);
    expect((await create({ name: "x", permissions: ["photos.delete"] })).json()).toEqual(
      invalid(/^Invalid body: permissions\.0 must be one of /),
    );
    expect((await create({ name: "x", permissions: [] })).statusCode).toBe(400);
    expect((await create({ permissions: ["photos.read"] })).json()).toEqual(invalid(/name is required/));
    expect((await create({ name: "x", permissions: ["photos.read"], admin: true })).statusCode).toBe(400);
    expect((await create({ name: "   ", permissions: ["photos.read"] })).json()).toEqual({ error: "name is required" });

    const created = await create({ name: "Home Assistant", permissions: ["collection.read", "photos.read"] });
    expect(created.json()).toMatchObject({ name: "Home Assistant", permissions: ["collection.read", "photos.read"] });

    for (const id of ["nope", NO_SUCH]) {
      const res = await call("DELETE", `/api/api-keys/${id}`);
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Key not found" }]);
    }
    expect((await call("DELETE", `/api/api-keys/${created.json().id}`)).json()).toEqual({ ok: true });
  });
});
