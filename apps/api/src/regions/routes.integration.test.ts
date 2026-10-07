// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run regions/routes
// Request validation on the region routes: malformed ids keep answering 404 like unknown ones,
// bad query values get a 400, and well-formed requests still work.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000551";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000055a";
const UNKNOWN = "eeeeeeee-0000-4000-8000-0000000005ff";
const TOKEN = "lifer_test_region_routes_551";
const REGION = "Zzvalidation Region";

const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("region routes validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let regionId: string;

  const call = (method: "GET" | "POST" | "DELETE", route: string, payload?: unknown, signedIn = true) =>
    app.inject({
      method,
      url: route,
      payload: payload as object,
      cookies: signedIn ? { [cookieName]: TOKEN } : {},
    });

  async function cleanup() {
    await db.query(`DELETE FROM region_species_hidden WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [REGION]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { regionRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'region-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 920551, 'Testus regionalis', 'Region Bird', 'aves')`,
      [SPECIES],
    );
    regionId = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [REGION])).rows[0]
      .id;

    app = Fastify();
    await app.register(cookie);
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("asks for sign-in before looking at the input", async () => {
    const res = await call("GET", "/api/regions/nope/species?sort=bogus", undefined, false);
    expect(res.statusCode).toBe(401);
  });

  it("answers a malformed region id like an unknown one", async () => {
    for (const route of [
      "/api/regions/nope/species",
      "/api/regions/nope/species/count",
      "/api/regions/nope/aggregate-species",
      "/api/regions/nope/photographed-taxa",
      "/api/regions/nope/sea-zones",
      "/api/regions/nope/hidden-species",
      `/api/regions/nope/species/${SPECIES}/hidden-children`,
    ]) {
      const res = await call("GET", route);
      expect([route, res.statusCode, res.json()]).toEqual([route, 404, { error: "Region not found" }]);
    }
    const drill = await call("POST", "/api/regions/nope/drill-down", {});
    expect([drill.statusCode, drill.json()]).toEqual([404, { error: "Region not found" }]);
    const hide = await call("POST", `/api/regions/${regionId}/species/not-a-species/hide`);
    expect([hide.statusCode, hide.json()]).toEqual([404, { error: "Region not found" }]);
  });

  it("refuses unknown sort, filter and land values on the checklist", async () => {
    const base = `/api/regions/${regionId}/species`;
    expect((await call("GET", `${base}?sort=bogus`)).json()).toEqual(
      invalid(/^Invalid query: sort must be one of taxonomic, rarity, name$/),
    );
    expect((await call("GET", `${base}?filter=hidden`)).statusCode).toBe(400);
    expect((await call("GET", `${base}?includeLand=2`)).statusCode).toBe(400);
    expect((await call("GET", `${base}/count?includeLand=yes`)).statusCode).toBe(400);

    const ok = await call("GET", `${base}?filter=all&sort=name&includeLand=0&taxon=aves`);
    expect(ok.statusCode).toBe(200);
    expect((await call("GET", `${base}/count?taxon=aves&includeLand=1`)).statusCode).toBe(200);
    // An empty value means "not given", as the web app sends it.
    expect((await call("GET", `${base}?filter=all&taxon=&seaZoneIds=`)).statusCode).toBe(200);
    // Each id in the list is still checked by the handler.
    const zones = await call("GET", `${base}/count?seaZoneIds=nope`);
    expect([zones.statusCode, zones.json()]).toEqual([404, { error: "Sea zone not found" }]);
  });

  it("requires regionIds for taxon presence", async () => {
    expect((await call("GET", "/api/regions/taxon-presence")).json()).toEqual(
      invalid(/^Invalid query: regionIds is required$/),
    );
    expect((await call("GET", "/api/regions/taxon-presence?regionIds=")).statusCode).toBe(400);
    expect((await call("GET", "/api/regions/taxon-presence?regionIds=nope")).statusCode).toBe(400);
    const ok = await call("GET", `/api/regions/taxon-presence?regionIds=${regionId}`);
    expect([ok.statusCode, ok.json()]).toEqual([200, { [regionId]: [] }]);
  });

  it("hides and unhides a species, checking cascaded region ids", async () => {
    const route = `/api/regions/${regionId}/species/${SPECIES}/hide`;
    expect((await call("POST", route)).json()).toEqual({ ok: true });
    const listed = await call("GET", `/api/regions/${regionId}/hidden-species`);
    expect(listed.json().items.map((i: { speciesId: string }) => i.speciesId)).toEqual([SPECIES]);

    const badCascade = await call("DELETE", `${route}?cascadeRegionIds=${UNKNOWN},nope`);
    expect([badCascade.statusCode, badCascade.json()]).toEqual([404, { error: "Region not found" }]);
    expect((await call("DELETE", `${route}?cascadeRegionIds=${UNKNOWN}`)).json()).toEqual({ ok: true });
    expect((await call("GET", `/api/regions/${regionId}/hidden-species`)).json().items).toEqual([]);
  });

  it("drills down only from a country, accepting the empty body the web app sends", async () => {
    const res = await call("POST", `/api/regions/${regionId}/drill-down`, {});
    expect([res.statusCode, res.json()]).toEqual([
      400,
      { error: "This region has no country code to drill down from" },
    ]);
    expect((await call("POST", `/api/regions/${UNKNOWN}/drill-down`)).statusCode).toBe(404);
  });

  it("only offers country boundaries", async () => {
    expect((await call("GET", "/api/regions/boundaries?level=state")).json()).toEqual(
      invalid(/^Invalid query: level must be one of country$/),
    );
    expect((await call("GET", "/api/regions/boundaries?level=country")).statusCode).toBe(200);
  });
});
