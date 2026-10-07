// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run collection/routes
// The species cover and card crop routes: what they refuse, and that valid input still saves.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000701";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000070a";
const TOKEN = "lifer_test_collection_routes_701";

describe.skipIf(!url)("collection routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let photoId: string;

  const call = (method: "GET" | "PATCH", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const crop = async () =>
    (
      await db.query(
        `SELECT cover_photo_id, card_crop_x::float AS x, card_crop_y::float AS y, card_crop_size::float AS size
         FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [USER, SPECIES],
      )
    ).rows[0];

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { collectionRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'collection-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920701, 'Testus coverus', 'Cover Bird', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, 'collection-routes-1', now()) RETURNING id`,
      [USER, SPECIES],
    );
    // The display file doesn't exist, so choosing it as cover leaves the crop unset.
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    photoId = p.rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photoId, c.rows[0].id]);
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES ($1, $2, 'collected', CURRENT_DATE)`,
      [USER, SPECIES],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(collectionRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("sets and clears the cover, refusing a missing, malformed or padded photoId", async () => {
    const cover = (body: unknown, species = SPECIES) => call("PATCH", `/api/species/${species}/cover`, body);
    for (const body of [{}, { photoId: "nope" }, { photoId: 7 }, { photoId, extra: 1 }]) {
      const res = await cover(body);
      expect([body, res.statusCode, res.json().code]).toEqual([body, 400, "invalid_request"]);
    }
    const badSpecies = await cover({ photoId }, "nope");
    expect([badSpecies.statusCode, badSpecies.json()]).toEqual([404, { error: "Species not found" }]);

    expect((await cover({ photoId })).json()).toEqual({ ok: true });
    expect((await crop()).cover_photo_id).toBe(photoId);
    expect((await cover({ photoId: null })).json()).toEqual({ ok: true });
    expect((await crop()).cover_photo_id).toBeNull();
    expect((await cover({ photoId })).statusCode).toBe(200);
  });

  it("saves or resets the card crop, refusing out-of-range or mistyped values", async () => {
    const save = (body: unknown) => call("PATCH", `/api/species/${SPECIES}/card-crop`, body);
    for (const body of [
      { x: -1, y: 10, size: 20 },
      { x: 10, y: 101, size: 20 },
      { x: 10, y: 10, size: 0 },
      { x: "10", y: 10, size: 20 },
      { x: 10, y: 10, size: 20, reset: "yes" },
      { x: 10, y: 10, size: 20, zoom: 2 },
    ]) {
      const res = await save(body);
      expect([body, res.statusCode, res.json().code]).toEqual([body, 400, "invalid_request"]);
    }
    // All three are needed unless resetting.
    expect((await save({ x: 10, y: 10 })).statusCode).toBe(400);

    expect((await save({ x: 0, y: 100, size: 100 })).json()).toEqual({ ok: true });
    expect(await crop()).toMatchObject({ x: 0, y: 100, size: 100 });
    expect((await save({ reset: true })).json()).toEqual({ ok: true });
    expect(await crop()).toMatchObject({ x: null, y: null, size: null });
    const badSpecies = await call("PATCH", "/api/species/nope/card-crop", { reset: true });
    expect([badSpecies.statusCode, badSpecies.json()]).toEqual([404, { error: "Species not found" }]);
  });

  it("filters the collection by taxon, treating an empty filter as none", async () => {
    const all = await call("GET", "/api/collection/count?taxon=");
    expect(all.statusCode, all.body).toBe(200);
    const mammals = await call("GET", "/api/collection/count?taxon=mammalia");
    expect(mammals.json().collected).toBe(all.json().collected - 1);
  });
});
