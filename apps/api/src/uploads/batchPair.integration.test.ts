// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run batchPair
// A RAW and its JPG imported from one batch end up as one photo, whichever is sent first: sent
// together (as the import screen does), the JPG first, or the RAW first.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000002301";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000230a";
const TOKEN = "lifer_test_batch_pair_2301";

type Tags = Record<string, string>;
const pressAt = (time: string): Tags => ({
  DateTimeOriginal: `2026:11:20 ${time}`,
  SubSecTimeOriginal: "45",
  SerialNumber: "098765",
  Model: "Canon EOS R5",
});
// An export that dropped the sub-second and the body serial.
const looseAt = (time: string): Tags => ({ DateTimeOriginal: `2026:11:20 ${time}`, Model: "Canon EOS R5" });

describe.skipIf(!url)("a RAW and its JPG from one import", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let cookieName: string;
  let exiftool: ExifTool;

  // A JPEG, or one standing in for a CR3 (only its metadata and embedded preview are read).
  async function writeFile(name: string, tags: Tags, raw = false): Promise<string> {
    const file = path.join(dir, "files", name);
    mkdirSync(path.dirname(file), { recursive: true });
    const jpeg = `${file}.tmp.jpg`;
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 90, b: 40 } } })
      .jpeg()
      .toFile(jpeg);
    const args = ["-overwrite_original"];
    if (raw) {
      const preview = `${file}.preview.jpg`;
      await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 10, g: 90, b: 40 } } })
        .jpeg()
        .toFile(preview);
      args.push(`-ThumbnailImage<=${preview}`);
    }
    await exiftool.write(jpeg, tags as never, { writeArgs: args });
    renameSync(jpeg, file);
    return file;
  }

  async function upload(files: Array<{ field: string; name: string; path: string }>) {
    const form = new FormData();
    form.append("speciesId", SPECIES);
    form.append("mode", "store");
    for (const f of files)
      form.append(f.field, new Blob([new Uint8Array(readFileSync(f.path))], { type: "image/jpeg" }), f.name);
    const res = new Response(form);
    const reply = await app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: Buffer.from(await res.arrayBuffer()),
      headers: { "content-type": res.headers.get("content-type")! },
      cookies: { [cookieName]: TOKEN },
    });
    expect(reply.statusCode).toBe(201);
    return reply.json<{ captureId: string; photoId: string | null; linkedExisting?: boolean }>();
  }

  // What the library shows: visible captures, each with the kinds of file it holds and its photo.
  async function library() {
    const res = await db.query<{ id: string; kinds: string[]; current_photo_id: string | null; species_id: string }>(
      `SELECT c.id, c.current_photo_id, c.species_id,
              array(SELECT o.kind FROM originals o
                    WHERE o.capture_id = c.id OR o.capture_id IN
                      (SELECT capture_id FROM capture_versions WHERE group_capture_id = c.id AND state = 'linked')
                    ORDER BY o.kind) AS kinds
       FROM captures c WHERE c.user_id = $1`,
      [USER],
    );
    return res.rows;
  }

  async function clearLibrary() {
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM capture_versions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM photos WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
  }

  async function cleanup() {
    await clearLibrary();
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-batch-pair-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    exiftool = new ExifTool();
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { uploadRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'batch-pair@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 923301, 'Pavo testus', 'Test Peafowl', 'aves')`,
      [SPECIES],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    await exiftool.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sent together, as the import screen does: one capture with both files, the JPG shown", async () => {
    await clearLibrary();
    const raw = await writeFile("together/6F9A8074.CR3", looseAt("07:12:33"), true);
    const jpg = await writeFile("together/6F9A8074.jpg", looseAt("07:12:33"));
    const res = await upload([
      { field: "file", name: "6F9A8074.jpg", path: jpg },
      { field: "rawFile", name: "6F9A8074.CR3", path: raw },
    ]);
    expect(await library()).toEqual([
      { id: res.captureId, kinds: ["jpeg", "raw"], current_photo_id: res.photoId, species_id: SPECIES },
    ]);
  });

  it.each([
    ["the same press", pressAt("08:00:01")],
    ["an export without sub-second or serial", looseAt("08:00:02")],
  ])("JPG first, then the RAW (%s): the RAW joins the JPG's capture", async (_label, jpgTags) => {
    await clearLibrary();
    const time = jpgTags.DateTimeOriginal.slice(-8);
    const jpg = await upload([
      { field: "file", name: "IMG_0001.jpg", path: await writeFile(`jf/${time}/IMG_0001.jpg`, jpgTags) },
    ]);
    const raw = await upload([
      { field: "file", name: "IMG_0001.CR3", path: await writeFile(`jf/${time}/IMG_0001.CR3`, pressAt(time), true) },
    ]);
    expect(raw).toMatchObject({ captureId: jpg.captureId, linkedExisting: true });
    expect(await library()).toEqual([
      { id: jpg.captureId, kinds: ["jpeg", "raw"], current_photo_id: jpg.photoId, species_id: SPECIES },
    ]);
  });

  it("RAW first, then the JPG of the same press: one photo, the JPG shown", async () => {
    await clearLibrary();
    const raw = await upload([
      { field: "file", name: "IMG_0002.CR3", path: await writeFile("rf/IMG_0002.CR3", pressAt("09:00:00"), true) },
    ]);
    const jpg = await upload([
      { field: "file", name: "IMG_0002.jpg", path: await writeFile("rf/IMG_0002.jpg", pressAt("09:00:00")) },
    ]);
    expect(jpg.captureId).not.toBe(raw.captureId);
    // The JPG's photo is swapped onto the RAW's capture, which is the one the library shows.
    expect(await library()).toEqual([
      { id: raw.captureId, kinds: ["jpeg", "raw"], current_photo_id: jpg.photoId, species_id: SPECIES },
    ]);
  });
});
