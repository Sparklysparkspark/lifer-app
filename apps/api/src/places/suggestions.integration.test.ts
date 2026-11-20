// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database (lifer_test).
// Suggested places from the user's own photo points, dismissals, and a place's photos drawn as
// its one map mark (by point, whenever they were placed).
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000c11";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000c12";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "suggest@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("suggested places", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const call = (method: "GET" | "POST", route: string, payload?: object) =>
    app.inject({ method, url: `/api${route}`, payload });

  async function suggested() {
    const { suggestionsSettled } = await import("./suggestions.js");
    await call("GET", "/places/suggested");
    await suggestionsSettled(USER);
    return (await call("GET", "/places/suggested")).json();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { placeSuggestionRoutes } = await import("./suggestions.js");
    const { galleryMapRoutes } = await import("../gallery/map.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'suggest@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915931, 'Suggestia alba', 'Suggest Bird', 'aves')`,
      [SPECIES],
    );
    // Four photos at a pond on three days, two lone ones far away.
    const rows: Array<[number, number, string]> = [
      [53.9, -122.75, "2026-05-01"],
      [53.9002, -122.7502, "2026-05-01"],
      [53.9001, -122.7498, "2026-06-12"],
      [53.8999, -122.7501, "2026-07-02"],
      [49, -123, "2026-05-01"],
      [45, -75, "2026-05-02"],
    ];
    for (const [i, [lat, lon, day]] of rows.entries())
      await db.query(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, taken_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [USER, SPECIES, `suggest-${i}`, lat, lon, `${day}T12:00:00Z`],
      );
    // The map, like the Gallery, shows only photos with a picture to show.
    await db.query(
      `WITH c AS (SELECT id FROM captures_all WHERE user_id = $1),
            p AS (INSERT INTO photos (capture_id, display_path, thumb_path)
                  SELECT id, '/x/d.webp', '/x/t.webp' FROM c RETURNING id, capture_id)
       UPDATE captures_all SET current_photo_id = p.id FROM p WHERE captures_all.id = p.capture_id`,
      [USER],
    );
    app = Fastify();
    await app.register(placeSuggestionRoutes, { prefix: "/api" });
    await app.register(galleryMapRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("answers at once, then suggests the spot the user went back to", async () => {
    const first = (await call("GET", "/places/suggested")).json();
    expect(first.updating).toBe(true);
    const done = await suggested();
    expect(done.updating).toBe(false);
    expect(done.suggestions).toHaveLength(1);
    expect(done.suggestions[0]).toMatchObject({ count: 4, days: 3, radiusM: 50 });
  });

  it("never brings a dismissed suggestion back, and Undo does", async () => {
    const [s] = (await suggested()).suggestions;
    expect((await call("POST", "/places/suggested/dismiss", { cell: s.cell })).statusCode).toBe(200);
    expect((await suggested()).suggestions).toEqual([]);
    await call("POST", "/places/suggested/restore", { cell: s.cell });
    expect((await suggested()).suggestions).toHaveLength(1);
  });

  it("drops a suggestion once a place covers it, and draws that place's photos as its own mark", async () => {
    const spot = await db.query<{ id: string }>(
      `INSERT INTO saved_spots (user_id, name, lat, lon, radius_m) VALUES ($1, 'Pond', 53.9, -122.75, 100) RETURNING id`,
      [USER],
    );
    expect((await suggested()).suggestions).toEqual([]);
    const map = (await call("GET", "/gallery/map")).json();
    expect(map.places).toEqual([expect.objectContaining({ spotId: spot.rows[0].id, count: 4 })]);
    expect(map.cells.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(2);
  });
});
