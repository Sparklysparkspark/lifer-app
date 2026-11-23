// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /collection/map: one pin per species per grid cell, kept where the photos were taken inside
// the region's outline or within 22 km of it, or filed under the region, led by the best photo;
// hidden, trashed, region-only and other users' photos never make a pin. Without an outline the
// region's subtree decides.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000711";
const OTHER = "ffffffff-0000-4000-8000-000000000712";
const WARBLER = "ffffffff-0000-4000-8000-0000000007a1";
const FOX = "ffffffff-0000-4000-8000-0000000007a2";
const COUNTRY = "ffffffff-0000-4000-8000-0000000007b1";
const PROVINCE = "ffffffff-0000-4000-8000-0000000007b2";
const ELSEWHERE = "ffffffff-0000-4000-8000-0000000007b3";
const auth = vi.hoisted(() => ({ user: "" }));

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: auth.user, email: "pins@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const square = (w: number, s: number, e: number, n: number) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  },
});

// Degrees of latitude for km.
const deg = (km: number) => km / ((6371.0088 * Math.PI) / 180);

type Pin = { speciesId: string; count: number; photoId: string; lat: number; lon: number; taxonClass: string };

describe.skipIf(!url)("GET /collection/map", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  const get = async (regionId: string, user = USER) => {
    auth.user = user;
    const res = await app.inject({ method: "GET", url: `/api/collection/map?regionId=${regionId}` });
    return { status: res.statusCode, body: res.json() };
  };

  async function addCapture(
    user: string,
    species: string,
    opts: { lat?: number; lon?: number; region?: string; rating?: number; hidden?: boolean; deleted?: boolean },
  ) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, region_id, quality_rating, hidden_at, deleted_at)
       VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $5, $6,
               CASE WHEN $7 THEN now() END, CASE WHEN $8 THEN now() END) RETURNING id`,
      [
        user,
        species,
        opts.lat ?? null,
        opts.lon ?? null,
        opts.region ?? null,
        opts.rating ?? null,
        !!opts.hidden,
        !!opts.deleted,
      ],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/x/d.webp', '/x/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return { captureId: c.rows[0].id, photoId: p.rows[0].id };
  }

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1::uuid[])`, [[PROVINCE, COUNTRY, ELSEWHERE]]);
  }

  let bestPhoto = "";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    for (const [id, email] of [
      [USER, "pins@test"],
      [OTHER, "pins-other@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 912701, 'Pinna warbleri', 'Pin Warbler', 'aves'),
         ($2, 912702, 'Vulpes pinnae', 'Pin Fox', 'mammalia')
       ON CONFLICT (id) DO NOTHING`,
      [WARBLER, FOX],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes, boundary_geojson) VALUES
         ($1, 'Pin Country', NULL, '{ZZP}', $4), ($2, 'Pin Province', $1, '{ZZ-PP}', $5),
         ($3, 'Pin Elsewhere', NULL, '{ZZE}', NULL)`,
      [COUNTRY, PROVINCE, ELSEWHERE, square(10, 40, 20, 50), square(12, 42, 14, 44)],
    );

    // Two warbler shots a few metres apart in the province share a pin; the 5-star one leads it.
    await addCapture(USER, WARBLER, { lat: 43.0011, lon: 13.0012, region: PROVINCE, rating: 2 });
    bestPhoto = (await addCapture(USER, WARBLER, { lat: 43.0014, lon: 13.0009, region: PROVINCE, rating: 5 })).photoId;
    // A second place for the warbler, filed under the country itself.
    await addCapture(USER, WARBLER, { lat: 45.5, lon: 15.5, region: COUNTRY });
    // A fox at the first spot is its own pin; a fox with only a region makes none.
    await addCapture(USER, FOX, { lat: 43.0012, lon: 13.0011, region: PROVINCE });
    await addCapture(USER, FOX, { region: PROVINCE });
    // Hidden, trashed, elsewhere and another user's photos never count.
    await addCapture(USER, FOX, { lat: 44, lon: 14, region: PROVINCE, hidden: true });
    await addCapture(USER, FOX, { lat: 44.5, lon: 14.5, region: PROVINCE, deleted: true });
    await addCapture(USER, FOX, { lat: 10, lon: 10, region: ELSEWHERE });
    await addCapture(OTHER, FOX, { lat: 43.5, lon: 13.5, region: PROVINCE });
    // Filed under the wrong region: the point decides. One taken in the country, filed elsewhere;
    // one filed under the province but taken far outside it.
    await addCapture(USER, WARBLER, { lat: 46.5, lon: 16.5, region: ELSEWHERE });
    await addCapture(USER, FOX, { lat: 30, lon: 30, region: PROVINCE });
    // At sea off the country's south coast, filed nowhere: 10 km out counts, 30 km doesn't.
    await addCapture(USER, FOX, { lat: 40 - deg(10), lon: 15 });
    await addCapture(USER, FOX, { lat: 40 - deg(30), lon: 15 });
    // Filed under the country, 500 km outside it.
    await addCapture(USER, WARBLER, { lat: 40 - deg(500), lon: 15, region: COUNTRY });

    const { collectionMapRoutes } = await import("./map.js");
    app = Fastify();
    await app.register(async (api) => api.register(collectionMapRoutes), { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db?.end();
  }, 60_000);

  it("pins each species per place in the region", async () => {
    const { status, body } = await get(COUNTRY);
    expect(status).toBe(200);
    expect(body.truncated).toBe(false);
    const pins = body.pins as Pin[];
    expect(pins).toHaveLength(7);
    const warbler = pins.filter((p) => p.speciesId === WARBLER);
    expect(warbler.map((p) => p.count).sort()).toEqual([1, 1, 1, 2]);
    const pair = warbler.find((p) => p.count === 2)!;
    expect(pair.photoId).toBe(bestPhoto);
    expect(pair.lat).toBeCloseTo(43.00125, 4);
    expect(pins.find((p) => p.speciesId === FOX)).toMatchObject({ count: 1, taxonClass: "mammalia" });
  });

  const at = (pins: Pin[], lat: number) => pins.find((p) => Math.abs(p.lat - lat) < 1e-6);

  it("shows a photo taken in the region, whatever it's filed under", async () => {
    expect(at((await get(COUNTRY)).body.pins, 46.5)?.speciesId).toBe(WARBLER);
  });

  it("shows a photo taken within 22 km of the coast, not farther out", async () => {
    const pins = (await get(COUNTRY)).body.pins as Pin[];
    expect(at(pins, 40 - deg(10))?.speciesId).toBe(FOX);
    expect(at(pins, 40 - deg(30))).toBeUndefined();
  });

  it("shows a photo filed under the region or below it, wherever it was taken", async () => {
    const pins = (await get(COUNTRY)).body.pins as Pin[];
    expect(at(pins, 40 - deg(500))?.speciesId).toBe(WARBLER);
    expect(at(pins, 30)?.speciesId).toBe(FOX);
    expect(at((await get(PROVINCE)).body.pins, 30)?.speciesId).toBe(FOX);
    // Filed under the country, so not the province's.
    expect(at((await get(PROVINCE)).body.pins, 40 - deg(500))).toBeUndefined();
  });

  it("falls back to the region's subtree when it has no outline", async () => {
    // Pin Elsewhere has no outline: what's filed under it shows, wherever it was taken.
    const pins = (await get(ELSEWHERE)).body.pins as Pin[];
    expect(pins.map((p) => Math.round(p.lat)).sort()).toEqual([10, 47]);
  });

  it("keeps to the asked-for region", async () => {
    const { body } = await get(PROVINCE);
    expect((body.pins as Pin[]).map((p) => p.count).sort()).toEqual([1, 1, 2]);
  });

  it("never shows another user's photos", async () => {
    const { body } = await get(PROVINCE, OTHER);
    expect(body.pins).toHaveLength(1);
  });

  it("lists one pin's photos for its preview, best first", async () => {
    const pins = (await get(COUNTRY)).body.pins as Pin[];
    const pair = pins.find((p) => p.speciesId === WARBLER && p.count === 2)!;
    auth.user = USER;
    const res = await app.inject({
      method: "GET",
      url: `/api/collection/map/photos?regionId=${COUNTRY}&speciesId=${WARBLER}&lat=${pair.lat}&lon=${pair.lon}`,
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as Array<{ photoId: string; speciesId: string }>;
    expect(items.map((i) => i.photoId)[0]).toBe(bestPhoto);
    expect(items).toHaveLength(2);
    // The fox at the same spot is its own pin, so not in the warbler's preview.
    expect(items.every((i) => i.speciesId === WARBLER)).toBe(true);
  });

  const preview = async (regionId: string, speciesId: string, lat: number, lon: number) => {
    auth.user = USER;
    const res = await app.inject({
      method: "GET",
      url: `/api/collection/map/photos?regionId=${regionId}&speciesId=${speciesId}&lat=${lat}&lon=${lon}`,
    });
    return res.json().items as Array<{ photoId: string }>;
  };

  it("opens each pin's own photos, whichever rule kept it", async () => {
    const pins = (await get(COUNTRY)).body.pins as Pin[];
    for (const pin of pins) {
      const items = await preview(COUNTRY, pin.speciesId, pin.lat, pin.lon);
      expect(items).toHaveLength(pin.count);
      expect(items[0].photoId).toBe(pin.photoId);
    }
  });

  it("shows no photos where there's no pin: far out at sea, or outside with nothing filed", async () => {
    expect(await preview(COUNTRY, FOX, 40 - deg(30), 15)).toEqual([]);
    expect(await preview(PROVINCE, FOX, 10, 10)).toEqual([]);
  });

  it("rejects a region id that isn't a uuid", async () => {
    auth.user = USER;
    const res = await app.inject({ method: "GET", url: "/api/collection/map?regionId=nope" });
    expect(res.statusCode).toBe(400);
  });
});
