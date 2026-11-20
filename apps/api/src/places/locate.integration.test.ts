// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Offline place search: saved spots first, then regions by name or alias.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000b01";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "locate@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("place search", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let region: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { locateRoutes } = await import("./locate.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE name = 'Zzlocateland'`);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'locate@test', 'x')`, [USER]);
    region = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, aliases, boundary_geojson) VALUES ('Zzlocateland', '{Zzlocalia}', $1) RETURNING id`,
        [JSON.stringify({ bbox: [10, 20, 14, 28], geometry: null })],
      )
    ).rows[0].id;
    await db.query(`INSERT INTO saved_spots (user_id, name, lat, lon) VALUES ($1, 'Zzlocate pond', 1.5, 2.5)`, [USER]);
    app = Fastify();
    await app.register(locateRoutes, { prefix: "/api" });
    await app.ready();
  });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [region]);
    await app.close();
    await db.end();
  });

  it("lists saved spots before regions, and finds a region by alias at the centre of its outline", async () => {
    const res = await app.inject({ method: "GET", url: "/api/places/locate?q=zzloc" });
    const places = res.json().places as { kind: string; name: string; lat: number; lon: number }[];
    expect(places.map((p) => [p.kind, p.name])).toEqual([
      ["spot", "Zzlocate pond"],
      ["region", "Zzlocateland"],
    ]);
    const byAlias = (await app.inject({ method: "GET", url: "/api/places/locate?q=Zzlocalia" })).json().places;
    expect(byAlias).toHaveLength(1);
    expect(byAlias[0]).toMatchObject({ name: "Zzlocateland", lat: 24, lon: 12 });
  });

  it("treats % in the search as text", async () => {
    const res = await app.inject({ method: "GET", url: "/api/places/locate?q=%25" });
    expect(res.json().places).toEqual([]);
  });

  it("with no search, lists Nearby (a returning spot first), Recent and All in pages of 50", async () => {
    // 500 places a few km apart along a line, one used recently, plus a 120-character name.
    await db.query(
      `INSERT INTO saved_spots (user_id, name, lat, lon, radius_m)
       SELECT $1, 'Zzpage ' || lpad(i::text, 3, '0'), 40 + i * 0.03, 2, 100 FROM generate_series(1, 500) i`,
      [USER],
    );
    await db.query(`UPDATE saved_spots SET last_used_at = now() WHERE user_id = $1 AND name = 'Zzpage 400'`, [USER]);
    await db.query(`INSERT INTO saved_spots (user_id, name, lat, lon) VALUES ($1, $2, 0, 0)`, [USER, "L".repeat(120)]);
    // 50 m from Zzpage 010, nearer Zzpage 011's centre is 3 km away.
    const first = (await app.inject({ method: "GET", url: "/api/places/locate?near=40.3005,2" })).json();
    const groups = (g: string) => first.places.filter((p: { group: string }) => p.group === g);
    expect(groups("nearby")[0]).toMatchObject({ name: "Zzpage 010", recognised: true });
    expect(groups("nearby").map((p: { distanceM: number }) => p.distanceM)).toEqual(
      [...groups("nearby").map((p: { distanceM: number }) => p.distanceM)].sort((a, b) => a - b),
    );
    expect(groups("nearby")).toHaveLength(5);
    expect(groups("recent").map((p: { name: string }) => p.name)).toEqual(["Zzpage 400"]);
    expect(groups("all")).toHaveLength(50);
    const ids = first.places.map((p: { id: string }) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(first.nextOffset).toBe(50);
    let offset = first.nextOffset;
    let total = groups("all").length;
    while (offset !== null) {
      const page = (
        await app.inject({ method: "GET", url: `/api/places/locate?near=40.3005,2&offset=${offset}` })
      ).json();
      total += page.places.length;
      offset = page.nextOffset;
    }
    // 502 spots, less the 6 shown in Nearby and Recent.
    expect(total).toBe(502 - 6);
    const long = await app.inject({ method: "GET", url: `/api/places/locate?q=${"L".repeat(200)}` });
    expect(long.statusCode).toBe(200);
  });
});
