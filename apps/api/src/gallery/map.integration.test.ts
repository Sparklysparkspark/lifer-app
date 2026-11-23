// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /gallery/map: region counts roll up into countries, photos with coordinates share grid
// cells, the Gallery's filters apply, and a huge library gets a coarser grid.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000611";
const OTHER = "ffffffff-0000-4000-8000-000000000612";
const BIG = "ffffffff-0000-4000-8000-000000000613";
const SPECIES = "ffffffff-0000-4000-8000-0000000006a1";
const CONTINENT = "ffffffff-0000-4000-8000-0000000006b1";
const COUNTRY = "ffffffff-0000-4000-8000-0000000006b2";
const PROVINCE = "ffffffff-0000-4000-8000-0000000006b3";
const auth = vi.hoisted(() => ({ user: "" }));

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: auth.user, email: "map@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const square = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  },
});

describe.skipIf(!url)("GET /gallery/map", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  const get = async (path: string, user = USER) => {
    auth.user = user;
    const res = await app.inject({ method: "GET", url: `/api${path}` });
    return { status: res.statusCode, body: res.json() };
  };

  async function addCapture(
    user: string,
    opts: { lat?: number; lon?: number; region?: string; tags?: string[]; rating?: number },
  ) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, region_id, tags, quality_rating)
       VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $5, $6, $7) RETURNING id`,
      [user, SPECIES, opts.lat ?? null, opts.lon ?? null, opts.region ?? null, opts.tags ?? [], opts.rating ?? null],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/x/d.webp', '/x/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return { captureId: c.rows[0].id, photoId: p.rows[0].id };
  }

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER, OTHER, BIG]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1::uuid[])`, [[PROVINCE, COUNTRY, CONTINENT]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    for (const [id, email] of [
      [USER, "map@test"],
      [OTHER, "map-other@test"],
      [BIG, "map-big@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 912601, 'Mappa mundi', 'Map Warbler', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Map Test Continent', '{}')`, [
      CONTINENT,
    ]);
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes, boundary_geojson) VALUES ($1, 'Map Test Country', $2, '{ZZM}', $3)`,
      [COUNTRY, CONTINENT, square(10, 40, 20, 50)],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes, boundary_geojson) VALUES ($1, 'Map Test Province', $2, '{ZZ-MP}', $3)`,
      [PROVINCE, COUNTRY, square(12, 42, 14, 44)],
    );

    // Two shots a few metres apart share a cell; a third is far off; one has no coordinates.
    await addCapture(USER, { lat: 43.00011, lon: 13.00012, region: PROVINCE, tags: ["burst"], rating: 2 });
    await addCapture(USER, { lat: 43.00014, lon: 13.00009, region: PROVINCE, tags: ["burst"], rating: 5 });
    await addCapture(USER, { lat: 45.5, lon: 15.5, region: COUNTRY });
    await addCapture(USER, { region: COUNTRY });
    await addCapture(USER, { lat: -33.9, lon: 151.2 });
    await addCapture(OTHER, { lat: 43.0001, lon: 13.0001, region: PROVINCE });

    const { galleryRoutes } = await import("./routes.js");
    const { galleryMapRoutes } = await import("./map.js");
    app = Fastify();
    await app.register(
      async (api) => {
        await api.register(galleryRoutes);
        await api.register(galleryMapRoutes);
      },
      { prefix: "/api" },
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db?.end();
  }, 60_000);

  it("counts photos per region, rolling provinces into their country", async () => {
    const { status, body } = await get("/gallery/map");
    expect(status).toBe(200);
    expect(body.total).toBe(5);
    expect(body.withoutCoordinates).toBe(1);
    expect(body.withoutRegion).toBe(1);
    const country = body.regions.find((r: { id: string }) => r.id === COUNTRY);
    const province = body.regions.find((r: { id: string }) => r.id === PROVINCE);
    expect(country).toMatchObject({ kind: "country", count: 4, ownCount: 2, lat: 45, lon: 15 });
    expect(province).toMatchObject({ kind: "province", count: 2, ownCount: 2, lat: 43, lon: 13, parentId: COUNTRY });
    // A continent isn't a map region.
    expect(body.regions.some((r: { id: string }) => r.id === CONTINENT)).toBe(false);
  });

  it("counts a photo as placed only with coordinates, and rings only the region-only ones", async () => {
    const { body } = await get("/gallery/map");
    expect(body.regionOnly).toBe(1);
    const country = body.regions.find((r: { id: string }) => r.id === COUNTRY);
    const province = body.regions.find((r: { id: string }) => r.id === PROVINCE);
    // The precise photos in the province are cells, not part of its ring.
    expect(province.regionOnlyCount).toBe(0);
    expect(country.regionOnlyCount).toBe(1);
    const inCells = body.cells.reduce((n: number, c: { count: number }) => n + c.count, 0);
    expect(inCells + body.withoutCoordinates).toBe(body.total);
    expect(body.withoutCoordinates - body.regionOnly).toBe(0);
  });

  it("groups nearby photos into one grid cell, led by the best rated", async () => {
    const { body } = await get("/gallery/map");
    expect(body.truncated).toBe(false);
    expect(body.gridDegrees).toBeCloseTo(0.001);
    expect(body.cells).toHaveLength(3);
    const burst = body.cells.find((c: { count: number }) => c.count === 2);
    expect(burst).toMatchObject({ lat: 43, lon: 13, taxonClass: "aves", iconicTaxon: null });
    const best = await db.query(`SELECT current_photo_id FROM captures_all WHERE user_id = $1 AND quality_rating = 5`, [
      USER,
    ]);
    expect(burst.photoId).toBe(best.rows[0].current_photo_id);
  });

  it("applies the Gallery's filters, including a map box", async () => {
    const tagged = (await get("/gallery/map?tag=burst")).body;
    expect(tagged.total).toBe(2);
    expect(tagged.cells).toEqual([expect.objectContaining({ count: 2 })]);

    const box = "12.9995,42.9995,13.0005,43.0005";
    expect((await get(`/gallery/map?bbox=${box}`)).body.total).toBe(2);
    expect((await get(`/gallery?bbox=${box}`)).body.total).toBe(2);
    // Across the antimeridian: west above east.
    expect((await get("/gallery?bbox=150,-35,-170,-30")).body.total).toBe(1);
    expect((await get("/gallery?bbox=10,50,20,40")).status).toBe(400);
    expect((await get("/gallery?bbox=10,40,200,50")).status).toBe(400);
  });

  it("lists a cluster's dots and rings in one sorted, paged list with ?orRegionOnly=", async () => {
    const box = "12.9995,42.9995,13.0005,43.0005";
    const both = (await get(`/gallery?bbox=${box}&orRegionOnly=${COUNTRY}&sort=ratingHigh`)).body;
    // The two in the box and the country's photo with no coordinates, never the country's placed one.
    // Sorted as one list: the unrated ring photo counts as 3 stars, between the 5 and the 2.
    expect(both.total).toBe(3);
    expect(both.items.map((i: { lat: number | null }) => i.lat === null)).toEqual([false, true, false]);
    expect(both.items[0].qualityRating).toBe(5);
    // Paged together: page one holds two, the cursor brings the 2-star dot.
    const first = (await get(`/gallery?bbox=${box}&orRegionOnly=${COUNTRY}&sort=ratingHigh&limit=2`)).body;
    expect(first.items).toHaveLength(2);
    const next = (
      await get(`/gallery?bbox=${box}&orRegionOnly=${COUNTRY}&sort=ratingHigh&limit=2&cursor=${first.nextCursor}`)
    ).body;
    expect(next.items.map((i: { qualityRating: number | null }) => i.qualityRating)).toEqual([2]);
    // Other filters still apply to both parts.
    expect((await get(`/gallery?bbox=${box}&orRegionOnly=${COUNTRY}&tag=burst`)).body.total).toBe(2);
  });

  it("never counts another user's photos", async () => {
    const other = (await get("/gallery/map", OTHER)).body;
    expect(other.total).toBe(1);
    expect(other.regions.find((r: { id: string }) => r.id === COUNTRY)?.count).toBe(1);
  });

  it("coarsens the grid past the cell cap", async () => {
    const { MAP_CELL_CAP } = await import("./map.js");
    // One photo per ~0.01 degree step, so the finest grid needs a cell for each.
    await db.query(
      `WITH c AS (
         INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon)
         SELECT $1, $2, 'map-big-' || i, (i / 200) * 0.01, (i % 200) * 0.01 FROM generate_series(0, $3::int) i
         RETURNING id
       )
       INSERT INTO photos (capture_id, display_path, thumb_path) SELECT id, '/x/d.webp', '/x/t.webp' FROM c`,
      [BIG, SPECIES, MAP_CELL_CAP],
    );
    // A separate statement: one can't see rows its own CTE inserted.
    await db.query(
      `UPDATE captures_all ca SET current_photo_id = p.id FROM photos p WHERE ca.id = p.capture_id AND ca.user_id = $1`,
      [BIG],
    );
    const { body } = await get("/gallery/map", BIG);
    expect(body.total).toBe(MAP_CELL_CAP + 1);
    expect(body.truncated).toBe(true);
    expect(body.gridDegrees).toBeCloseTo(0.1);
    expect(body.cells.length).toBeLessThanOrEqual(MAP_CELL_CAP);
    expect(body.cells.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(MAP_CELL_CAP + 1);
  }, 180_000); // 20,000 rows take a while to insert on a busy database or a shared runner
});
