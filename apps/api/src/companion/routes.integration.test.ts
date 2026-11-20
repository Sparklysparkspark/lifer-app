// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Pairing a phone on a server, the device list and revoke, and what a device key may reach.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pakeConfirm, pakeHello, parsePairingPayload } from "@lifer/shared";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000901";
const OTHER = "eeeeeeee-0000-4000-8000-000000000902";
const SESSION = "lifer_test_companion_session_901";
const OTHER_SESSION = "lifer_test_companion_session_902";

describe.skipIf(!url)("companion pairing and devices", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let ip = 0;
  // A fresh address per call keeps the per-address limit out of unrelated tests.
  const nextIp = () => `10.0.30.${++ip}`;

  const as = (session: string) => ({ [cookieName]: session });
  const mint = async (session = SESSION) => {
    const res = await app.inject({
      method: "POST",
      url: "/api/companion/v1/pair-codes",
      cookies: as(session),
      payload: { addresses: ["https://lifer.example"] },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as { code: string; payload: string };
  };
  const pair = (body: object, remoteAddress = nextIp(), extra: object = {}) =>
    app.inject({
      method: "POST",
      url: "/api/companion/v1/pair",
      payload: { deviceName: "Sam's iPhone", platform: "ios", ...body },
      remoteAddress,
      ...extra,
    });
  const get = (path: string, key: string) =>
    app.inject({ method: "GET", url: path, headers: { "x-api-key": key }, remoteAddress: nextIp() });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    for (const [id, email, session] of [
      [USER, "companion-a@test", SESSION],
      [OTHER, "companion-b@test", OTHER_SESSION],
    ]) {
      await db.query(`DELETE FROM users WHERE id = $1 OR email = $2`, [id, email]);
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
      await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
        hashToken(session),
        id,
      ]);
    }
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER]]);
      await db.end();
    }
  });

  it("needs a signed-in user to make a code, and the server payload has no certificate", async () => {
    const anon = await app.inject({
      method: "POST",
      url: "/api/companion/v1/pair-codes",
      payload: { addresses: ["a"] },
    });
    expect(anon.statusCode).toBe(401);
    const parsed = parsePairingPayload((await mint()).payload);
    expect(parsed).toMatchObject({ kind: "server", addresses: ["https://lifer.example"] });
    expect(parsed?.certSha256).toBeUndefined();
  });

  it("pairs once with a fresh code and never with a used or wrong one", async () => {
    const { code } = await mint();
    const ok = await pair({ code });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ scopes: expect.arrayContaining(["companion"]) });
    expect((await pair({ code })).statusCode).toBe(401);
    const { code: live } = await mint();
    expect((await pair({ code: String((Number(live) + 1) % 1e6).padStart(6, "0") })).statusCode).toBe(401);
    expect((await pair({ code: "48291" })).statusCode).toBe(400);
    expect((await pair({ code: "ABCD2345" })).statusCode).toBe(400);
  });

  it("pairs a signed-in session without a code, and refuses a bare request", async () => {
    expect((await pair({})).statusCode).toBe(401);
    expect((await pair({}, nextIp(), { cookies: as(SESSION) })).statusCode).toBe(200);
  });

  it("refuses a web page and rate limits an address", async () => {
    const { code } = await mint();
    expect((await pair({ code }, nextIp(), { headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    const same = "10.0.31.1";
    const codes = await Promise.all([1, 2, 3, 4, 5].map(() => pair({ code: "000000" }, same)));
    expect(codes.map((r) => r.statusCode)).toEqual([401, 401, 401, 401, 401]);
    expect((await pair({ code }, same)).statusCode).toBe(429);
  });

  it("lists a user's own devices, revokes them, and keeps other users out", async () => {
    const { code } = await mint();
    const { deviceId, token } = (await pair({ code, deviceName: "Pixel 9", platform: "android" })).json() as {
      deviceId: string;
      token: string;
    };
    const list = await app.inject({ method: "GET", url: "/api/companion/v1/devices", cookies: as(SESSION) });
    expect(list.json().devices).toContainEqual(
      expect.objectContaining({ id: deviceId, name: "Pixel 9", platform: "android" }),
    );
    const others = await app.inject({ method: "GET", url: "/api/companion/v1/devices", cookies: as(OTHER_SESSION) });
    expect(others.json().devices).toEqual([]);

    const del = (session: string) =>
      app.inject({ method: "DELETE", url: `/api/companion/v1/devices/${deviceId}`, cookies: as(session) });
    expect((await del(OTHER_SESSION)).statusCode).toBe(404);
    expect((await get("/api/sync/user-species", token)).statusCode).toBe(200);
    expect((await del(SESSION)).statusCode).toBe(200);
    expect((await get("/api/sync/user-species", token)).statusCode).toBe(401);
  });

  it("does not list or revoke ordinary API keys as devices", async () => {
    const { rows } = await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'plain', 'hash-plain-901', '{gallery.read}') RETURNING id`,
      [USER],
    );
    const list = await app.inject({ method: "GET", url: "/api/companion/v1/devices", cookies: as(SESSION) });
    expect(list.json().devices.map((d: { id: string }) => d.id)).not.toContain(rows[0].id);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/companion/v1/devices/${rows[0].id}`,
      cookies: as(SESSION),
    });
    expect(del.statusCode).toBe(404);
  });

  it("a device key reaches the phone's routes and nothing outside them", async () => {
    const { code } = await mint();
    const { token } = (await pair({ code })).json() as { token: string };
    const ID = "00000000-0000-4000-8000-000000000001";
    for (const path of [
      "/api/sync/user-species",
      "/api/sync/changes",
      "/api/sync/albums",
      "/api/sync/trips",
      "/api/sync/saved-spots",
      "/api/sync/album-captures",
      "/api/sync/album-exclusions",
      "/api/sync/preferences",
      "/api/gallery",
      "/api/gallery/search?q=owl",
    ]) {
      expect((await get(path, token)).statusCode, path).toBe(200);
    }
    // Past the key check: a missing region or photo answers 404, not 401.
    for (const path of [
      `/api/sync/regions/${ID}/checklist`,
      ...["thumb", "medium", "display", "phone", "full"].map((k) => `/api/photos/${ID}/${k}`),
    ]) {
      expect((await get(path, token)).statusCode, path).toBe(404);
    }
    const post = (path: string) =>
      app.inject({ method: "POST", url: path, headers: { "x-api-key": token }, payload: {}, remoteAddress: nextIp() });
    for (const path of ["/api/sync/push", "/api/sync/link/revoke"]) {
      expect((await post(path)).statusCode, path).toBe(401);
    }
    for (const path of [
      `/api/photos/${ID}/original`,
      `/api/photos/${ID}/original-raw`,
      "/api/captures",
      "/api/sync/status",
      "/api/api-keys",
      "/api/albums",
      "/api/stats",
      "/api/trips",
    ]) {
      expect((await get(path, token)).statusCode, path).toBe(401);
    }
  });

  describe("what a device key sees of places and files", () => {
    const SP_OK = "eeeeeeee-0000-4000-8000-0000000009a1";
    const SP_EN = "eeeeeeee-0000-4000-8000-0000000009a2";
    let token = "";
    let captureOk = "";
    let captureEn = "";

    beforeAll(async () => {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
           ($1, 919101, 'Companion ordinarius', 'Ordinary Test Bird', 'aves'),
           ($2, 919102, 'Companion rarissimus', 'Rare Test Bird', 'aves') ON CONFLICT (id) DO NOTHING`,
        [SP_OK, SP_EN],
      );
      await db.query(
        `INSERT INTO species_traits (species_id, iucn_status, source_attribution) VALUES ($1, 'EN', 'test')
         ON CONFLICT (species_id) DO UPDATE SET iucn_status = 'EN'`,
        [SP_EN],
      );
      const add = async (species: string, fp: string) => {
        const c = await db.query(
          `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, lat, lon, location_label)
           VALUES ($1, $2, $3, now(), 10.5, 20.5, 'Secret Marsh') RETURNING id`,
          [USER, species, fp],
        );
        const p = await db.query(
          `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/srv/d.webp', '/srv/t.webp') RETURNING id`,
          [c.rows[0].id],
        );
        await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
           VALUES ($1, 'jpeg', 'path', '/srv/secret/original.jpg', false, $2, 1)`,
          [c.rows[0].id, fp],
        );
        return c.rows[0].id as string;
      };
      captureOk = await add(SP_OK, "companion-privacy-ok");
      captureEn = await add(SP_EN, "companion-privacy-en");
      for (const [name, lat, lon, geo] of [
        ["Open spot", 1.23456, 2.34567, "open"],
        ["Fuzzy spot", 1.23456, 2.34567, "obscured"],
        ["Hidden spot", 5.5, 6.6, "private"],
      ] as const) {
        await db.query(`INSERT INTO saved_spots (user_id, name, lat, lon, geoprivacy) VALUES ($1, $2, $3, $4, $5)`, [
          USER,
          name,
          lat,
          lon,
          geo,
        ]);
      }
      const { code } = await mint();
      token = ((await pair({ code })).json() as { token: string }).token;
    });

    afterAll(async () => {
      await db.query(`DELETE FROM saved_spots WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP_OK, SP_EN]]);
    });

    const session = (path: string) => app.inject({ method: "GET", url: path, cookies: as(SESSION) });
    type Item = { captureId: string; lat: unknown; lon: unknown; originalRef: unknown; rawRef: unknown };

    it("keeps file paths out of the gallery and its search, and the places of a sensitive species", async () => {
      const own = ((await session("/api/gallery")).json().items as Item[]).find((i) => i.captureId === captureEn)!;
      expect(own.originalRef).toBe("/srv/secret/original.jpg");
      for (const path of ["/api/gallery", "/api/gallery/search?q=Companion"]) {
        const items = ((await get(path, token)).json().items as Item[]).filter((i) =>
          [captureOk, captureEn].includes(i.captureId),
        );
        if (path === "/api/gallery") expect(items.length).toBe(2);
        for (const i of items) {
          expect(i.originalRef, path).toBeNull();
          expect(i.rawRef, path).toBeNull();
        }
        const byId = new Map(items.map((i) => [i.captureId, i]));
        if (byId.has(captureOk)) expect(Number(byId.get(captureOk)!.lat)).toBe(10.5);
        if (byId.has(captureEn)) expect(byId.get(captureEn)).toMatchObject({ lat: null, lon: null });
      }
    });

    it("drops a sensitive species' place from the change feed and keeps the others'", async () => {
      const items = (
        (await get("/api/sync/changes", token)).json().items as Array<{
          id: string;
          lat: number | null;
          locationLabel: string | null;
        }>
      ).filter((i) => [captureOk, captureEn].includes(i.id));
      const byId = new Map(items.map((i) => [i.id, i]));
      expect(byId.get(captureOk)).toMatchObject({ lat: 10.5, locationLabel: "Secret Marsh" });
      expect(byId.get(captureEn)).toMatchObject({ lat: null, lon: null, locationLabel: null });
      const ownChanges = (await session("/api/sync/changes")).json().items as typeof items;
      expect(ownChanges.find((i) => i.id === captureEn)?.lat).toBe(10.5);
    });

    it("sends saved spots by their geoprivacy", async () => {
      const spots = (await get("/api/sync/saved-spots", token)).json().items as Array<{
        name: string;
        lat: number;
        lon: number;
      }>;
      expect(spots.map((s) => s.name).sort()).toEqual(["Fuzzy spot", "Open spot"]);
      expect(spots.find((s) => s.name === "Open spot")).toMatchObject({ lat: 1.23456, lon: 2.34567 });
      expect(spots.find((s) => s.name === "Fuzzy spot")).toMatchObject({ lat: 1.2, lon: 2.3 });
    });
  });

  describe("typed pairing with a computer", () => {
    const CERT = "c".repeat(64);
    const post = (path: string, payload: object, extra: object = {}) =>
      app.inject({ method: "POST", url: `/api/companion/v1/pair/${path}`, payload, remoteAddress: nextIp(), ...extra });
    // A desktop's code is minted with its certificate; this suite runs as a server, so mint directly.
    const desktopCode = async () => {
      const { clearPairingCodes, mintPairingCode } = await import("./pairing.js");
      clearPairingCodes();
      return mintPairingCode(USER, CERT).code;
    };

    it("pairs over the key exchange without the code crossing the wire", async () => {
      const code = await desktopCode();
      const { hello, secret } = pakeHello(code);
      const start = await post("start", hello);
      expect(start.statusCode).toBe(200);
      expect(start.body).not.toContain(code);
      const tagA = pakeConfirm(secret, CERT, start.json())!;
      expect(tagA).toBeTruthy();
      const finish = await post("finish", { session: start.json().session, tagA, deviceName: "P", platform: "ios" });
      expect(finish.statusCode).toBe(200);
      expect((await get("/api/sync/user-species", finish.json().token)).statusCode).toBe(200);
      // One finish per session, and the code is spent.
      const again = await post("finish", { session: start.json().session, tagA, deviceName: "P", platform: "ios" });
      expect(again.statusCode).toBe(401);
      expect((await pair({ code })).statusCode).toBe(401);
    });

    it("a phone that saw another certificate refuses the hub's answer", async () => {
      const code = await desktopCode();
      const { hello, secret } = pakeHello(code);
      const start = await post("start", hello);
      expect(pakeConfirm(secret, "d".repeat(64), start.json())).toBeNull();
    });

    it("a wrong code gets no key, and the code burns after a few runs", async () => {
      const code = await desktopCode();
      const guess = String((Number(code) + 1) % 1e6).padStart(6, "0");
      const starts = [];
      for (let i = 0; i < 5; i++) starts.push(await post("start", pakeHello(guess).hello));
      expect(starts.map((r) => r.statusCode)).toEqual([200, 200, 200, 200, 200]);
      const forged = await post("finish", {
        session: starts[0].json().session,
        tagA: "0".repeat(128),
        deviceName: "P",
        platform: "ios",
      });
      expect(forged.statusCode).toBe(401);
      expect((await post("start", pakeHello(code).hello)).statusCode).toBe(401);
    });

    it("refuses with no desktop code live, from a web page, and malformed hellos", async () => {
      const { clearPairingCodes } = await import("./pairing.js");
      clearPairingCodes();
      await mint();
      expect((await post("start", pakeHello("123456").hello)).statusCode).toBe(401);
      await desktopCode();
      const hello = pakeHello("123456").hello;
      expect((await post("start", hello, { headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
      expect((await post("start", { ...hello, ya: "0".repeat(64) })).statusCode).toBe(400);
      expect((await post("start", { ...hello, code: "123456" })).statusCode).toBe(400);
    });
  });
});
