// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run stats/routes
// Query validation on the stats routes: the filters and years the web app sends work, anything
// else is refused with 400 instead of being quietly read as something else.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000651";
const TOKEN = "lifer_test_stats_routes_owner_651";

const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("stats route validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const get = (route: string, cookies = { [cookieName]: TOKEN }) => app.inject({ method: "GET", url: route, cookies });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { statsRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'stats-routes@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(statsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("takes the photo filters the web app sends, and refuses others", async () => {
    for (const filter of ["all", "featured", "topRated"]) {
      expect((await get(`/api/stats?filter=${filter}`)).statusCode).toBe(200);
    }
    expect((await get("/api/stats")).statusCode).toBe(200);
    const csv = await get("/api/stats/export.csv?filter=topRated");
    expect([csv.statusCode, csv.headers["content-type"]]).toEqual([200, expect.stringContaining("text/csv")]);

    for (const route of ["/api/stats?filter=best", "/api/stats/export.csv?filter=Featured"]) {
      const res = await get(route);
      expect([route, res.statusCode, res.json()]).toEqual([
        route,
        400,
        invalid(/^Invalid query: filter must be one of all, featured, topRated$/),
      ]);
    }
  });

  it("compares two whole years, refusing a missing, non-numeric or out-of-range year", async () => {
    const ok = await get("/api/stats/year-comparison?yearA=2024&yearB=2025");
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json())).toEqual(expect.arrayContaining(["a", "b"]));

    for (const [query, pattern] of [
      ["yearA=2024", /^Invalid query: yearB is required$/],
      ["yearA=twenty&yearB=2025", /^Invalid query: yearA must be integer$/],
      ["yearA=0&yearB=2025", /^Invalid query: yearA must be >= 1$/],
      ["yearA=2024&yearB=10000", /^Invalid query: yearB must be <= 9999$/],
    ] as const) {
      const res = await get(`/api/stats/year-comparison?${query}`);
      expect([query, res.statusCode, res.json()]).toEqual([query, 400, invalid(pattern)]);
    }
  });

  it("still answers 401 before looking at the query when signed out", async () => {
    const res = await get("/api/stats/year-comparison?yearA=nope", {});
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not authenticated" }]);
  });

  it("filters the gear breakdown by camera or lens", async () => {
    expect((await get("/api/stats/gear-species-breakdown")).json()).toEqual({ breakdown: [] });
    expect((await get("/api/stats/gear-species-breakdown?camera=EOS%20R5")).json()).toEqual({ breakdown: [] });
  });
});
