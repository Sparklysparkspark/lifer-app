// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000a01";
const TOKEN = "lifer_test_yir_owner_a01";
const COMMON = "eeeeeeee-0000-4000-8000-000000000a02";
const RARE = "eeeeeeee-0000-4000-8000-000000000a03";
const OLD = "eeeeeeee-0000-4000-8000-000000000a04";
const TRIP = "eeeeeeee-0000-4000-8000-000000000a05";

describe.skipIf(!url)("GET /api/stats/year-in-review", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const get = (q = "") =>
    app.inject({ method: "GET", url: `/api/stats/year-in-review${q}`, cookies: { [cookieName]: TOKEN } });

  async function addCapture(
    species: string,
    n: number,
    takenAt: string,
    lat: number | null,
    rating: number,
    trip?: string,
  ) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, lat, lon, identification_state, quality_rating, camera_model, lens, trip_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, 'EOS R5', 'RF 100-500', $8) RETURNING id`,
      [OWNER, species, `yir-${species}-${n}`, takenAt, lat, lat === null ? null : -123.1, rating, trip ?? null],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', 400, 300) RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, 'jpeg', 'path', $2, false, $2, 1)`,
      [c.rows[0].id, `yir-${c.rows[0].id}`],
    );
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { statsRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[COMMON, RARE, OLD]]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'yir@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 915911, 'Yearia communis', 'Common Year', 'aves'),
         ($2, 915912, 'Yearia rara', 'Rare Year', 'aves'),
         ($3, 915913, 'Yearia vetus', 'Old Year', 'aves')`,
      [COMMON, RARE, OLD],
    );
    await db.query(
      `INSERT INTO species_traits (species_id, iucn_status, source_attribution) VALUES ($1, 'EN', 'test')`,
      [RARE],
    );
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES
         ($1, $2, 'collected', '2025-06-01'), ($1, $3, 'collected', '2025-09-01'), ($1, $4, 'collected', '2024-04-01')`,
      [OWNER, COMMON, RARE, OLD],
    );
    await db.query(
      `INSERT INTO trips (id, user_id, name, start_date, end_date, source_folder, destination_folder) VALUES ($1, $2, 'Coast', '2025-06-01', '2025-06-03', '/nowhere', '/nowhere')`,
      [TRIP, OWNER],
    );
    await addCapture(COMMON, 0, "2025-06-01T10:00:00Z", 49.28, 5, TRIP);
    await addCapture(COMMON, 1, "2025-06-02T10:00:00Z", 49.281, 3, TRIP);
    await addCapture(RARE, 0, "2025-09-01T10:00:00Z", 12.34, 4);
    await addCapture(OLD, 0, "2024-04-01T10:00:00Z", 48.43, 3);

    app = Fastify();
    await app.register(cookie);
    await app.register(statsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[COMMON, RARE, OLD]]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("answers each figure for the year", async () => {
    const res = await get("?year=2025");
    expect(res.statusCode).toBe(200);
    const r = res.json();
    expect(r.years).toEqual([2025, 2024]);
    expect(r.counts).toEqual({ photos: 3, newSpecies: 2, trips: 1, places: 1 });
    expect(r.previous).toEqual({ photos: 1, newSpecies: 1, trips: 0, places: 1 });
    expect(r.firsts.total).toBe(2);
    expect(r.firsts.items.map((f: { scientificName: string }) => f.scientificName)).toEqual([
      "Yearia communis",
      "Yearia rara",
    ]);
    expect(r.firsts.items[0].photoId).toBeTruthy();
    expect(r.bestPhotos).toHaveLength(3);
    expect(r.bestPhotos[0]).toMatchObject({ width: 400, height: 300 });
    expect(r.monthsByGroup).toEqual([
      { month: 6, taxonClass: "aves", count: 2 },
      { month: 9, taxonClass: "aves", count: 1 },
    ]);
    expect(r.trips).toMatchObject([{ id: TRIP, name: "Coast", start: "2025-06-01", end: "2025-06-03", photoCount: 2 }]);
    expect(r.trips[0].coverPhotoId).toBeTruthy();
    expect(r.gear.cameras).toEqual([{ model: "EOS R5", photoCount: 3 }]);
  });

  it("never reveals where a sensitive species was photographed", async () => {
    const r = (await get("?year=2025")).json();
    expect(r.places).toHaveLength(1);
    expect(JSON.stringify(r)).not.toContain("12.3");
  });

  it("defaults to the newest year and handles a year with no photos", async () => {
    expect((await get()).json().year).toBe(2025);
    const empty = (await get("?year=2010")).json();
    expect(empty.counts).toEqual({ photos: 0, newSpecies: 0, trips: 0, places: 0 });
    expect(empty).toMatchObject({ bestPhotos: [], trips: [], places: [], firsts: { total: 0, items: [] } });
  });

  it("handles a year with one photo", async () => {
    const r = (await get("?year=2024")).json();
    expect(r.counts).toEqual({ photos: 1, newSpecies: 1, trips: 0, places: 1 });
    expect(r.bestPhotos).toHaveLength(1);
  });

  it("matches Stats' new lifers for the same year", async () => {
    const { loadStatsOverview } = await import("./overview.js");
    const client = await db.connect();
    try {
      const stats = await loadStatsOverview(client, OWNER, "all", 0);
      const fromStats = stats.perMonth.filter((m) => m.month.startsWith("2025")).reduce((n, m) => n + m.newLifers, 0);
      expect((await get("?year=2025")).json().counts.newSpecies).toBe(fromStats);
    } finally {
      client.release();
    }
  });
});
