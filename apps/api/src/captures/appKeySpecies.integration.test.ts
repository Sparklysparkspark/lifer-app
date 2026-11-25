// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A connected app's imports.write key, through the desktop gate: a folder import reports each
// file's photo, and the key may add (never remove) species on the photos it imported, and no others.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { ExifTool, type WriteTags } from "exiftool-vendored";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PLUGIN = "com.example.app-key-species";
const HOST = { host: "127.0.0.1:4310", "x-lifer-client": "1" };
const PRIMARY = "dddddddd-0000-4000-8000-0000000002a1";
const EXTRA = "dddddddd-0000-4000-8000-0000000002a2";
const COMMON = "App Key Test Heron";
const OTHER_USER = "dddddddd-0000-4000-8000-0000000002a9";

type Job = { running: boolean; imported?: number; files?: { path: string; captureId: string }[] };

describe.skipIf(!url)("app keys adding species to photos they imported", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let outside: string;
  let folder: string;
  let userId: string;
  let writeKey: string;
  let readKey: string;
  let otherAppKey: string;
  let captureId: string;

  const headers = (key: string) => ({ ...HOST, "x-api-key": key });
  const addSpecies = (id: string, speciesId: string, key = writeKey) =>
    app.inject({ method: "POST", url: `/api/captures/${id}/species`, headers: headers(key), payload: { speciesId } });

  async function importFolder(): Promise<Job> {
    const res = await app.inject({
      method: "POST",
      url: "/api/imports/v1/folders",
      headers: headers(writeKey),
      payload: { path: folder, mode: "copy" },
    });
    expect(res.statusCode, res.body).toBe(202);
    const { id } = res.json() as { id: string };
    let job = (
      await app.inject({ method: "GET", url: `/api/imports/v1/jobs/${id}`, headers: headers(writeKey) })
    ).json() as Job;
    for (let i = 0; i < 300 && job.running; i++) {
      await new Promise((r) => setTimeout(r, 50));
      job = (await app.inject({ method: "GET", url: `/api/imports/v1/jobs/${id}`, headers: headers(writeKey) })).json();
    }
    return job;
  }

  async function bareCapture(owner: string): Promise<string> {
    const res = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, md5(random()::text)) RETURNING id`,
      [owner, PRIMARY],
    );
    return res.rows[0].id;
  }

  // Every row this test makes hangs off its own species, user and plugin ids.
  async function cleanup() {
    const species = [PRIMARY, EXTRA];
    await db.query(`DELETE FROM user_species WHERE species_id = ANY($1::uuid[])`, [species]);
    const caps = `SELECT id FROM captures_all WHERE species_id = ANY($1::uuid[])`;
    await db.query(`DELETE FROM originals WHERE capture_id IN (${caps})`, [species]);
    await db.query(`DELETE FROM captures_all WHERE species_id = ANY($1::uuid[])`, [species]);
    await db.query(`DELETE FROM api_keys WHERE plugin_id LIKE $1`, [`${PLUGIN}%`]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OTHER_USER]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-app-key-species-"));
    outside = mkdtempSync(path.join(tmpdir(), "lifer-app-key-outside-"));
    folder = path.join(outside, "Keepers");
    mkdirSync(folder);
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = "app-key-species-test-launch-token";
    db = new pg.Pool({ connectionString: url });
    for (const [id, gbif, name, common] of [
      [PRIMARY, 910861, "Testus appkeyus", COMMON],
      [EXTRA, 910862, "Testus extrus", "App Key Test Fish"],
    ])
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
         VALUES ($1, $2, $3, $4, 'aves') ON CONFLICT (id) DO NOTHING`,
        [id, gbif, name, common],
      );
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'app-key-other@test', 'x')`, [OTHER_USER]);

    const photo = path.join(folder, "IMG_0001.jpg");
    await sharp({ create: { width: 96, height: 64, channels: 3, background: { r: 30, g: 140, b: 90 } } })
      .jpeg()
      .toFile(photo);
    const exiftool = new ExifTool();
    await exiftool.write(photo, { "XMP-dc:Subject": [COMMON] } as WriteTags, { writeArgs: ["-overwrite_original"] });
    await exiftool.end();

    const { getOrCreateLocalUser } = await import("../auth/session.js");
    userId = (await getOrCreateLocalUser()).id;
    const { issuePluginKey } = await import("../plugins/pairing.js");
    writeKey = await issuePluginKey(userId, PLUGIN, "Culler", ["imports.write"]);
    readKey = await issuePluginKey(userId, `${PLUGIN}.read`, "Reader", ["userdata.read"]);
    otherAppKey = await issuePluginKey(userId, `${PLUGIN}.other`, "Other importer", ["imports.write"]);
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    app.addHook("onRequest", desktopRequestGate(4310));
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) await cleanup();
    await db?.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[PRIMARY, EXTRA]]);
    await db?.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("lists each filed file with its photo once the import ends, and records the key", async () => {
    const job = await importFolder();
    expect(job).toMatchObject({ running: false, imported: 1 });
    expect(job.files).toHaveLength(1);
    expect(job.files![0].path).toBe(path.join(folder, "IMG_0001.jpg"));
    captureId = job.files![0].captureId;
    const row = await db.query(
      `SELECT c.species_id, k.plugin_id FROM captures_all c JOIN api_keys k ON k.id = c.imported_by_key_id WHERE c.id = $1`,
      [captureId],
    );
    expect(row.rows[0]).toEqual({ species_id: PRIMARY, plugin_id: PLUGIN });
  });

  it("adds a species to a photo the key imported, safely repeated, never touching the primary", async () => {
    expect((await addSpecies(captureId, EXTRA)).statusCode).toBe(201);
    expect((await addSpecies(captureId, EXTRA)).statusCode).toBe(201);
    expect((await addSpecies(captureId, PRIMARY)).statusCode).toBe(400);
    const tags = await db.query(`SELECT species_id FROM capture_species WHERE capture_id = $1`, [captureId]);
    expect(tags.rows).toEqual([{ species_id: EXTRA }]);
    const primary = await db.query(`SELECT species_id FROM captures_all WHERE id = $1`, [captureId]);
    expect(primary.rows[0].species_id).toBe(PRIMARY);
  });

  it("can't remove a species or reach any other photo edit", async () => {
    const del = await app.inject({
      method: "DELETE",
      url: `/api/captures/${captureId}/species/${EXTRA}`,
      headers: headers(writeKey),
    });
    expect(del.statusCode).toBe(401);
    const reassign = await app.inject({
      method: "PATCH",
      url: `/api/captures/${captureId}/reassign`,
      headers: headers(writeKey),
      payload: { speciesId: EXTRA },
    });
    expect(reassign.statusCode).toBe(401);
    const tags = await db.query(`SELECT count(*)::int AS n FROM capture_species WHERE capture_id = $1`, [captureId]);
    expect(tags.rows[0].n).toBe(1);
  });

  it("refuses photos the key didn't import, and another user's photo", async () => {
    const notMine = await addSpecies(await bareCapture(userId), EXTRA);
    expect(notMine.statusCode).toBe(403);
    expect(notMine.json()).toMatchObject({ code: "not_imported_by_key" });
    // Another app's key, even with imports.write, can't tag this app's import.
    expect((await addSpecies(captureId, EXTRA, otherAppKey)).statusCode).toBe(403);
    expect((await addSpecies(await bareCapture(OTHER_USER), EXTRA)).statusCode).toBe(404);
  });

  it("tells a key without the scope apart from an unknown key", async () => {
    const missing = await addSpecies(captureId, EXTRA, readKey);
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: "missing_scope", scopes: ["photos.write", "imports.write"] });
    expect((await addSpecies(captureId, EXTRA, "lifer_not_a_real_key")).statusCode).toBe(401);
  });

  it("lists a file Lifer already had with its photo", async () => {
    const job = await importFolder();
    expect(job.files).toEqual([{ path: path.join(folder, "IMG_0001.jpg"), captureId }]);
  });
});
