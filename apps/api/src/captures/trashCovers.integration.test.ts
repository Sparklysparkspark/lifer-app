// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer npx vitest run trashCovers
// Trashing a species' featured photo moves its cover to the best photo left instead of leaving it
// on the trashed file (a 404 thumbnail on every card), and restoring from the trash doesn't break
// it. Album and trip covers fall back the same way while their picked photo is in the trash.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000701";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000070a";
const TOKEN = "lifer_test_trash_covers_701";

describe.skipIf(!url)("covers when a photo is trashed", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  // featured: 3 stars, the user's pick. best: 5 stars, the oldest. newest: unrated.
  const capture = { featured: "", best: "", newest: "" };
  const photo = { featured: "", best: "", newest: "" };
  let albumId: string;
  let tripId: string;

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  const speciesCover = async () =>
    (
      await db.query<{ cover_photo_id: string | null; state: string; card_crop_x: string | null }>(
        `SELECT cover_photo_id, state, card_crop_x FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [USER, SPECIES],
      )
    ).rows[0];

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-trash-covers-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("./routes.js");
    const { albumRoutes } = await import("../albums/routes.js");
    const { tripsRoutes } = await import("../trips/routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'trash-covers@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920701, 'Testus coverus', 'Cover Bird', 'aves')`,
      [SPECIES],
    );
    tripId = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Coast', '/nowhere', '/nowhere') RETURNING id`,
        [USER],
      )
    ).rows[0].id;
    const rows: Array<[keyof typeof capture, number | null, number]> = [
      ["best", 5, 30],
      ["featured", 3, 20],
      ["newest", null, 10],
    ];
    for (const [key, rating, daysAgo] of rows) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, quality_rating, trip_id, taken_at)
         VALUES ($1, $2, $3, $4, $5, now() - ($6 || ' days')::interval) RETURNING id`,
        [USER, SPECIES, `trash-covers-${key}`, rating, tripId, String(daysAgo)],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      capture[key] = c.rows[0].id;
      photo[key] = p.rows[0].id;
    }
    // The user featured the 3-star photo and framed its card.
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected, best_quality, card_crop_x, card_crop_y, card_crop_size)
       VALUES ($1, $2, 'collected', $3, CURRENT_DATE, 5, 10, 10, 50)`,
      [USER, SPECIES, photo.featured],
    );
    await db.query(
      `UPDATE trips SET cover_capture_id = $1, cover_crop_x = 5, cover_crop_y = 5, cover_crop_size = 50 WHERE id = $2`,
      [capture.featured, tripId],
    );
    albumId = (
      await db.query<{ id: string }>(
        `INSERT INTO albums (user_id, name, cover_photo_id, cover_crop_x, cover_crop_y, cover_crop_size)
         VALUES ($1, 'Favourites', $2, 5, 5, 50) RETURNING id`,
        [USER, photo.featured],
      )
    ).rows[0].id;
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2), ($1, $3)`, [
      albumId,
      capture.featured,
      capture.newest,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.register(albumRoutes, { prefix: "/api" });
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("moves the species cover to the best remaining photo when the featured one is trashed", async () => {
    const res = await call("DELETE", `/api/captures/${capture.featured}`);
    expect(res.statusCode, res.body).toBe(200);
    // Highest rated wins over newest, and the crop framed for the old photo is cleared.
    expect(await speciesCover()).toEqual({ cover_photo_id: photo.best, state: "collected", card_crop_x: null });
  });

  it("falls back to another album and trip photo while their picked one is in the trash", async () => {
    const albums = (await call("GET", "/api/albums")).json().albums;
    expect(albums).toEqual([
      expect.objectContaining({ id: albumId, coverPhotoId: photo.newest, coverCropX: null, coverCropSize: null }),
    ]);
    const album = (await call("GET", `/api/albums/${albumId}`)).json();
    expect(album).toEqual(expect.objectContaining({ coverPhotoId: photo.newest, coverCropX: null }));
    const trips = (await call("GET", "/api/trips")).json().trips;
    expect(trips).toEqual([
      expect.objectContaining({ id: tripId, coverPhotoUrl: `/api/photos/${photo.newest}/thumb`, coverCropX: null }),
    ]);
  });

  it("keeps moving the cover as more photos are batch-trashed, then clears it when none are left", async () => {
    let res = await call("POST", "/api/captures/batch-delete", { captureIds: [capture.best] });
    expect(res.json()).toEqual({ deleted: 1, notFound: 0 });
    expect((await speciesCover()).cover_photo_id).toBe(photo.newest);

    res = await call("POST", "/api/captures/batch-delete", { captureIds: [capture.newest] });
    expect(res.json()).toEqual({ deleted: 1, notFound: 0 });
    // Nothing left to show: no cover, but still collected, since the photos can be restored.
    expect(await speciesCover()).toEqual({ cover_photo_id: null, state: "collected", card_crop_x: null });
  });

  it("gives a species with no photos left its cover back on restore, without taking over a later pick", async () => {
    let res = await call("POST", `/api/trash/${capture.featured}/restore`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await speciesCover()).cover_photo_id).toBe(photo.featured);

    // Another restore leaves the cover where it is, even on a better-rated photo.
    res = await call("POST", `/api/trash/${capture.best}/restore`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await speciesCover()).cover_photo_id).toBe(photo.featured);

    // The album's and trip's own picks come back with their crops once their photo is restored.
    const albums = (await call("GET", "/api/albums")).json().albums;
    expect(albums[0]).toEqual(expect.objectContaining({ coverPhotoId: photo.featured, coverCropX: 5 }));
    const trips = (await call("GET", "/api/trips")).json().trips;
    expect(trips[0]).toEqual(
      expect.objectContaining({ coverPhotoUrl: `/api/photos/${photo.featured}/thumb`, coverCropX: 5 }),
    );
  });

  it("leaves an un-featured species without a cover when a photo is restored", async () => {
    // Un-featuring (PATCH /species/:id/cover with null, in the collection routes) stores this.
    await db.query(`UPDATE user_species SET cover_photo_id = NULL WHERE user_id = $1 AND species_id = $2`, [
      USER,
      SPECIES,
    ]);
    const res = await call("POST", `/api/trash/${capture.newest}/restore`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect((await speciesCover()).cover_photo_id).toBeNull();
  });
});
