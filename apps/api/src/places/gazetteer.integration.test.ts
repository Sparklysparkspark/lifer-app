// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The offline town list: Towns in /places/locate, and a spot's locality from the nearest town.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000c01";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "gazetteer@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

// Near Prince George, BC; real coordinates, made-up ids.
const TOWNS: Array<[number, string, string, number, number, number]> = [
  [990101, "Prince George", "Prince George|PG", 53.9166, -122.753, 78943],
  [990102, "Prince Albert", "", 53.2001, -105.7677, 35102],
  [990103, "Princeton", "", 49.4589, -120.5062, 2828],
  [990104, "Montréal", "Monreal", 45.5088, -73.5878, 1600000],
  [990105, "Zzgaz O'Hare", "", 10, 10, 6000],
];

describe.skipIf(!url)("offline town list", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let country: string;
  let province: string;

  const locate = async (query: string) =>
    (await app.inject({ method: "GET", url: `/api/places/locate?${query}` })).json().places as Array<{
      kind: string;
      id: string;
      name: string;
      detail: string | null;
      locality: string | null;
      regionId: string | null;
      distanceM: number | null;
    }>;
  const towns = async (query: string) => (await locate(query)).filter((p) => p.kind === "town");

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'gazetteer@test', 'x')`, [USER]);
    await db.query(`DELETE FROM regions WHERE name IN ('Zzgaz Canada', 'Zzgaz British Columbia')`);
    country = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Zzgaz Canada') RETURNING id`))
      .rows[0].id;
    province = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id) VALUES ('Zzgaz British Columbia', $1) RETURNING id`,
        [country],
      )
    ).rows[0].id;
    const { locateRoutes } = await import("./locate.js");
    const { savedSpotRoutes } = await import("./savedSpots.js");
    app = Fastify();
    await app.register(locateRoutes, { prefix: "/api" });
    await app.register(savedSpotRoutes, { prefix: "/api" });
    await app.ready();
  });
  beforeEach(async () => {
    await db.query(`DELETE FROM gazetteer_places`);
    await db.query(`DELETE FROM saved_spots WHERE user_id = $1`, [USER]);
    for (const [id, name, alts, lat, lon, population] of TOWNS)
      await db.query(
        `INSERT INTO gazetteer_places (geoname_id, name, ascii_name, alternate_names, lat, lon, population,
           feature_class, feature_code, country_code, admin1_code, country_region_id, province_region_id)
         VALUES ($1, $2, $2, $3, $4, $5, $6, 'P', 'PPL', 'CA', '02', $7, $8)`,
        [id, name, alts, lat, lon, population, country, province],
      );
  });
  afterAll(async () => {
    await db.query(`DELETE FROM gazetteer_places`);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE id IN ($1, $2)`, [province, country]);
    await app.close();
    await db.end();
  });

  it("lists Towns after the user's places, by prefix of any name, with a point and a locality", async () => {
    await db.query(`INSERT INTO saved_spots (user_id, name, lat, lon) VALUES ($1, 'Prince pond', 1, 1)`, [USER]);
    const places = await locate("q=prince");
    expect(places.map((p) => [p.kind, p.name])).toEqual([
      ["spot", "Prince pond"],
      ["town", "Prince George"],
      ["town", "Prince Albert"],
      ["town", "Princeton"],
    ]);
    expect(places[1]).toMatchObject({
      id: "990101",
      detail: "Zzgaz British Columbia, Zzgaz Canada",
      locality: "Prince George, Zzgaz British Columbia, Zzgaz Canada",
      regionId: province,
      distanceM: null,
    });
    expect((await towns("q=pg")).map((t) => t.name)).toEqual(["Prince George"]);
  });

  it("ignores accents, case and apostrophes, and puts an exact name first", async () => {
    expect((await towns("q=MONTREAL")).map((t) => t.name)).toEqual(["Montréal"]);
    expect((await towns("q=monr")).map((t) => t.name)).toEqual(["Montréal"]);
    expect((await towns("q=zzgaz ohare")).map((t) => t.name)).toEqual(["Zzgaz O'Hare"]);
    expect((await towns("q=princeton"))[0].name).toBe("Princeton");
  });

  it("ranks a nearby town above a far bigger one and gives its distance", async () => {
    const near = await towns("q=prince&near=49.5,-120.5");
    expect(near[0]).toMatchObject({ name: "Princeton" });
    expect(near[0].distanceM).toBeLessThan(10_000);
  });

  it("treats % in the search as text, takes a 200-character search, and finds nothing in an empty list", async () => {
    expect(await towns("q=%25")).toEqual([]);
    expect((await app.inject({ method: "GET", url: `/api/places/locate?q=${"p".repeat(200)}` })).statusCode).toBe(200);
    await db.query(`DELETE FROM gazetteer_places`);
    expect(await towns("q=prince")).toEqual([]);
  });

  it("gives a spot the nearest town within 25 km, else its region's name, and keeps a typed one", async () => {
    const create = async (name: string, lat: number, lon: number, extra: object = {}) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/saved-spots",
          payload: { name, lat, lon, regionId: province, ...extra },
        })
      ).json();
    // About 10 km and 60 km from Prince George.
    expect(await create("Ten out", 53.99, -122.66)).toMatchObject({
      locality: "Prince George, Zzgaz British Columbia, Zzgaz Canada",
      localitySource: "gazetteer",
    });
    const far = await create("Sixty out", 54.45, -122.75);
    expect(far).toMatchObject({ locality: "Zzgaz British Columbia, Zzgaz Canada", localitySource: "region" });

    // Moved next to town, it's worked out again; a typed locality survives a move.
    const moved = await app.inject({
      method: "PATCH",
      url: `/api/saved-spots/${far.id}`,
      payload: { lat: 53.92, lon: -122.76 },
    });
    expect(moved.json()).toMatchObject({ localitySource: "gazetteer" });
    const typed = await create("Typed", 53.92, -122.76, { locality: "Behind the mill" });
    const kept = await app.inject({
      method: "PATCH",
      url: `/api/saved-spots/${typed.id}`,
      payload: { lat: 54.45, lon: -122.75 },
    });
    expect(kept.json()).toMatchObject({ locality: "Behind the mill", localitySource: "user" });

    const { localityAt } = await import("./gazetteer.js");
    await db.query(`DELETE FROM gazetteer_places`);
    expect(await localityAt(53.92, -122.76, province)).toEqual({
      locality: "Zzgaz British Columbia, Zzgaz Canada",
      source: "region",
    });
    expect(await localityAt(53.92, -122.76, null)).toBeNull();
  });
});
