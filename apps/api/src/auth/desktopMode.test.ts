// Desktop mode (SINGLE_USER_MODE) signs in only the desktop app's own requests: the launch secret
// in a header, or the cookie the app's window trades it for. Other local programs get a 401.
// Real route plugins, a stubbed database.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@lifer/core/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/config.js")>()),
  SINGLE_USER_MODE: true,
}));
vi.mock("@lifer/core/db.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/db.js")>()),
  pool: {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM api_keys k")) {
        const { hashApiKey } = await import("./apiKeys.js");
        const permissions: Record<string, string[]> = {
          [hashApiKey("plugin-key")]: ["userdata.read", "opendata.read"],
          [hashApiKey("device-key")]: ["companion"],
          [hashApiKey("broad-key")]: ["photos.read", "species.read", "photos.write", "sync"],
        };
        const found = permissions[String(params?.[0])];
        return {
          rows: found
            ? [
                {
                  id: "k1",
                  user_id: "00000000-0000-4000-8000-000000000001",
                  permissions: found,
                  email: "local@lifer.app",
                },
              ]
            : [],
        };
      }
      if (sql.includes("INSERT INTO users")) return { rows: [{ id: "00000000-0000-4000-8000-000000000001" }] };
      if (sql.includes("SELECT email FROM users")) return { rows: [{ email: "local@lifer.app" }] };
      return { rows: [] };
    }),
  },
}));

const TOKEN = "launch-secret-for-tests";
const HOST = { host: "127.0.0.1:4310" };

