// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Server pairing: the signed-in user's code, typed into an app on another computer, is traded
// once for a key to that user's own data.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000801";
const EMAIL = "pairing-server@test";
const SESSION = "lifer_test_pairing_server_session_801";
const PLUGIN = "com.example.pairing-server";

describe.skipIf(!url)("server pairing codes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const pair = (body: object, remoteAddress = "10.0.20.1") =>
    app.inject({ method: "POST", url: "/api/plugins/v1/pair", payload: body, remoteAddress });
  const newCode = async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/plugins/v1/pair-codes",
      cookies: { [cookieName]: SESSION },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { code: string }).code;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    await db.query(`DELETE FROM users WHERE id = $1 OR email = $2`, [USER, EMAIL]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [USER, EMAIL]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(SESSION),
      USER,
    ]);
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
  });

  it("needs a signed-in user to make a code", async () => {
    expect((await app.inject({ method: "POST", url: "/api/plugins/v1/pair-codes" })).statusCode).toBe(401);
  });

  it("trades a code once for a key to the user's own data", async () => {
    const code = await newCode();
    expect(code).toMatch(/^\d{6}$/);
    const body = { code, pluginId: PLUGIN, name: "Other Computer App", scopes: ["userdata.read"] };
    const res = await pair(body);
    expect(res.statusCode).toBe(200);
    const { key } = res.json() as { key: string };
    const rows = await db.query(`SELECT user_id, name, permissions FROM api_keys WHERE plugin_id = $1`, [PLUGIN]);
    expect(rows.rows).toEqual([{ user_id: USER, name: "Other Computer App", permissions: ["userdata.read"] }]);
    const data = await app.inject({ method: "GET", url: "/api/userdata/v1/species", headers: { "x-api-key": key } });
    expect(data.statusCode).toBe(200);
    // Single use.
    expect((await pair(body, "10.0.20.2")).statusCode).toBe(401);
  });

  it("refuses a missing name, tickets, desktop requests and browsers", async () => {
    const code = await newCode();
    expect((await pair({ code, pluginId: PLUGIN, scopes: ["userdata.read"] }, "10.0.21.1")).statusCode).toBe(400);
    const ticket = { ticket: "a".repeat(64), pluginId: PLUGIN, scopes: ["userdata.read"] };
    expect((await pair(ticket, "10.0.21.1")).statusCode).toBe(400);
    const request = await app.inject({
      method: "POST",
      url: "/api/plugins/v1/pair-requests",
      payload: { pluginId: PLUGIN, name: "X", scopes: ["userdata.read"] },
    });
    expect(request.statusCode).toBe(404);
    const fromPage = await app.inject({
      method: "POST",
      url: "/api/plugins/v1/pair",
      payload: { code, pluginId: PLUGIN, name: "X", scopes: ["userdata.read"] },
      headers: { origin: "https://example.com" },
      remoteAddress: "10.0.21.2",
    });
    expect(fromPage.statusCode).toBe(403);
    // The code survived all of that.
    expect((await pair({ code, pluginId: PLUGIN, name: "X", scopes: ["userdata.read"] }, "10.0.21.3")).statusCode).toBe(
      200,
    );
  });
});
