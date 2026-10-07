// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55473/lifer npx vitest run speciesFolderMove
// A managed file moves within the folder it was filed under: the main library, a drive's or
// library root's "Lifer Originals" folder, or a trip's destination folder. Changing a photo's
// species and Reorganize never carry it off to the main library, and a file on a volume keeps
// its volume, with its stored relative path following the move.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000751";
const TOKEN = "lifer_test_species_folder_move_751";
const MALLARD = "eeeeeeee-0000-4000-8000-000000000752";
const FOX = "eeeeeeee-0000-4000-8000-000000000753";
const ROOT_VOLUME = "eeeeeeee-0000-4000-8000-000000000754";

describe.skipIf(!url)("moving managed files between species folders", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let dir: string;
  let lib: string;
  let rootDir: string;
  let tripDest: string;
  const captures: Record<"main" | "root" | "trip", string> = { main: "", root: "", trip: "" };

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(
      `DELETE FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`,
      [USER],
    );
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM storage_volumes WHERE id = $1`, [ROOT_VOLUME]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[MALLARD, FOX]]);
  }

  async function photoAt(file: string): Promise<void> {
    mkdirSync(path.dirname(file), { recursive: true });
    await sharp({ create: { width: 32, height: 24, channels: 3, background: "#579" } })
      .jpeg()
      .toFile(file);
  }

  async function addCapture(
    file: string,
    opts: { volume?: { id: string; mount: string }; tripId?: string; location?: string },
  ) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, trip_id, location_label)
       VALUES ($1, $2, $3, '2024-06-01T12:00:00Z', $4, $5) RETURNING id`,
      [USER, MALLARD, `move-${path.basename(file)}`, opts.tripId ?? null, opts.location ?? null],
    );
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id, volume_id, volume_relative_path)
       VALUES ($1, 'jpeg', 'path', $2, true, $3, 1, $4, $5, $6)`,
      [
        c.rows[0].id,
        file,
        `h-${path.basename(file)}`,
        USER,
        opts.volume?.id ?? null,
        opts.volume ? file.slice(opts.volume.mount.length) : null,
      ],
    );
    return c.rows[0].id;
  }

  const originalOf = async (captureId: string) =>
    (
      await db.query<{ ref: string; volume_id: string | null; volume_relative_path: string | null }>(
        `SELECT ref, volume_id, volume_relative_path FROM originals WHERE capture_id = $1`,
        [captureId],
      )
    ).rows[0];

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-species-move-")));
    lib = path.join(dir, "lib");
    rootDir = path.join(dir, "nas");
    tripDest = path.join(dir, "card", "Wildlife");
    mkdirSync(lib, { recursive: true });
    mkdirSync(rootDir, { recursive: true });
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = lib;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, organize_originals_by_year, organize_originals_by_location)
       VALUES ($1, 'species-move@test', 'x', true, true)`,
      [USER],
    );
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 915751, 'Anas movens', 'Moving Mallard', 'aves'), ($2, 915752, 'Vulpes movens', 'Moving Fox', 'mammalia')`,
      [MALLARD, FOX],
    );
    await db.query(
      `INSERT INTO storage_volumes (id, kind, label, root_path, last_known_mount_path) VALUES ($1, 'root', 'NAS', $2, $2)`,
      [ROOT_VOLUME, rootDir],
    );
    const trip = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Card', $2, $3) RETURNING id`,
      [USER, path.join(dir, "card"), tripDest],
    );

    // Filed by an upload with a location (year off at the time), a store-mode upload to the NAS
    // root, and a trip import.
    const mainFile = path.join(lib, "Point Reyes", "Birds", "Moving Mallard", "Adjusted", "main.jpg");
    const rootFile = path.join(
      rootDir,
      "Lifer Originals",
      "Wildlife 2024",
      "Birds",
      "Moving Mallard",
      "Adjusted",
      "root.jpg",
    );
    const tripFile = path.join(tripDest, "Wildlife 2024", "Birds", "Moving Mallard", "Adjusted", "trip.jpg");
    for (const f of [mainFile, rootFile, tripFile]) await photoAt(f);
    captures.main = await addCapture(mainFile, { location: "Point Reyes" });
    captures.root = await addCapture(rootFile, { volume: { id: ROOT_VOLUME, mount: rootDir } });
    captures.trip = await addCapture(tripFile, { tripId: trip.rows[0].id });

    const { settingsRoutes } = await import("../settings/routes.js");
    app = Fastify();
    await app.register(cookie);
    await app.register(settingsRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("changing the species moves each file within its own folder tree", async () => {
    const { reassignCaptureSpecies } = await import("../captures/routes.js");
    const log = { error: () => {} };
    for (const id of Object.values(captures))
      expect(await reassignCaptureSpecies(USER, id, FOX, log)).toEqual({ ok: true });

    const main = await originalOf(captures.main);
    expect(main.ref).toBe(path.join(lib, "Point Reyes", "Mammals", "Moving Fox", "Adjusted", "main.jpg"));
    const root = await originalOf(captures.root);
    const rootRel = path.join("/Lifer Originals", "Wildlife 2024", "Mammals", "Moving Fox", "Adjusted", "root.jpg");
    expect(root).toEqual({ ref: path.join(rootDir, rootRel), volume_id: ROOT_VOLUME, volume_relative_path: rootRel });
    const trip = await originalOf(captures.trip);
    expect(trip.ref).toBe(path.join(tripDest, "Wildlife 2024", "Mammals", "Moving Fox", "Adjusted", "trip.jpg"));
    for (const o of [main, root, trip]) expect([o.ref, existsSync(o.ref)]).toEqual([o.ref, true]);
    // The emptied old species folder is tidied away; the taxon folder above it stays.
    expect(existsSync(path.join(rootDir, "Lifer Originals", "Wildlife 2024", "Birds", "Moving Mallard"))).toBe(false);
  }, 60_000);

  it("Reorganize re-files each file under its own folder, keeping drive and location", async () => {
    await db.query(`UPDATE users SET organize_originals_by_year = false WHERE id = $1`, [USER]);
    const res = await app.inject({
      method: "POST",
      url: "/api/settings/reorganize-originals",
      cookies: { [cookieName]: TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ moved: 2, failed: 0 });

    // Already where the settings put it: the location folder stays.
    expect((await originalOf(captures.main)).ref).toBe(
      path.join(lib, "Point Reyes", "Mammals", "Moving Fox", "Adjusted", "main.jpg"),
    );
    const rootRel = path.join("/Lifer Originals", "Mammals", "Moving Fox", "Adjusted", "root.jpg");
    expect(await originalOf(captures.root)).toEqual({
      ref: path.join(rootDir, rootRel),
      volume_id: ROOT_VOLUME,
      volume_relative_path: rootRel,
    });
    // A trip folder gets the year layer but never a location one, as trip imports file it.
    expect((await originalOf(captures.trip)).ref).toBe(
      path.join(tripDest, "Mammals", "Moving Fox", "Adjusted", "trip.jpg"),
    );
    for (const id of Object.values(captures)) {
      const { ref } = await originalOf(id);
      expect([ref, existsSync(ref)]).toEqual([ref, true]);
    }
  }, 60_000);
});