async function buildApp(withGate: boolean): Promise<FastifyInstance> {
  const { apiRoutes } = await import("../apiRoutes.js");
  const { installSchemas } = await import("../lib/schema.js");
  const { desktopRequestGate } = await import("./desktopGate.js");
  const app = Fastify();
  installSchemas(app);
  await app.register(cookie);
  if (withGate) app.addHook("onRequest", desktopRequestGate(4310));
  await app.register(apiRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

describe("desktop mode sign-in", () => {
  let gated: FastifyInstance;
  let ungated: FastifyInstance;
  const savedToken = process.env.LIFER_LAUNCH_TOKEN;

  beforeAll(async () => {
    process.env.LIFER_LAUNCH_TOKEN = TOKEN;
    gated = await buildApp(true);
    ungated = await buildApp(false);
    // Importing every route plugin takes a while the first time.
  }, 60_000);
  afterAll(async () => {
    await gated.close();
    await ungated.close();
    if (savedToken === undefined) delete process.env.LIFER_LAUNCH_TOKEN;
    else process.env.LIFER_LAUNCH_TOKEN = savedToken;
  });

  it("refuses a local program that has no credential", async () => {
    const res = await gated.inject({ method: "GET", url: "/api/auth/settings", headers: HOST });
    expect(res.statusCode).toBe(401);
    const write = await gated.inject({
      method: "DELETE",
      url: "/api/captures/00000000-0000-4000-8000-000000000009",
      headers: { ...HOST, "x-lifer-client": "1" },
    });
    expect(write.statusCode).toBe(401);
  });

  it("refuses it in the sign-in hooks too, not only at the gate", async () => {
    expect((await ungated.inject({ method: "GET", url: "/api/auth/settings", headers: HOST })).statusCode).toBe(401);
    expect((await ungated.inject({ method: "GET", url: "/api/albums", headers: HOST })).statusCode).toBe(401);
  });

  it("refuses a wrong secret", async () => {
    const res = await gated.inject({
      method: "GET",
      url: "/api/auth/settings",
      headers: { ...HOST, "x-lifer-launch-token": `${TOKEN}x` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("signs in the launch secret as the local user", async () => {
    const res = await gated.inject({
      method: "GET",
      url: "/api/auth/settings",
      headers: { ...HOST, "x-lifer-launch-token": TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ email: "local@lifer.app" });
  });

  it("trades the secret for an HttpOnly, SameSite=Strict cookie that signs in later requests", async () => {
    const denied = await gated.inject({
      method: "POST",
      url: "/api/auth/desktop-session",
      headers: { ...HOST, "x-lifer-client": "1" },
    });
    expect(denied.statusCode).toBe(401);

    const res = await gated.inject({
      method: "POST",
      url: "/api/auth/desktop-session",
      headers: { ...HOST, "x-lifer-client": "1", "x-lifer-launch-token": TOKEN },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers["set-cookie"]);
    expect(setCookie).toMatch(/^lifer_desktop=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    expect(setCookie).not.toMatch(/Expires|Max-Age/);
    // The cookie isn't the secret itself.
    expect(setCookie).not.toContain(TOKEN);

    const value = res.cookies.find((c) => c.name === "lifer_desktop")!.value;
    const me = await gated.inject({
      method: "GET",
      url: "/api/auth/me",
      headers: HOST,
      cookies: { lifer_desktop: value },
    });
    expect(me.json()).toEqual({ user: { id: "00000000-0000-4000-8000-000000000001", email: "local@lifer.app" } });
    const settings = await gated.inject({
      method: "GET",
      url: "/api/auth/settings",
      headers: HOST,
      cookies: { lifer_desktop: value },
    });
    expect(settings.statusCode).toBe(200);
  });

  it("doesn't accept a cookie from another launch, or the secret as the cookie", async () => {
    const { localSessionCookieValue } = await import("./localCredential.js");
    for (const value of [localSessionCookieValue("an-older-launch"), TOKEN]) {
      const res = await gated.inject({
        method: "GET",
        url: "/api/auth/settings",
        headers: HOST,
        cookies: { lifer_desktop: value },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("keeps the public routes public, without signing anyone in", async () => {
    const me = await gated.inject({ method: "GET", url: "/api/auth/me", headers: HOST });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ user: null });
    expect((await gated.inject({ method: "GET", url: "/api/openapi.json", headers: HOST })).statusCode).toBe(200);
  });

  it("still refuses other hosts and relayed requests", async () => {
    const headers = { "x-lifer-launch-token": TOKEN };
    expect(
      (
        await gated.inject({
          method: "GET",
          url: "/api/auth/settings",
          headers: { ...headers, host: "evil.example:4310" },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await gated.inject({
          method: "GET",
          url: "/api/auth/settings",
          headers: { ...headers, ...HOST, "x-forwarded-for": "10.0.0.2" },
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe("desktop mode plugin keys", () => {
  let gated: FastifyInstance;
  const savedToken = process.env.LIFER_LAUNCH_TOKEN;

  beforeAll(async () => {
    process.env.LIFER_LAUNCH_TOKEN = TOKEN;
    gated = await buildApp(true);
  }, 60_000);
  afterAll(async () => {
    await gated.close();
    if (savedToken === undefined) delete process.env.LIFER_LAUNCH_TOKEN;
    else process.env.LIFER_LAUNCH_TOKEN = savedToken;
  });

  const get = (url: string, headers: Record<string, string> = {}) =>
    gated.inject({ method: "GET", url, headers: { ...HOST, ...headers } });

  it("lets a key with a plugin scope reach that scope's route", async () => {
    expect((await get("/api/userdata/v1/species", { "x-api-key": "plugin-key" })).statusCode).toBe(200);
    expect((await get("/api/opendata/v1/regions", { "x-api-key": "plugin-key" })).statusCode).toBe(200);
    const head = { ...HOST, "x-api-key": "plugin-key" };
    expect((await gated.inject({ method: "HEAD", url: "/api/userdata/v1/species", headers: head })).statusCode).toBe(
      200,
    );
  });

  it("refuses a plugin key on every route without a plugin scope", async () => {
    const { routeCatalog } = await import("../lib/schema.js");
    const { PLUGIN_SCOPES, APP_KEY_ROUTES } = await import("./desktopGate.js");
    const others = [...routeCatalog.values()].filter(
      (r) => r.auth !== null && !PLUGIN_SCOPES.has(r.scope ?? "") && !APP_KEY_ROUTES.has(`${r.method} ${r.url}`),
    );
    expect(others.length).toBeGreaterThan(10);
    for (const r of others) {
      const res = await gated.inject({
        method: r.method as "GET",
        url: r.url.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000009"),
        headers: { ...HOST, "x-api-key": "plugin-key" },
      });
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it("lets keys reach only the app-key photo route, with a missing scope told apart", async () => {
    const { APP_KEY_ROUTES } = await import("./desktopGate.js");
    expect([...APP_KEY_ROUTES]).toEqual(["POST /api/captures/:id/species"]);
    const add = (key: string) =>
      gated.inject({
        method: "POST",
        url: "/api/captures/00000000-0000-4000-8000-000000000009/species",
        headers: { ...HOST, "x-api-key": key },
        payload: { speciesId: "00000000-0000-4000-8000-000000000008" },
      });
    const missing = await add("plugin-key");
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: "missing_scope" });
    expect((await add("nope")).statusCode).toBe(401);
    // A photos.write key gets past the scope check but not to a photo its key didn't import.
    expect((await add("broad-key")).statusCode).toBe(404);
  });

  it("refuses keys without a plugin scope, even on routes their scope covers", async () => {
    expect((await get("/api/captures", { "x-api-key": "broad-key" })).statusCode).toBe(401);
    expect((await get("/api/userdata/v1/species", { "x-api-key": "broad-key" })).statusCode).toBe(401);
  });

  it("refuses no key, an unknown key and a key sent from a web page", async () => {
    expect((await get("/api/userdata/v1/species")).statusCode).toBe(401);
    expect((await get("/api/userdata/v1/species", { "x-api-key": "nope" })).statusCode).toBe(401);
    for (const origin of ["http://127.0.0.1:5555", "null", ""]) {
      const fromPage = { "x-api-key": "plugin-key", origin };
      expect((await get("/api/userdata/v1/species", fromPage)).statusCode, origin).toBe(401);
    }
  });

  it("still refuses other hosts and relayed requests with a valid key", async () => {
    const key = { "x-api-key": "plugin-key" };
    expect((await get("/api/userdata/v1/species", { ...key, host: "evil.example:4310" })).statusCode).toBe(403);
    expect((await get("/api/userdata/v1/species", { ...key, "x-forwarded-for": "10.0.0.2" })).statusCode).toBe(403);
  });

  it("lets a device key reach the routes that accept the companion scope, and no others", async () => {
    const { routeCatalog } = await import("../lib/schema.js");
    const { PLUGIN_SCOPES, MCP_SCOPES, COMPANION_SCOPES } = await import("./desktopGate.js");
    const key = { ...HOST, "x-api-key": "device-key" };
    expect((await gated.inject({ method: "GET", url: "/api/sync/user-species", headers: key })).statusCode).toBe(200);
    const refused = [...routeCatalog.values()].filter(
      (r) =>
        r.method === "GET" &&
        r.auth !== null &&
        ![r.scope ?? "", ...r.alsoAccepts].some(
          (s) => COMPANION_SCOPES.has(s) || PLUGIN_SCOPES.has(s) || MCP_SCOPES.has(s),
        ),
    );
    expect(refused.length).toBeGreaterThan(10);
    for (const r of refused) {
      const url = r.url.replace(/:[A-Za-z]+/g, "00000000-0000-4000-8000-000000000009");
      expect((await gated.inject({ method: "GET", url, headers: key })).statusCode, r.url).toBe(401);
    }
  });

  it("lists only real scopes as plugin scopes", async () => {
    const { API_KEY_SCOPES } = await import("./apiKeyRoutes.js");
    const { PLUGIN_SCOPES, MCP_SCOPES, COMPANION_SCOPES } = await import("./desktopGate.js");
    for (const scope of [...PLUGIN_SCOPES, ...MCP_SCOPES, ...COMPANION_SCOPES]) expect(API_KEY_SCOPES).toContain(scope);
    // The MCP server never gets to import, edit photos or share.
    for (const scope of ["photos.write", "imports.write", "share.write", "sync"])
      expect(MCP_SCOPES.has(scope)).toBe(false);
  });
});

describe("GET /health", () => {
  it("gives the non-secret launch id, never the launch secret", async () => {
    const { registerHealthRoute } = await import("../lib/health.js");
    const app = Fastify();
    registerHealthRoute(app, { LIFER_LAUNCH_TOKEN: TOKEN, LIFER_LAUNCH_ID: "launch-id-1" }, async () => "inst-1");
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    expect(res.json()).toEqual({
      ok: true,
      launchId: "launch-id-1",
      instanceId: "inst-1",
      syncProtocol: 2,
      version: "dev",
    });
    expect(res.body).not.toContain(TOKEN);
  });
});
