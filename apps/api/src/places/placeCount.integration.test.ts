// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A new named place, applied to photos, files them; photos pinned inside its ring count too.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000d01";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "count@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("a named place's photos", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let species: string;
  // A photo the Gallery lists: a capture with its image.
  const photo = async (lat: number | null, lon: number | null) => {
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon)
         VALUES ($1, $2, gen_random_uuid()::text, $3, $4) RETURNING id`,
        [USER, species, lat, lon],
      )
    ).rows[0].id;
    const image = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [image.rows[0].id, id]);
    return id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { savedSpotRoutes } = await import("./savedSpots.js");
    const { galleryRoutes } = await import("../gallery/routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'count@test', 'x')`, [USER]);
    species = (await db.query<{ id: string }>(`SELECT id FROM species LIMIT 1`)).rows[0].id;
    app = Fastify();
    await app.register(savedSpotRoutes, { prefix: "/api" });
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await app.close();
    await db.end();
  });

  it("files the photos a new place is applied to, and counts the ones pinned inside it", async () => {
    // As the placing card's "Add as a new place", then "Place 2 photos here".
    const created = await app.inject({
      method: "POST",
      url: "/api/saved-spots",
      payload: { name: "Zzcount King Fisher Pond", lat: 53.9, lon: -122.75, radiusM: 100 },
    });
    expect(created.statusCode).toBe(200);
    const spot = created.json() as { id: string };
    const unplaced = [await photo(null, null), await photo(null, null)];
    const applied = await app.inject({
      method: "POST",
      url: `/api/saved-spots/${spot.id}/apply`,
      payload: { captureIds: unplaced, wait: true },
    });
    expect(applied.json()).toMatchObject({ ok: true, applied: 2 });
    const rows = await db.query(
      `SELECT lat::float8 AS lat, lon::float8 AS lon, location_label, location_source, location_accuracy_m::float8 AS acc
       FROM captures WHERE id = ANY($1::uuid[])`,
      [unplaced],
    );
    for (const r of rows.rows)
      expect(r).toMatchObject({
        lat: 53.9,
        lon: -122.75,
        location_label: "Zzcount King Fisher Pond",
        location_source: "spot",
        acc: 100,
      });

    // Two pinned inside the ring without choosing the place (about 55 m out), one well outside.
    const inside = [await photo(53.9005, -122.75), await photo(53.8995, -122.7502)];
    const outside = await photo(53.91, -122.75);

    const list = (await app.inject({ method: "GET", url: "/api/saved-spots" })).json();
    const mine = list.spots.find((s: { id: string }) => s.id === spot.id);
    expect(mine.photoCount).toBe(4);

    // The map's place panel lists by place name: the same four.
    const ids = (
      await app.inject({
        method: "GET",
        url: `/api/gallery/ids?place=${encodeURIComponent("Zzcount King Fisher Pond")}`,
      })
    ).json().captureIds as string[];
    expect(new Set(ids)).toEqual(new Set([...unplaced, ...inside]));
    expect(ids).not.toContain(outside);
  });
});
