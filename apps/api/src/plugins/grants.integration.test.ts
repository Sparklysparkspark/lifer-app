// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A grant: the user's click in Lifer allows an app's next launch to pair without the dialog, once,
// for exactly the scopes shown.
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LAUNCH = "grant-test-launch-token";
const HOST = { host: "127.0.0.1:4310" };
const PLUGIN = "com.example.grant-test";
const OTHER = "com.example.grant-other";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SCOPES = ["userdata.read", "imports.write"];

describe.skipIf(!url)("pairing grants", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let pairing: typeof import("./pairing.js");
  let n = 0;
  let ip = "";

  const plugin = (o: InjectOptions) =>
    app.inject({ ...o, remoteAddress: ip, headers: { ...HOST, "x-lifer-client": "1", ...o.headers } } as InjectOptions);
  const lifer = (o: InjectOptions) =>
    app.inject({
      ...o,
      headers: { ...HOST, "x-lifer-client": "1", "x-lifer-launch-token": LAUNCH, ...o.headers },
    } as InjectOptions);
  const grant = (body: object) => lifer({ method: "POST", url: "/api/plugins/v1/grants", payload: body });
  // A Lifer launch of the app (the shell hands over the ticket's hash), then its pair call.
  async function launchAndPair(pluginId: string, scopes: string[], manifest = [...SCOPES, "opendata.read"]) {
    const ticket = sha(`grant-ticket-${++n}`);
    await lifer({
      method: "PUT",
      url: `/api/plugins/v1/host-tickets/${pluginId}`,
      payload: { ticketHash: sha(ticket), name: "Test App", scopes: manifest },
    });
    return plugin({ method: "POST", url: "/api/plugins/v1/pair", payload: { ticket, pluginId, scopes } });
  }
  const consents = async () => (await lifer({ method: "GET", url: "/api/plugins/v1/consents" })).json().consents;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH;
    db = new pg.Pool({ connectionString: url });
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    const { isBlockedCrossSiteWrite } = await import("@lifer/core/lib/requestGuard.js");
    pairing = await import("./pairing.js");
    app = Fastify();
    installSchemas(app);
    app.addHook("onRequest", async (request, reply) => {
      if (isBlockedCrossSiteWrite(request.method, request.headers, [request.headers.host])) {
        return reply.code(403).send({ error: "Cross-site request blocked" });
      }
    });
    await app.register(cookie);
    app.addHook("onRequest", desktopRequestGate(4310));
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  beforeEach(async () => {
    pairing.resetPairingState();
    const { getOrCreateLocalUser } = await import("../auth/session.js");
    const { clearAttempts } = await import("../auth/rateLimiter.js");
    clearAttempts(`grant:${(await getOrCreateLocalUser()).id}`);
    await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
    ip = `10.0.20.${++n % 250}`;
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
      await db.end();
    }
  });

  it("pairs the next launch without a dialog, once, with exactly the scopes asked", async () => {
    expect((await grant({ pluginId: PLUGIN, name: "Test App", scopes: SCOPES })).statusCode).toBe(200);
    const listed = (await lifer({ method: "GET", url: "/api/plugins/v1/grants" })).json().grants;
    expect(listed).toMatchObject([{ pluginId: PLUGIN, scopes: SCOPES }]);

    const res = await launchAndPair(PLUGIN, ["userdata.read"]);
    expect(res.statusCode).toBe(200);
    expect(await consents()).toEqual([]);
    const rows = await db.query(`SELECT permissions FROM api_keys WHERE plugin_id = $1`, [PLUGIN]);
    expect(rows.rows).toEqual([{ permissions: ["userdata.read"] }]);
    // Used up.
    expect((await lifer({ method: "GET", url: "/api/plugins/v1/grants" })).json().grants).toEqual([]);
    await db.query(`DELETE FROM api_keys WHERE plugin_id = $1`, [PLUGIN]);
    const again = launchAndPair(PLUGIN, ["userdata.read"]);
    const [c] = await waitForConsent();
    expect(c).toMatchObject({ pluginId: PLUGIN, kind: "pair" });
    await lifer({ method: "POST", url: `/api/plugins/v1/consents/${c.id}`, payload: { allow: false } });
    expect((await again).statusCode).toBe(403);
  });

  it("asks as before for a scope beyond the grant, another app, or after it expired or was cancelled", async () => {
    await grant({ pluginId: PLUGIN, name: "Test App", scopes: ["userdata.read"] });
    const beyond = launchAndPair(PLUGIN, ["userdata.read", "imports.write"]);
    const [c1] = await waitForConsent();
    expect(c1.scopes).toEqual(["userdata.read", "imports.write"]);
    await lifer({ method: "POST", url: `/api/plugins/v1/consents/${c1.id}`, payload: { allow: false } });
    expect((await beyond).statusCode).toBe(403);

    // Bound to its app.
    const other = launchAndPair(OTHER, ["userdata.read"]);
    const [c2] = await waitForConsent();
    expect(c2.pluginId).toBe(OTHER);
    await lifer({ method: "POST", url: `/api/plugins/v1/consents/${c2.id}`, payload: { allow: false } });
    expect((await other).statusCode).toBe(403);

    // Cancelled in Connected apps.
    expect((await lifer({ method: "DELETE", url: `/api/plugins/v1/grants/${PLUGIN}` })).statusCode).toBe(200);
    const cancelled = launchAndPair(PLUGIN, ["userdata.read"]);
    const [c3] = await waitForConsent();
    await lifer({ method: "POST", url: `/api/plugins/v1/consents/${c3.id}`, payload: { allow: false } });
    expect((await cancelled).statusCode).toBe(403);

    // Expired.
    const g = pairing.createPairGrant({ userId: "u", pluginId: PLUGIN, name: "X", scopes: ["userdata.read"] });
    g.expiresAt = new Date(Date.now() - 1);
    expect(pairing.takePairGrant("u", PLUGIN, ["userdata.read"])).toBe(false);
  });

  it("never pairs an app started on its own, and an app can't grant itself", async () => {
    await grant({ pluginId: PLUGIN, name: "Test App", scopes: SCOPES });
    const req = await plugin({
      method: "POST",
      url: "/api/plugins/v1/pair-requests",
      payload: { pluginId: PLUGIN, name: "Test App", scopes: ["userdata.read"] },
    });
    const { id } = req.json() as { id: string };
    expect((await plugin({ method: "GET", url: `/api/plugins/v1/pair-requests/${id}` })).json()).toEqual({
      status: "pending",
    });

    // No credential, a key, or a web page: refused.
    const body = { pluginId: OTHER, name: "X", scopes: ["userdata.read"] };
    expect((await plugin({ method: "POST", url: "/api/plugins/v1/grants", payload: body })).statusCode).toBe(401);
    const key = await pairing.issuePluginKey(
      (await db.query(`SELECT id FROM users LIMIT 1`)).rows[0].id,
      PLUGIN,
      "Test App",
      ["userdata.read"],
    );
    expect(
      (await plugin({ method: "POST", url: "/api/plugins/v1/grants", payload: body, headers: { "x-api-key": key } }))
        .statusCode,
    ).toBe(401);
    const fromPage = await lifer({
      method: "POST",
      url: "/api/plugins/v1/grants",
      payload: body,
      headers: { origin: "http://127.0.0.1:5000", "sec-fetch-site": "same-site" },
    });
    expect(fromPage.statusCode).toBe(403);
    // Unknown scopes are refused, not dropped.
    expect((await grant({ pluginId: OTHER, name: "X", scopes: ["photos.write"] })).statusCode).toBe(400);
  });

  it("is rate limited", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await grant({ pluginId: OTHER, name: "X", scopes: SCOPES })).statusCode);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
  });

  async function waitForConsent() {
    for (let i = 0; i < 100; i++) {
      const c = await consents();
      if (c.length) return c as Array<{ id: string; pluginId: string; kind: string; scopes: string[] }>;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no consent appeared");
  }
});
