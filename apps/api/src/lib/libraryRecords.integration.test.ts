// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A fresh install pointed at an old library: trips come back from their folders' .lifer/trip.json
// with their photos, covers and details, and album details from the library's album-details.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000301";
const OTHER = "eeeeeeee-0000-4000-8000-000000000302";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000030a";

describe.skipIf(!url)("library records: trips and album details", () => {
  let db: pg.Pool;
  let library: string;
  let tripFolder: string;
  let records: typeof import("./libraryRecords.js");
  const captures: string[] = [];
  const photos: string[] = [];
  const files: string[] = [];
  let tripId: string;
  const recordFile = () => path.join(tripFolder, "Wildlife", ".lifer", "trip.json");
  const cleanUp = async () => {
    for (const u of [USER, OTHER]) {
      await db.query(`DELETE FROM trips WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM albums WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
  };

  beforeAll(async () => {
    library = mkdtempSync(path.join(tmpdir(), "lifer-records-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = library;
    process.env.APP_DATA_DIR = path.join(library, "app-data");
    db = new pg.Pool({ connectionString: url });
    records = await import("./libraryRecords.js");

    await cleanUp();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'records@test', 'x')`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'other-records@test', 'x')`, [OTHER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 930301, 'Testus recordus', 'Record Bird', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );

    tripFolder = path.join(library, "Trips", "Costa Rica 2026");
    mkdirSync(path.join(tripFolder, "Wildlife"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      const file = path.join(tripFolder, "Wildlife", `IMG_${i}.jpg`);
      writeFileSync(file, "x");
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, now()) RETURNING id`,
        [USER, SPECIES, `records-${i}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size)
         VALUES ($1, 'jpeg', 'path', $2, true, $3, $4, 1)`,
        [c.rows[0].id, file, USER, `records-hash-${i}`],
      );
      captures.push(c.rows[0].id);
      photos.push(p.rows[0].id);
      files.push(file);
    }
    // A trip of the first two photos, with a framed cover; an album with details and one without photos.
    const trip = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, description, source_folder, destination_folder, cover_capture_id,
                          cover_crop_x, cover_crop_y, cover_crop_size)
       VALUES ($1, 'Costa Rica', 'Two weeks on the Osa', $2, $3, $4, 10, 20, 50) RETURNING id`,
      [USER, tripFolder, path.join(tripFolder, "Wildlife"), captures[1]],
    );
    tripId = trip.rows[0].id;
    await db.query(`UPDATE captures SET trip_id = $1 WHERE id = ANY($2)`, [tripId, captures.slice(0, 2)]);
    await db.query(
      `INSERT INTO albums (user_id, name, description, cover_photo_id, cover_layout, quad_photo_ids, quad_crops)
       VALUES ($1, 'Favourites', 'Best of the year', $2, 'quad', $3, $4)`,
      [
        USER,
        photos[2],
        [photos[0], null, photos[2], null],
        JSON.stringify([{ x: 1, y: 2, size: 30 }, null, null, null]),
      ],
    );
    await db.query(`INSERT INTO albums (user_id, name, description) VALUES ($1, 'Someday', 'Still empty')`, [USER]);
  });

  afterAll(async () => {
    if (db) {
      await cleanUp();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(library, { recursive: true, force: true });
  });

  it("records a trip in its own folder, with its photos relative to it", async () => {
    await records.saveTripRecords(USER);
    const file = JSON.parse(readFileSync(recordFile(), "utf8"));
    expect(Object.keys(file.trips)).toEqual([tripId]);
    const record = file.trips[tripId];
    expect(record).toMatchObject({
      owner: "records@test",
      name: "Costa Rica",
      description: "Two weeks on the Osa",
      sourceFolder: "..",
      destinationFolder: ".",
      cover: { file: "IMG_1.jpg", crop: { x: 10, y: 20, size: 50 } },
      photos: expect.arrayContaining(["IMG_0.jpg", "IMG_1.jpg"]),
    });
    expect(record.photos).toHaveLength(2);
  });

  it("brings trips and album details back on a fresh install, photos and covers included", async () => {
    await records.saveAlbumDetails(USER);
    // A fresh install: the photos are back from the reimport, but no trips or albums.
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`INSERT INTO albums (user_id, name) VALUES ($1, 'Favourites')`, [USER]); // from membership

    const restored = await records.restoreLibraryRecords(USER, library);
    expect(restored).toEqual({ trips: 1, tripPhotos: 2, albums: 2 });

    const trip = await db.query(
      `SELECT name, description, source_folder, destination_folder, cover_capture_id, cover_crop_x::float AS x
         FROM trips WHERE user_id = $1`,
      [USER],
    );
    expect(trip.rows).toEqual([
      {
        name: "Costa Rica",
        description: "Two weeks on the Osa",
        source_folder: tripFolder,
        destination_folder: path.join(tripFolder, "Wildlife"),
        cover_capture_id: captures[1],
        x: 10,
      },
    ]);
    const inTrip = await db.query(`SELECT id FROM captures WHERE user_id = $1 AND trip_id IS NOT NULL ORDER BY id`, [
      USER,
    ]);
    expect(inTrip.rows.map((r) => r.id).sort()).toEqual(captures.slice(0, 2).sort());

    const albums = await db.query(
      `SELECT name, description, cover_photo_id, cover_layout, quad_photo_ids, quad_crops FROM albums
        WHERE user_id = $1 ORDER BY name`,
      [USER],
    );
    expect(albums.rows).toEqual([
      {
        name: "Favourites",
        description: "Best of the year",
        cover_photo_id: photos[2],
        cover_layout: "quad",
        quad_photo_ids: [photos[0], null, photos[2], null],
        quad_crops: [{ x: 1, y: 2, size: 30 }, null, null, null],
      },
      {
        name: "Someday",
        description: "Still empty",
        cover_photo_id: null,
        cover_layout: "single", // the column default
        quad_photo_ids: null,
        quad_crops: null,
      },
    ]);

    // Running it again changes nothing: the trip is known by its folder, the albums have details.
    expect(await records.restoreLibraryRecords(USER, library)).toEqual({ trips: 0, tripPhotos: 0, albums: 0 });
  });

  it("keeps every trip that shares a folder, and restores only the reimporting user's", async () => {
    // A second trip of this user's and one of another user's, both filed in the same folder.
    const second = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Osa again', $2, $3) RETURNING id`,
      [USER, path.join(library, "Elsewhere"), path.join(tripFolder, "Wildlife")],
    );
    await db.query(`UPDATE captures SET trip_id = $1 WHERE id = $2`, [second.rows[0].id, captures[2]]);
    const theirs = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Theirs', $2, $3) RETURNING id`,
      [OTHER, tripFolder, path.join(tripFolder, "Wildlife")],
    );
    await records.saveTripRecords(OTHER);
    await records.saveTripRecords(USER);
    const file = JSON.parse(readFileSync(recordFile(), "utf8"));
    expect(Object.keys(file.trips).sort()).toEqual([tripId, second.rows[0].id, theirs.rows[0].id].sort());
    expect(file.trips[second.rows[0].id].photos).toEqual(["IMG_2.jpg"]);

    await db.query(`DELETE FROM trips WHERE user_id = ANY($1)`, [[USER, OTHER]]);
    expect(await records.restoreLibraryRecords(USER, library)).toMatchObject({ trips: 2, tripPhotos: 3 });
    const restored = await db.query(`SELECT id, user_id FROM trips WHERE user_id = ANY($1) ORDER BY name`, [
      [USER, OTHER],
    ]);
    expect(restored.rows).toEqual([
      { id: tripId, user_id: USER },
      { id: second.rows[0].id, user_id: USER },
    ]);
    // A bad record is skipped without stopping the rest.
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE id = $1`, [theirs.rows[0].id]);
    file.trips[tripId].photos = undefined;
    writeFileSync(recordFile(), JSON.stringify(file));
    expect(await records.restoreLibraryRecords(USER, library)).toMatchObject({ trips: 1, tripPhotos: 1 });
    expect((await db.query(`SELECT id FROM trips WHERE id = $1`, [tripId])).rowCount).toBe(0);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures SET trip_id = NULL WHERE user_id = $1`, [USER]);
  });

  it("forgets a deleted trip, so a reimport doesn't bring it back", () => {
    const file = JSON.parse(readFileSync(recordFile(), "utf8"));
    const ids = Object.keys(file.trips);
    expect(ids.length).toBeGreaterThan(1);
    records.removeTripRecord(tripId, tripFolder, path.join(tripFolder, "Wildlife"));
    expect(Object.keys(JSON.parse(readFileSync(recordFile(), "utf8")).trips)).not.toContain(tripId);
    for (const id of ids.filter((x) => x !== tripId))
      records.removeTripRecord(id, tripFolder, path.join(tripFolder, "Wildlife"));
    expect(existsSync(recordFile())).toBe(false);
    expect(records.findTripRecords(library)).toEqual([]);
  });
});
