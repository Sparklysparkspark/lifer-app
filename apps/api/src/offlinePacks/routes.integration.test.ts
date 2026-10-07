// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run offlinePacks/routes
// Request validation on the offline pack routes. Only requests that never reach the published
// pack index are made, so nothing here touches the network.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000561";
const REGION = "eeeeeeee-0000-4000-8000-00000000056a";
const TOKEN = "lifer_test_pack_routes_561";

const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("offline pack routes validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const post = (route: string, payload?: unknown) =>
    app.inject({ method: "POST", url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { offlinePacksRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(offlinePacksRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("checks the pack ids to download", async () => {
    expect((await post("/api/offline-packs/download", {})).json()).toEqual(
      invalid(/^Invalid body: packIds is required$/),
    );
    expect((await post("/api/offline-packs/download", { packIds: [] })).json()).toEqual(
      invalid(/^Invalid body: packIds must/),
    );
    expect((await post("/api/offline-packs/download", { packIds: "us-aves" })).statusCode).toBe(400);
    expect((await post("/api/offline-packs/download", { packIds: ["us-aves"], force: "yes" })).statusCode).toBe(400);
    expect((await post("/api/offline-packs/download", { packIds: ["us-aves"], extra: 1 })).json()).toEqual(
      invalid(/unexpected field extra/),
    );
  });

  it("checks the batch selection", async () => {
    const batch = (body: unknown) => post("/api/offline-packs/download-batch", body);
    expect((await batch({ taxa: "all" })).statusCode).toBe(400);
    expect((await batch({ regionNames: ["Canada"], variant: "medium" })).json()).toEqual(
      invalid(/^Invalid body: variant must be one of full, small$/),
    );
    expect((await batch({ regionNames: ["Canada"], taxa: 5 })).statusCode).toBe(400);
    expect((await batch({ regionNames: [""] })).statusCode).toBe(400);
    expect((await post("/api/offline-packs/recommend", { scientificNames: [] })).statusCode).toBe(400);
    expect((await post("/api/offline-packs/recommend", { scientificNames: [42] })).statusCode).toBe(400);
  });

  it("accepts well-formed removal requests", async () => {
    const preview = await post("/api/offline-packs/offload-preview", { packIds: ["zz-no-such-pack"] });
    expect([preview.statusCode, preview.json()]).toEqual([
      200,
      {
        checklistRegionsAffectedCount: 0,
        speciesToRemoveCount: 0,
        speciesKeptCount: 0,
        bytesToFree: 0,
        isEstimate: false,
      },
    ]);
    expect((await post("/api/offline-packs/offload-preview", { packIds: [] })).statusCode).toBe(400);
    expect((await post("/api/offline-packs/offload-batch", {})).statusCode).toBe(400);
    expect((await post("/api/offline-packs/download/cancel", {})).json()).toEqual({ cancelled: false });

    const missing = await get("/api/offline-packs/zz-no-such-pack/provinces");
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: "No downloaded pack found with that id" }]);
    expect((await post("/api/offline-packs/offload-preview", { packIds: ["x".repeat(201)] })).statusCode).toBe(400);
  });

  it("offloads only region ids", async () => {
    const offload = (body: unknown) => post("/api/offline-packs/zz-no-such-pack/provinces/offload", body);
    expect((await offload({ regionIds: ["nope"] })).json()).toEqual(
      invalid(/^Invalid body: regionIds\.0 must be an id/),
    );
    expect((await offload({ regionIds: [] })).statusCode).toBe(400);
    expect((await offload({ regionIds: [REGION], more: true })).statusCode).toBe(400);
    const valid = await offload({ regionIds: [REGION] });
    expect([valid.statusCode, valid.json()]).toEqual([404, { error: "No downloaded pack found with that id" }]);
  });
});
