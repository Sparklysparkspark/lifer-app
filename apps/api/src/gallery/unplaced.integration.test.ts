// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /gallery/map/unplaced: photos without coordinates grouped by trip, then by session (a gap
// over an hour starts a new one); region-only and no-location photos never share a group; a
// group's key lists exactly its photos; paging is stable.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000711";
const SPECIES = "ffffffff-0000-4000-8000-0000000007a1";
const REGION = "ffffffff-0000-4000-8000-0000000007b1";
const TRIP = "ffffffff-0000-4000-8000-0000000007c1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "unplaced@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

interface Group {
  key: string;
  tripId: string | null;
  regionId: string | null;
  count: number;
  coverPhotoIds: string[];
}

describe.skipIf(!url)("GET /gallery/map/unplaced", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const get = async (path: string) => (await app.inject({ method: "GET", url: `/api${path}` })).json();

  async function add(opts: { at?: string; region?: string; trip?: string; lat?: number }) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, region_id, trip_id, lat, lon)
       VALUES ($1, $2, gen_random_uuid()::text, $3, $4, $5, $6, $6) RETURNING id`,
      [USER, SPECIES, opts.at ?? null, opts.region ?? null, opts.trip ?? null, opts.lat ?? null],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/x/d.webp', '/x/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return c.rows[0].id;
  }

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'unplaced@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 912701, 'Nusquam locata', 'Lost Lark', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Unplaced Province')`, [REGION]);
    await db.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder) VALUES ($1, $2, 'Coast trip', '/x', '/x')`,
      [TRIP, USER],
    );
    // Two sessions in the region, 90 minutes apart; one of them gets a no-location photo between.
    await add({ at: "2026-05-01T08:00:00Z", region: REGION });
    await add({ at: "2026-05-01T08:30:00Z", region: REGION });
    await add({ at: "2026-05-01T08:40:00Z" });
    await add({ at: "2026-05-01T10:10:00Z", region: REGION });
    // A trip's photos, and a placed photo that never shows.
    await add({ at: "2026-06-01T09:00:00Z", trip: TRIP });
    await add({ at: "2026-06-01T09:20:00Z", trip: TRIP });
    await add({ at: "2026-06-01T09:10:00Z", trip: TRIP, lat: 5 });
    await add({ region: REGION });

    const { galleryMapRoutes } = await import("./map.js");
    app = Fastify();
    await app.register(galleryMapRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db?.end();
  });

  it("puts trips first, then sessions split by an hour's gap and by region", async () => {
    const { groups, nextCursor } = await get("/gallery/map/unplaced");
    expect(nextCursor).toBeNull();
    expect(groups.map((g: Group) => [g.tripId, g.regionId, g.count])).toEqual([
      [TRIP, null, 2],
      // Newest first outside trips; the no-date photos last.
      [null, REGION, 1],
      [null, null, 1],
      [null, REGION, 2],
      [null, REGION, 1],
    ]);
    expect(groups.every((g: Group) => g.coverPhotoIds.length === Math.min(g.count, 4))).toBe(true);
  });

  it("keeps region-only and no-location photos apart", async () => {
    const region = (await get("/gallery/map/unplaced?state=region")).groups;
    const none = (await get("/gallery/map/unplaced?state=none")).groups;
    expect(region.every((g: Group) => g.regionId === REGION)).toBe(true);
    expect(none.every((g: Group) => g.regionId === null)).toBe(true);
    expect(region.length + none.length).toBe(5);
  });

  it("lists exactly a group's photos from its key", async () => {
    const { groups } = await get("/gallery/map/unplaced");
    for (const g of groups as Group[]) {
      const photos = await get(`/gallery/map/unplaced/photos?key=${encodeURIComponent(g.key)}`);
      expect(photos.captureIds).toHaveLength(g.count);
      expect(photos.photoIds).toHaveLength(g.count);
    }
    expect((await app.inject({ method: "GET", url: "/api/gallery/map/unplaced/photos?key=nope" })).statusCode).toBe(
      400,
    );
  });

  it("pages the same way twice", async () => {
    const a = await get("/gallery/map/unplaced?cursor=2");
    const b = await get("/gallery/map/unplaced?cursor=2");
    expect(a.groups.map((g: Group) => g.key)).toEqual(b.groups.map((g: Group) => g.key));
    expect(a.groups).toHaveLength(3);
  });
});
