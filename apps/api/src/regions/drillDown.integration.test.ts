// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Drill-down on an install with no repo checkout: Natural Earth is downloaded into the app's
// cache under DATA_DIR, never into a repo-relative data/raw.
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const dir = require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "lifer-drill-"));
  /* eslint-enable @typescript-eslint/no-require-imports */
  process.env.DATA_DIR = dir;
  delete process.env.APP_DATA_DIR;
  delete process.env.LIFER_CACHE_DIR;
  return dir as string;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000661";
const TOKEN = "lifer_test_region_drill_661";
const COUNTRY = "Zzdrill Country";
const PROVINCES = ["Zzdrill North", "Zzdrill South"];

const admin1 = {
  type: "FeatureCollection",
  features: PROVINCES.map((name, i) => ({
    type: "Feature",
    properties: { adm0_a3: "ZZD", name, iso_3166_2: `ZZ-${i}`, type: "Province" },
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
    },
  })),
};

describe.skipIf(!url)("region drill-down without a repo checkout", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let countryId: string;

  async function cleanup() {
    await db.query(`DELETE FROM regions WHERE name = ANY($1)`, [[COUNTRY, ...PROVINCES]]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { regionRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'region-drill@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    countryId = (
      await db.query<{ id: string }>(`INSERT INTO regions (name, external_codes) VALUES ($1, '{ZZD}') RETURNING id`, [
        COUNTRY,
      ])
    ).rows[0].id;

    app = Fastify();
    await app.register(cookie);
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("downloads Natural Earth into DATA_DIR's cache and creates the provinces", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(admin1)));
    vi.stubGlobal("fetch", fetchMock);
    const { RAW_DIR } = await import("@lifer/core/rawCache.js");
    const repoFile = path.join(RAW_DIR, "natural-earth", "ne_10m_admin_1_states_provinces.geojson");
    const repoHadFile = existsSync(repoFile);

    const res = await app.inject({
      method: "POST",
      url: `/api/regions/${countryId}/drill-down`,
      payload: {},
      cookies: { [cookieName]: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, created: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(dataDir, "raw", "natural-earth", "ne_10m_admin_1_states_provinces.geojson"))).toBe(
      true,
    );
    expect(existsSync(repoFile)).toBe(repoHadFile);

    const rows = await db.query<{ name: string }>(`SELECT name FROM regions WHERE parent_id = $1 ORDER BY name`, [
      countryId,
    ]);
    expect(rows.rows.map((r) => r.name)).toEqual(PROVINCES);
  });
});
