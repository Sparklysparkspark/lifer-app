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
    query: vi.fn(async (sql: string) => {
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

describe("GET /health", () => {
  it("gives the non-secret launch id, never the launch secret", async () => {
    const { registerHealthRoute } = await import("../lib/health.js");
    const app = Fastify();
    registerHealthRoute(app, { LIFER_LAUNCH_TOKEN: TOKEN, LIFER_LAUNCH_ID: "launch-id-1" });
    const res = await app.inject({ method: "GET", url: "/health" });
    await app.close();
    expect(res.json()).toEqual({ ok: true, launchId: "launch-id-1" });
    expect(res.body).not.toContain(TOKEN);
  });
});
