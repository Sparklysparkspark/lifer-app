// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A connected app's "open inside Lifer" preference over HTTP, through the desktop gate: the scope,
// asking, Yes, Not now, expiry, the Settings switch, and asking Lifer to open the app.
import Fastify, { type FastifyInstance, type InjectOptions } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LAUNCH = "host-pref-test-launch-token";
const HOST = { host: "127.0.0.1:4310" };
const PLUGIN = "com.example.host-pref-test";
const OTHER = "com.example.host-pref-other";
const HAND_MADE = "lifer_host-pref-hand-made-key";

describe.skipIf(!url)("connected app host preference", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let userId = "";
  let key = "";
  let mod: typeof import("./pairing.js");
  let host: typeof import("./hostPreference.js");

  const asApp = (o: InjectOptions, k = key) =>
    app.inject({ ...o, headers: { ...HOST, "x-api-key": k, ...o.headers } } as InjectOptions);
  const lifer = (o: InjectOptions) =>
    app.inject({
      ...o,
      headers: { ...HOST, "x-lifer-client": "1", "x-lifer-launch-token": LAUNCH, ...o.headers },
    } as InjectOptions);
  const ask = (k = key, openInHost = true) =>
    asApp({ method: "POST", url: "/api/plugins/v1/host-preference/request", payload: { openInHost } }, k);
  // Lifer's window looking for opens, as HostOpenListener does every 2 s.
  const opensNow = async () =>
    (await lifer({ method: "GET", url: "/api/plugins/v1/host/opens" })).json().opens as Array<{
      id: string;
      pluginId: string;
    }>;
  async function nextOpen() {
    for (let i = 0; i < 50; i++) {
      const [o] = await opensNow();
      if (o) return o;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no open appeared");
  }
  const pref = (k = key) => asApp({ method: "GET", url: "/api/plugins/v1/host-preference" }, k);
  const open = (pluginId = PLUGIN) =>
    asApp({ method: "POST", url: "/api/plugins/v1/host/open", payload: { pluginId } });
  async function waitForConsent() {
    for (let i = 0; i < 50; i++) {
      const res = await lifer({ method: "GET", url: "/api/plugins/v1/consents" });
      const [c] = res.json().consents as Array<{ id: string; kind: string; name: string; pluginId: string }>;
      if (c) return c;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("no consent appeared");
  }
  const answer = (id: string, allow: boolean) =>
    lifer({ method: "POST", url: `/api/plugins/v1/consents/${id}`, payload: { allow } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH;
    db = new pg.Pool({ connectionString: url });
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    const { getOrCreateLocalUser } = await import("../auth/session.js");
    mod = await import("./pairing.js");
    host = await import("./hostPreference.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    app.addHook("onRequest", desktopRequestGate(4310));
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
    userId = (await getOrCreateLocalUser()).id;
  }, 60_000);

  beforeEach(async () => {
    mod.resetPairingState();
    host.resetHostOpens();
    await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
    key = await mod.issuePluginKey(userId, PLUGIN, "Test App", ["host.preference"]);
    const { hashApiKey } = await import("../auth/apiKeys.js");
    await db.query(`DELETE FROM api_keys WHERE key_hash = $1`, [hashApiKey(HAND_MADE)]);
    // Each test starts with a fresh rate limit budget.
    (await import("../auth/rateLimiter.js")).clearAttempts(`host:${PLUGIN}`);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM api_keys WHERE plugin_id = ANY($1)`, [[PLUGIN, OTHER]]);
      await db.end();
    }
  });

  it("is off by default, and needs a paired app's key", async () => {
    expect((await pref()).json()).toEqual({ openInHost: false });
    // A key paired before host.preference existed still reaches these routes.
    const older = await mod.issuePluginKey(userId, OTHER, "Other", ["userdata.read"]);
    expect((await pref(older)).json()).toEqual({ openInHost: false });
    // ...and nothing it couldn't reach before.
    expect(
      (
        await asApp(
          { method: "POST", url: "/api/imports/v1/species-lookup", payload: { scientificNames: ["x"] } },
          older,
        )
      ).statusCode,
    ).toBe(401);
    // A key the user made by hand isn't an app.
    const { hashApiKey } = await import("../auth/apiKeys.js");
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'hand', $2, $3)`, [
      userId,
      hashApiKey(HAND_MADE),
      ["userdata.read"],
    ]);
    expect((await pref(HAND_MADE)).statusCode).toBe(403);
    expect((await pref("lifer_nope")).statusCode).toBe(401);
    // Lifer's own window isn't an app.
    expect((await lifer({ method: "GET", url: "/api/plugins/v1/host-preference" })).statusCode).toBe(403);
    // A key sent from a web page.
    expect(
      (await asApp({ method: "GET", url: "/api/plugins/v1/host-preference", headers: { origin: "null" } })).statusCode,
    ).toBe(401);
    const bad = await asApp({
      method: "POST",
      url: "/api/plugins/v1/host-preference/request",
      payload: { openInHost: "yes" },
    });
    expect(bad.statusCode).toBe(400);
  });

  it("asks before turning it off too", async () => {
    await host.setHostOpen(userId, PLUGIN, true);
    const waiting = ask(key, false);
    const c = await waitForConsent();
    expect(c).toMatchObject({ kind: "hostPreference", openInHost: false });
    await answer(c.id, true);
    expect((await waiting).json()).toEqual({ granted: true, openInHost: false });
    expect((await pref()).json()).toEqual({ openInHost: false });
    // Already off: no dialog.
    expect((await ask(key, false)).json()).toEqual({ granted: true, openInHost: false });
  });

  it("asks, and turns on only when the person says yes", async () => {
    const waiting = ask();
    const consent = await waitForConsent();
    expect(consent).toMatchObject({ kind: "hostPreference", pluginId: PLUGIN, name: "Test App" });
    // A second ask joins the same dialog.
    const again = ask();
    await new Promise((r) => setTimeout(r, 50));
    expect((await lifer({ method: "GET", url: "/api/plugins/v1/consents" })).json().consents).toHaveLength(1);
    // Never handed out by the pairing poll.
    expect(
      (await app.inject({ method: "GET", url: `/api/plugins/v1/pair-requests/${consent.id}`, headers: HOST }))
        .statusCode,
    ).toBe(404);
    expect((await answer(consent.id, true)).statusCode).toBe(200);
    expect((await waiting).json()).toEqual({ granted: true, openInHost: true });
    expect((await again).json()).toEqual({ granted: true, openInHost: true });
    expect((await pref()).json()).toEqual({ openInHost: true });
    // Already on: no dialog.
    expect((await ask()).json()).toEqual({ granted: true, openInHost: true });
  });

  it("changes nothing on Not now or when nobody answers", async () => {
    const waiting = ask();
    await answer((await waitForConsent()).id, false);
    expect((await waiting).json()).toEqual({ granted: false, openInHost: false });

    const expiring = ask();
    const c = await waitForConsent();
    mod.settlePairRequest(c.id, { status: "expired" });
    expect((await expiring).json()).toEqual({ granted: false, openInHost: false });
    expect((await pref()).json()).toEqual({ openInHost: false });
  });

  it("lets the person flip it in Settings, and only for paired apps", async () => {
    const put = (pluginId: string, openInHost: boolean) =>
      lifer({ method: "PUT", url: `/api/plugins/v1/apps/${pluginId}/host-preference`, payload: { openInHost } });
    expect((await put(PLUGIN, true)).json()).toEqual({ openInHost: true });
    expect((await lifer({ method: "GET", url: `/api/plugins/v1/apps/${PLUGIN}/host-preference` })).json()).toEqual({
      openInHost: true,
    });
    expect((await put(PLUGIN, false)).json()).toEqual({ openInHost: false });
    expect((await put(OTHER, true)).statusCode).toBe(404);
    // An app's key can't use Lifer's own routes.
    const viaKey = await asApp({
      method: "PUT",
      url: `/api/plugins/v1/apps/${PLUGIN}/host-preference`,
      payload: { openInHost: true },
    });
    expect(viaKey.statusCode).toBe(401);
    expect((await pref()).json()).toEqual({ openInHost: false });
  });

  it("opens only itself, once turned on, answering ok once the frame shows", async () => {
    await opensNow();
    expect((await open()).statusCode).toBe(403);
    await host.setHostOpen(userId, PLUGIN, true);
    expect((await open(OTHER)).statusCode).toBe(403);

    const opening = open();
    const { id } = await nextOpen();
    // Busy while that one is still being opened.
    expect((await open()).json()).toEqual({ ok: false, reason: "busy" });
    expect((await lifer({ method: "POST", url: `/api/plugins/v1/host/opens/${id}/claim` })).statusCode).toBe(200);
    // Taken: no longer listed, and can't be taken twice.
    expect(await opensNow()).toEqual([]);
    expect((await lifer({ method: "POST", url: `/api/plugins/v1/host/opens/${id}/claim` })).statusCode).toBe(404);
    // Past the claim wait, still waiting for the frame.
    await new Promise((r) => setTimeout(r, host.CLAIM_WAIT_MS + 200));
    expect(
      (await lifer({ method: "POST", url: `/api/plugins/v1/host/opens/${id}`, payload: { ok: true } })).statusCode,
    ).toBe(200);
    expect((await opening).json()).toEqual({ ok: true });

    // A dialog waiting for the person.
    const req = mod.createPairRequest({ userId, pluginId: OTHER, name: "X", scopes: ["userdata.read"], code: null });
    expect((await open()).json()).toEqual({ ok: false, reason: "busy" });
    mod.cancelPairRequest(req.id);

    // Lifer's window couldn't show it.
    const refused = open();
    const r = await nextOpen();
    await lifer({ method: "POST", url: `/api/plugins/v1/host/opens/${r.id}/claim` });
    await lifer({ method: "POST", url: `/api/plugins/v1/host/opens/${r.id}`, payload: { ok: false } });
    expect((await refused).json()).toEqual({ ok: false, reason: "not_ready" });
  }, 20_000);

  it("answers not_ready when the window doesn't take it, and no_frame when no window looks", async () => {
    await host.setHostOpen(userId, PLUGIN, true);
    expect((await open()).json()).toEqual({ ok: false, reason: "no_frame" });
    await opensNow();
    const started = Date.now();
    expect((await open()).json()).toEqual({ ok: false, reason: "not_ready" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(host.CLAIM_WAIT_MS - 50);
  }, 15_000);
});
