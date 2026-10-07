// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55473/lifer npx vitest run reimportCull
// Reimport handles photos a culling app rejected as the import asks (skip, import hidden, or
// ignore the mark; hidden when the request doesn't say), reading the mark from the photo and its
// RAW twin, and brings back the photo tags Lifer wrote into the file.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ExifTool } from "exiftool-vendored";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000771";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000772";
const COMMON = "Culled Curlew";
const TOKEN = "lifer_test_reimport_cull_token_771";

describe.skipIf(!url)("reimport and culling marks", () => {
  let db: pg.Pool;
  let dir: string;
  let folder: string;
  const writer = new ExifTool();

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [
      USER,
    ]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  async function photo(
    name: string,
    shade: number,
    extra: Record<string, unknown> = {},
    inFolder: string = folder,
  ): Promise<string> {
    const file = path.join(inFolder, name);
    await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: shade, g: 90, b: 40 } } })
      .jpeg()
      .toFile(file);
    await writer.write(file, { "XMP-dc:Subject": [COMMON], ...extra } as never, { writeArgs: ["-overwrite_original"] });
    return file;
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-reimport-cull-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'reimport-cull@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915771, 'Numenius cullensis', $2, 'aves')`,
      [SPECIES, COMMON],
    );
    folder = path.join(dir, "Birds", COMMON, "Adjusted");
    mkdirSync(folder, { recursive: true });
  });

  afterAll(async () => {
    await writer.end();
    await cleanup();
    await db.end();
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  const captureOf = async (file: string) =>
    (
      await db.query<{ hidden: boolean; cull_verdict: string | null; tags: string[] }>(
        `SELECT c.hidden_at IS NOT NULL AS hidden, c.cull_verdict, c.tags FROM captures_all c JOIN originals o ON o.capture_id = c.id WHERE o.ref = $1`,
        [file],
      )
    ).rows[0];

  it("skips, hides or imports a rejected photo as asked", async () => {
    const { recoverJpeg } = await import("./reimport.js");
    const skipped = await photo("skipped.jpg", 10, { "XMP-xmp:Rating": -1 });
    expect(await recoverJpeg(USER, skipped, null, false, false, false, { option: "skip" })).toEqual({
      status: "rejected",
    });
    expect(await captureOf(skipped)).toBeUndefined();

    const hidden = await photo("hidden.jpg", 20, { "XMP-xmp:Rating": -1 });
    expect((await recoverJpeg(USER, hidden, null, false, false, false, { option: "hide" })).status).toBe("recovered");
    expect(await captureOf(hidden)).toMatchObject({ hidden: true, cull_verdict: "reject" });

    const ignored = await photo("ignored.jpg", 30, { "XMP-xmp:Rating": -1 });
    expect((await recoverJpeg(USER, ignored, null, false, false, false, { option: "ignore" })).status).toBe(
      "recovered",
    );
    expect(await captureOf(ignored)).toMatchObject({ hidden: false, cull_verdict: "reject" });
  });

  it("counts a reject on the RAW twin for the photo", async () => {
    const { recoverJpeg } = await import("./reimport.js");
    const jpeg = await photo("IMG_0042.jpg", 40);
    const raw = path.join(dir, "Birds", COMMON, "RAW", "IMG_0042.CR2");
    mkdirSync(path.dirname(raw), { recursive: true });
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } })
      .jpeg()
      .toFile(raw);
    await writer.write(path.join(path.dirname(raw), "IMG_0042.xmp"), { "XMP-xmp:Rating": -1 } as never, {
      writeArgs: ["-overwrite_original"],
    });
    expect(await recoverJpeg(USER, jpeg, null, false, false, false, { option: "skip", raws: [raw] })).toEqual({
      status: "rejected",
    });
  });

  it("brings back the photo tags Lifer wrote into the file", async () => {
    const { recoverJpeg } = await import("./reimport.js");
    const tagged = await photo("tagged.jpg", 50, { "XMP-lr:HierarchicalSubject": ["Lifer Tags|flight shot"] });
    expect((await recoverJpeg(USER, tagged)).status).toBe("recovered");
    expect((await captureOf(tagged)).tags).toEqual(["flight shot"]);
  });

  it("hides a rejected photo when the reimport request leaves cullMarks out", async () => {
    // A folder of its own, so the job walks only this photo.
    const foreign = path.join(dir, "From another app");
    mkdirSync(foreign, { recursive: true });
    const rejected = await photo("default.jpg", 60, { "XMP-xmp:Rating": -1 }, foreign);

    const { hashToken } = await import("../auth/session.js");
    const { SESSION_COOKIE_NAME } = await import("@lifer/core/config.js");
    const { libraryRoutes } = await import("./routes.js");
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    const app = Fastify();
    try {
      await app.register(cookie);
      await app.register(libraryRoutes, { prefix: "/api" });
      await app.ready();
      const cookies = { [SESSION_COOKIE_NAME]: TOKEN };
      const start = await app.inject({
        method: "POST",
        url: "/api/library/reimport",
        payload: { path: foreign },
        cookies,
      });
      expect([start.statusCode, start.json()]).toEqual([200, { started: true }]);

      let status: Record<string, unknown> = {};
      for (let i = 0; i < 300; i++) {
        status = (await app.inject({ method: "GET", url: "/api/library/reimport/status", cookies })).json();
        if (!status.running) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(status).toMatchObject({ running: false, jpegsRecovered: 1, jpegsHidden: 1, jpegsRejected: 0 });
      // The job walks the folder's real path (on macOS the temp folder is under /private).
      expect(await captureOf(realpathSync(rejected))).toMatchObject({ hidden: true, cull_verdict: "reject" });
    } finally {
      await app.close();
    }
  }, 60_000);
});
