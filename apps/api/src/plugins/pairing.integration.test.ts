// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Desktop pairing over HTTP, through the desktop gate and the cross-site guard as the app runs
// them: a launch ticket plus consent, a silent second launch, Deny, reuse, scopes, the rate
// limit, a request with a code, and revoking.
import { createHash } from "node:crypto";
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LAUNCH = "pairing-test-launch-token";
const HOST = { host: "127.0.0.1:4310" };
const PLUGIN = "com.example.pairing-test";
const OTHER = "com.example.pairing-other";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const ticketFor = (n: number) => sha(`ticket-${n}`);

describe.skipIf(!url)("desktop pairing", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let resetPairingState: () => void;
  let address = 0;
  // Each test calls from its own address, so the per-address limit only trips where it's tested.
  let ip = "";

  const plugin = (o: InjectOptions) =>
    app.inject({ ...o, remoteAddress: ip, headers: { ...HOST, "x-lifer-client": "1", ...o.headers } } as InjectOptions);
  const lifer = (o: InjectOptions) =>
    app.inject({
      ...o,
      headers: { ...HOST, "x-lifer-client": "1", "x-lifer-launch-token": LAUNCH, ...o.headers },
    } as InjectOptions);
  const launch = (pluginId: string, ticket: string, scopes = ["userdata.read", "imports.write"], name = "Test App") =>
    lifer({
      method: "PUT",
      url: `/api/plugins/v1/host-tickets/${pluginId}`,
      payload: { ticketHash: sha(ticket), name, scopes },
    });
  const pair = (body: object) => plugin({ method: "POST", url: "/api/plugins/v1/pair", payload: body });
  const consents = async () =>
    (await lifer({ method: "GET", url: "/api/plugins/v1/consents" })).json().consents as Array<{
      id: string;
      pluginId: string;
      name: string;
      scopes: string[];
      code: string | null;
    }>;
  async function waitForConsent() {
    for (let i = 0; i < 50; i++) {
      const [c] = await consents();
      if (c) return c;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no consent appeared");
  }
  const answer = (id: string, allow: boolean) =>
    lifer({ method: "POST", url: `/api/plugins/v1/consents/${id}`, payload: { allow } });
  const species = (key: string) =>
    plugin({ method: "GET", url: "/api/userdata/v1/species", headers: { "x-api-key": key } });
  const keyRows = (pluginId: string) =>
    db.query(`SELECT permissions FROM api_keys WHERE plugin_id = $1`, [pluginId]).then((r) => r.rows);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    const { isBlockedCrossSiteWrite } = await import("@lifer/core/lib/requestGuard.js");
    ({ resetPairingState } = await import("./pairing.js"));
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
    resetPairingState();
    await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
    ip = `10.0.8.${++address}`;
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
      await db.end();
    }
  });

  it("asks once, pairs silently on the next launch, and a revoked key stops working", async () => {
    expect((await launch(PLUGIN, "t1")).statusCode).toBe(200);
    const first = pair({ ticket: ticketFor(0), pluginId: PLUGIN, scopes: ["userdata.read"] });
    // Not this launch's ticket.
    expect((await first).statusCode).toBe(401);

    const ticket = ticketFor(1);
    await launch(PLUGIN, ticket);
    const waiting = pair({ ticket, pluginId: PLUGIN, scopes: ["userdata.read", "imports.write"] });
    const consent = await waitForConsent();
    // The manifest's name, and exactly the scopes asked for.
    expect(consent).toMatchObject({ pluginId: PLUGIN, name: "Test App", scopes: ["userdata.read", "imports.write"] });
    expect(consent.code).toBeNull();
    expect((await answer(consent.id, true)).statusCode).toBe(200);
    const res = await waiting;
    expect(res.statusCode).toBe(200);
    const { key } = res.json() as { key: string };
    expect(key).toMatch(/^lifer_/);
    expect((await species(key)).statusCode).toBe(200);

    // The ticket was used up.
    ip = "10.0.9.1";
    expect((await pair({ ticket, pluginId: PLUGIN, scopes: ["userdata.read"] })).statusCode).toBe(401);

    // The next launch: a new ticket, no dialog, a new key replacing the old one.
    const next = ticketFor(2);
    await launch(PLUGIN, next);
    const again = await pair({ ticket: next, pluginId: PLUGIN, scopes: ["userdata.read"] });
    expect(again.statusCode).toBe(200);
    expect(await consents()).toEqual([]);
    const newKey = (again.json() as { key: string }).key;
    expect((await species(key)).statusCode).toBe(401);
    expect((await species(newKey)).statusCode).toBe(200);
    expect(await keyRows(PLUGIN)).toEqual([{ permissions: ["userdata.read"] }]);

    // Revoking (L-09 deletes the row) makes the next call 401.
    await db.query(`DELETE FROM api_keys WHERE plugin_id = $1`, [PLUGIN]);
    expect((await species(newKey)).statusCode).toBe(401);
  }, 30_000);

  it("leaves no key when the user denies", async () => {
    const ticket = ticketFor(3);
    await launch(OTHER, ticket);
    const waiting = pair({ ticket, pluginId: OTHER, scopes: ["userdata.read"] });
    const consent = await waitForConsent();
    expect((await answer(consent.id, false)).statusCode).toBe(200);
    expect((await waiting).statusCode).toBe(403);
    expect(await keyRows(OTHER)).toEqual([]);
    // Answered already.
    expect((await answer(consent.id, true)).statusCode).toBe(404);
  });

  it("refuses scopes the manifest doesn't list and scopes that don't exist", async () => {
    const ticket = ticketFor(4);
    await launch(OTHER, ticket, ["userdata.read"]);
    const outside = await pair({ ticket, pluginId: OTHER, scopes: ["userdata.read", "imports.write"] });
    expect(outside.statusCode).toBe(403);
    expect(outside.json().error).toContain("imports.write");
    expect((await pair({ ticket, pluginId: OTHER, scopes: ["photos.write"] })).statusCode).toBe(400);
    expect((await pair({ ticket, pluginId: OTHER, scopes: [] })).statusCode).toBe(400);
    expect(await consents()).toEqual([]);
  });

  it("refuses browsers, page-planted tickets and too many attempts", async () => {
    const ticket = ticketFor(5);
    await launch(OTHER, ticket);
    const fromPage = await plugin({
      method: "POST",
      url: "/api/plugins/v1/pair",
      payload: { ticket, pluginId: OTHER, scopes: ["userdata.read"] },
      headers: { origin: "http://127.0.0.1:5000", "sec-fetch-site": "same-site" },
    });
    expect(fromPage.statusCode).toBe(403);
    // Only the shell's own header sets a ticket: no credential at all, then the window's cookie.
    const planted = { method: "PUT", url: `/api/plugins/v1/host-tickets/${OTHER}` } as const;
    const body = { ticketHash: sha("x"), name: "X", scopes: ["userdata.read"] };
    expect((await plugin({ ...planted, payload: body })).statusCode).toBe(401);
    const { localSessionCookieValue } = await import("../auth/localCredential.js");
    const withCookie = await plugin({
      ...planted,
      payload: body,
      cookies: { lifer_desktop: localSessionCookieValue(LAUNCH) },
    });
    expect(withCookie.statusCode).toBe(404);
    // Neither can a plugin key.
    expect((await plugin({ ...planted, payload: body, headers: { "x-api-key": "lifer_x" } })).statusCode).toBe(401);

    const wrong = { ticket: "f".repeat(64), pluginId: OTHER, scopes: ["userdata.read"] };
    ip = "10.0.10.1";
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await pair(wrong)).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429]);
  }, 60_000);

  it("pairs an app started on its own after the user compares its code", async () => {
    const created = await plugin({
      method: "POST",
      url: "/api/plugins/v1/pair-requests",
      payload: { pluginId: OTHER, name: "N".repeat(200), scopes: ["userdata.read", "imports.write", "opendata.read"] },
    });
    expect(created.statusCode).toBe(200);
    const { id, code } = created.json() as { id: string; code: string };
    expect(code).toMatch(/^\d{6}$/);
    const poll = () => plugin({ method: "GET", url: `/api/plugins/v1/pair-requests/${id}` });
    expect((await poll()).json()).toEqual({ status: "pending" });

    const [consent] = await consents();
    expect(consent).toMatchObject({ id, code, name: "N".repeat(200) });
    expect(consent.scopes).toEqual(["userdata.read", "imports.write", "opendata.read"]);
    await answer(id, true);
    const done = (await poll()).json() as { status: string; key: string };
    expect(done.status).toBe("approved");
    expect((await species(done.key)).statusCode).toBe(200);
    // The key is handed over once.
    expect((await poll()).statusCode).toBe(404);
    expect((await plugin({ method: "GET", url: `/api/plugins/v1/pair-requests/${"0".repeat(64)}` })).statusCode).toBe(
      404,
    );
  });

  it("withdraws a request whose app hung up", async () => {
    const { createPairRequest, cancelPairRequest, pendingPairRequests } = await import("./pairing.js");
    const r = createPairRequest({ userId: "u", pluginId: OTHER, name: "X", scopes: ["userdata.read"], code: null });
    cancelPairRequest(r.id);
    expect(await r.done).toEqual({ status: "expired" });
    expect(pendingPairRequests("u")).toEqual([]);
  });

  it("waits a moment for a ticket the shell hasn't passed over yet", async () => {
    const ticket = ticketFor(6);
    const waiting = pair({ ticket, pluginId: OTHER, scopes: ["userdata.read"] });
    await new Promise((r) => setTimeout(r, 300));
    await launch(OTHER, ticket);
    const consent = await waitForConsent();
    await answer(consent.id, false);
    expect((await waiting).statusCode).toBe(403);
  });

  it("doesn't hand out server pairing codes or take them on the desktop", async () => {
    expect((await lifer({ method: "POST", url: "/api/plugins/v1/pair-codes" })).statusCode).toBe(404);
    const res = await pair({ code: "123456", pluginId: OTHER, scopes: ["userdata.read"], name: "X" });
    expect(res.statusCode).toBe(400);
  });
});
