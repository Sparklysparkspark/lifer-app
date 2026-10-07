// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run uploads/cullUploads
// Culling marks on the upload path the Bulk import screen uses: /uploads/inspect reports them, and
// /uploads skips, hides or imports a rejected photo as `cullMarks` says (importing it when the
// field is left out, so scripts keep getting what they send).
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const USER = "dddddddd-0000-4000-8000-000000000741";
const SPECIES = "dddddddd-0000-4000-8000-000000000742";
const HIDDEN_SPECIES = "dddddddd-0000-4000-8000-000000000743";
const TOKEN = "lifer_test_cull_upload_token_741";

describe.skipIf(!url)("culling marks on upload", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  const writer = new ExifTool();

  /** A JPEG with xmp:Rating -1 (rejected) and a blue label, as Bridge or FastRawViewer writes. */
  async function rejectedJpeg(shade: number): Promise<Buffer> {
    const file = path.join(dataDir, `src-${shade}.jpg`);
    writeFileSync(
      file,
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 30, b: 200 } } })
        .jpeg()
        .toBuffer(),
    );
    await writer.write(file, { "XMP-xmp:Rating": -1, "XMP-xmp:Label": "Blue" } as never, {
      writeArgs: ["-overwrite_original"],
    });
    return readFileSync(file);
  }

  async function post(route: string, fields: Record<string, string>, name: string, bytes: Buffer) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), name);
    const res = new Response(form);
    return app.inject({
      method: "POST",
      url: route,
      headers: { "x-api-key": TOKEN, "content-type": res.headers.get("content-type")! },
      payload: Buffer.from(await res.arrayBuffer()),
    });
  }

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [
      USER,
    ]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[SPECIES, HIDDEN_SPECIES]]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-cull-uploads-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { uploadRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'cull-uploads@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910741, 'Testus importatus', 'Upload Bird', 'aves'), ($2, 910742, 'Testus celatus', 'Hidden Bird', 'aves')`,
      [SPECIES, HIDDEN_SPECIES],
    );
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.write"],
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await writer.end();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("reports the marks when a photo is checked", async () => {
    const res = await post("/api/uploads/inspect", {}, "IMG_0100.jpg", await rejectedJpeg(10));
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().cull).toStrictEqual({ verdict: "reject", label: "blue" });
  }, 60_000);

  it("skips a rejected photo with cullMarks=skip, saving nothing", async () => {
    const res = await post(
      "/api/uploads",
      { speciesId: SPECIES, cullMarks: "skip" },
      "IMG_0101.jpg",
      await rejectedJpeg(40),
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toStrictEqual({ skipped: "rejected" });
    const n = await db.query(`SELECT count(*)::int AS n FROM captures_all WHERE user_id = $1`, [USER]);
    expect(n.rows[0].n).toBe(0);
    expect(existsSync(path.join(dataDir, "Birds"))).toBe(false);
  }, 60_000);

  it("imports a rejected photo when cullMarks is left out, and Lifer's copy keeps its reject", async () => {
    const res = await post("/api/uploads", { speciesId: SPECIES }, "IMG_0102.jpg", await rejectedJpeg(70));
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().hidden).toBe(false);
    const row = await db.query(
      `SELECT c.cull_verdict, c.cull_label, c.quality_rating, o.ref FROM captures c JOIN originals o ON o.capture_id = c.id WHERE c.id = $1`,
      [res.json().captureId],
    );
    expect(row.rows[0]).toMatchObject({ cull_verdict: "reject", cull_label: "blue", quality_rating: null });

    // Lifer writes its species tags into its copy after the import; the -1 must survive that.
    const copy = row.rows[0].ref as string;
    let tags: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      tags = (await writer.read(copy)) as unknown as Record<string, unknown>;
      if (tags.Subject) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(tags.Subject).toBeTruthy();
    expect(tags.Rating).toBe(-1);
    expect(tags.Label).toBe("Blue");
  }, 60_000);

  it("imports a rejected photo hidden with cullMarks=hide, off the life list", async () => {
    const res = await post(
      "/api/uploads",
      { speciesId: HIDDEN_SPECIES, cullMarks: "hide" },
      "IMG_0103.jpg",
      await rejectedJpeg(100),
    );
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().hidden).toBe(true);
    const id = res.json().captureId;
    expect((await db.query(`SELECT 1 FROM captures WHERE id = $1`, [id])).rowCount).toBe(0);
    expect(
      (await db.query(`SELECT hidden_at IS NOT NULL AS hidden FROM captures_all WHERE id = $1`, [id])).rows[0].hidden,
    ).toBe(true);
    const species = await db.query(`SELECT state FROM user_species WHERE user_id = $1 AND species_id = $2`, [
      USER,
      HIDDEN_SPECIES,
    ]);
    expect(species.rowCount).toBe(0);
  }, 60_000);

  it("refuses an unknown option", async () => {
    const res = await post(
      "/api/uploads",
      { speciesId: SPECIES, cullMarks: "delete" },
      "IMG_0104.jpg",
      await rejectedJpeg(130),
    );
    expect(res.statusCode).toBe(400);
  }, 60_000);
});
