// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Per-photo card crops: a trip card showing a photo other than the featured one keeps its own
// crop, while the featured photo's crop stays on user_species, shared with the Collection card.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000801";
const OTHER = "eeeeeeee-0000-4000-8000-000000000802";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000080a";
const TOKEN = "lifer_test_photo_card_crop_801";

describe.skipIf(!url)("per-photo card crops", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let tripId: string;
  // featured: the species' featured photo. tripPick: rated higher, so the trip card shows it.
  const ids = { featured: "", tripPick: "", foreign: "", trashed: "", featuredCapture: "", pickCapture: "" };

  const call = (method: "GET" | "PATCH", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const saveCrop = (body: object) => call("PATCH", `/api/species/${SPECIES}/card-crop`, body);
  const speciesCrop = async () =>
    (
      await db.query(
        `SELECT cover_photo_id, card_crop_x::float AS x, card_crop_y::float AS y, card_crop_size::float AS size
         FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [USER, SPECIES],
      )
    ).rows[0];
  const photoCrop = async (id: string) =>
    (
      await db.query(
        `SELECT card_crop_x::float AS x, card_crop_y::float AS y, card_crop_size::float AS size FROM photos WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const tripCard = async () => {
    const res = await call("GET", `/api/trips/${tripId}/species`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().items[0];
  };

  async function addPhoto(userId: string, rating: number, extra = "") {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating, trip_id${extra ? ", deleted_at" : ""})
       VALUES ($1, $2, gen_random_uuid()::text, now(), $3, $4${extra ? ", now()" : ""}) RETURNING id`,
      [userId, SPECIES, rating, userId === USER ? tripId : null],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return { capture: c.rows[0].id, photo: p.rows[0].id };
  }

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1::uuid[])`, [[USER, OTHER]]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER, OTHER]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { collectionRoutes } = await import("./routes.js");
    const { tripsRoutes } = await import("../trips/routes.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'photo-crop@test', 'x'), ($2, 'photo-crop-other@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920801, 'Testus croppus', 'Crop Bird', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    tripId = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Coast', '/nowhere', '/nowhere') RETURNING id`,
        [USER],
      )
    ).rows[0].id;
    const featured = await addPhoto(USER, 1);
    const pick = await addPhoto(USER, 5);
    ids.featured = featured.photo;
    ids.featuredCapture = featured.capture;
    ids.tripPick = pick.photo;
    ids.pickCapture = pick.capture;
    ids.foreign = (await addPhoto(OTHER, 1)).photo;
    ids.trashed = (await addPhoto(USER, 1, "trashed")).photo;

    app = Fastify();
    await app.register(cookie);
    await app.register(collectionRoutes, { prefix: "/api" });
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(
      `UPDATE photos SET card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL WHERE id = ANY($1)`,
      [[ids.featured, ids.tripPick]],
    );
    await db.query(`UPDATE captures_all SET quality_rating = CASE WHEN id = $1 THEN 5 ELSE 1 END WHERE user_id = $2`, [
      ids.pickCapture,
      USER,
    ]);
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected, cover_photo_id, card_crop_x, card_crop_y, card_crop_size)
       VALUES ($1, $2, 'collected', CURRENT_DATE, $3, 5, 6, 50)`,
      [USER, SPECIES, ids.featured],
    );
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("saves a crop on a non-featured photo there, leaving the featured crop alone", async () => {
    expect((await saveCrop({ x: 10, y: 20, size: 30, photoId: ids.tripPick })).json()).toEqual({ ok: true });
    expect(await photoCrop(ids.tripPick)).toEqual({ x: 10, y: 20, size: 30 });
    expect(await speciesCrop()).toEqual({ cover_photo_id: ids.featured, x: 5, y: 6, size: 50 });

    // A fresh listing shows the trip's photo with its own crop.
    const card = await tripCard();
    expect(card.coverPhotoUrl).toContain(ids.tripPick);
    expect([card.cardCropX, card.cardCropY, card.cardCropSize]).toEqual([10, 20, 30]);
  });

  it("resets a non-featured photo's crop only", async () => {
    await saveCrop({ x: 10, y: 20, size: 30, photoId: ids.tripPick });
    expect((await saveCrop({ reset: true, photoId: ids.tripPick })).json()).toEqual({ ok: true });
    expect(await photoCrop(ids.tripPick)).toEqual({ x: null, y: null, size: null });
    expect(await speciesCrop()).toMatchObject({ x: 5, y: 6, size: 50 });
  });

  it("refuses someone else's photo, a trashed one and a malformed id", async () => {
    for (const photoId of [ids.foreign, ids.trashed]) {
      const res = await saveCrop({ x: 10, y: 20, size: 30, photoId });
      expect([res.statusCode, res.json()]).toEqual([
        403,
        { error: "That photo doesn't belong to you for this species" },
      ]);
      expect(await photoCrop(photoId)).toEqual({ x: null, y: null, size: null });
    }
    expect((await saveCrop({ reset: true, photoId: "nope" })).statusCode).toBe(400);
    expect(await speciesCrop()).toMatchObject({ x: 5, y: 6, size: 50 });
  });

  it("edits the featured crop when the trip card shows the featured photo", async () => {
    await db.query(`UPDATE captures_all SET quality_rating = CASE WHEN id = $1 THEN 5 ELSE 1 END WHERE user_id = $2`, [
      ids.featuredCapture,
      USER,
    ]);
    // A stale per-photo crop on the featured photo is dropped, so there's one source of truth.
    await db.query(`UPDATE photos SET card_crop_x = 1, card_crop_y = 1, card_crop_size = 9 WHERE id = $1`, [
      ids.featured,
    ]);
    expect((await saveCrop({ x: 11, y: 12, size: 40, photoId: ids.featured })).json()).toEqual({ ok: true });
    expect(await speciesCrop()).toEqual({ cover_photo_id: ids.featured, x: 11, y: 12, size: 40 });
    expect(await photoCrop(ids.featured)).toEqual({ x: null, y: null, size: null });
    const card = await tripCard();
    expect(card.coverPhotoUrl).toContain(ids.featured);
    expect([card.cardCropX, card.cardCropY, card.cardCropSize]).toEqual([11, 12, 40]);

    // Without photoId (the Collection card and species page) it's the same featured crop.
    expect((await saveCrop({ x: 0, y: 0, size: 100 })).json()).toEqual({ ok: true });
    expect(await speciesCrop()).toMatchObject({ x: 0, y: 0, size: 100 });
  });

  it("carries a photo's own crop over when it becomes featured, and keeps it when replaced", async () => {
    await saveCrop({ x: 10, y: 20, size: 30, photoId: ids.tripPick });
    expect((await call("PATCH", `/api/species/${SPECIES}/cover`, { photoId: ids.tripPick })).json()).toEqual({
      ok: true,
    });
    expect(await speciesCrop()).toEqual({ cover_photo_id: ids.tripPick, x: 10, y: 20, size: 30 });

    // Repointing the cover elsewhere: the old photo still has its saved crop.
    await call("PATCH", `/api/species/${SPECIES}/cover`, { photoId: ids.featured });
    expect(await photoCrop(ids.tripPick)).toEqual({ x: 10, y: 20, size: 30 });
    // Automatic repoints (trash, version swaps) clear the crop and the photo's own comes in.
    await db.query(
      `UPDATE user_species SET cover_photo_id = $1, card_crop_x = NULL, card_crop_y = NULL, card_crop_size = NULL
       WHERE user_id = $2 AND species_id = $3`,
      [ids.tripPick, USER, SPECIES],
    );
    expect(await speciesCrop()).toEqual({ cover_photo_id: ids.tripPick, x: 10, y: 20, size: 30 });
  });
});
