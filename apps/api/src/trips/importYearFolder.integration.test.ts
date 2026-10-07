// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55473/lifer npx vitest run trips/importYearFolder
// A trip import files its copy under the camera's own year, like an upload, whatever zone the
// server runs in. Here the server is 14 hours ahead of UTC, so a New Year's Eve evening photo
// would land in next year's folder if its instant were read in the server's zone.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.TZ = "Pacific/Kiritimati";
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000741";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000742";

describe.skipIf(!url)("trip import year folder", () => {
  let db: pg.Pool;
  let dir: string;
  let tripId: string;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(
      `DELETE FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`,
      [USER],
    );
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-trip-year-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, organize_originals_by_year) VALUES ($1, 'trip-year@test', 'x', true)`,
      [USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915741, 'Annus novus', 'New Year Gull', 'aves')`,
      [SPECIES],
    );
    const trip = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'NYE', $2, $3) RETURNING id`,
      [USER, path.join(dir, "card"), path.join(dir, "card", "Wildlife")],
    );
    tripId = trip.rows[0].id;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("goes by the camera's wall-clock year", async () => {
    const source = path.join(dir, "card", "IMG_1231.jpg");
    mkdirSync(path.dirname(source), { recursive: true });
    await sharp({ create: { width: 64, height: 48, channels: 3, background: "#468" } })
      .withExif({ IFD0: { Model: "Year Test" }, IFD2: { DateTimeOriginal: "2025:12:31 20:00:00" } })
      .jpeg()
      .toFile(source);
    const { importInboxFile } = await import("./import.js");
    const result = await importInboxFile(tripId, USER, SPECIES, source, path.join(dir, "card", "Wildlife"), null, []);
    expect("captureId" in result).toBe(true);
    const row = await db.query<{ ref: string }>(
      `SELECT o.ref FROM originals o JOIN captures_all c ON c.id = o.capture_id WHERE c.user_id = $1`,
      [USER],
    );
    expect(path.relative(path.join(dir, "card", "Wildlife"), row.rows[0].ref)).toBe(
      path.join("Wildlife 2025", "Birds", "New Year Gull", "Adjusted", "IMG_1231.jpg"),
    );
  });
});
