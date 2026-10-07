// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run uploads
// POST /uploads/raw: a RAW matched to an imported JPEG lands in that capture's species folder,
// and a failing batch (unknown drive, oversized file) answers cleanly with no temp files left.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTiffPhotometric } from "@lifer/core/uploads/testImages.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000109";
const OTHER_USER = "dddddddd-0000-4000-8000-000000000110";
const SPECIES = "dddddddd-0000-4000-8000-00000000000b";
const TOKEN = "lifer_test_raw_upload_session_109";
const TAKEN = "2024:05:01 10:00:00";
let cookieName = "";

// "tiff" is a sensor-data TIFF (Color Filter Array), the kind that counts as a RAW.
async function shot(format: "jpeg" | "tiff", shade: number): Promise<Buffer> {
  const img = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } });
  const exif = { IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: TAKEN } };
  return format === "jpeg"
    ? img.jpeg().withExif(exif).toBuffer()
    : setTiffPhotometric(await img.tiff().withExif(exif).toBuffer(), 32803);
}

async function multipartBody(
  fields: Record<string, string>,
  files: { field: string; name: string; bytes: Buffer; type: string }[],
) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append(f.field, new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name);
  const res = new Response(form);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
    cookies: { [cookieName]: TOKEN },
  };
}

describe.skipIf(!url)("RAW uploads", () => {
  let app: FastifyInstance;
  let tinyApp: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;

  async function cleanup() {
    for (const u of [USER, OTHER_USER]) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM originals WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-raw-uploads-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { uploadRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'raw-uploads@test', 'x'), ($2, 'raw-other@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910802, 'Testus rawensis', 'Raw Test Warbler', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
    tinyApp = Fastify();
    await tinyApp.register(cookie);
    await tinyApp.register(multipart, { limits: { fileSize: 512 } });
    await tinyApp.register(uploadRoutes, { prefix: "/api" });
    await tinyApp.ready();
  });

  afterAll(async () => {
    await app?.close();
    await tinyApp?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const tmpFiles = () => {
    const dir = path.join(dataDir, "app-data", "uploads", "tmp");
    return existsSync(dir) ? readdirSync(dir) : [];
  };

  it("files a matched RAW in its capture's species folder", async () => {
    const jpg = await multipartBody({ speciesId: SPECIES, regionId: "" }, [
      { field: "file", name: "IMG_0300.jpg", bytes: await shot("jpeg", 30), type: "image/jpeg" },
    ]);
    const imported = await app.inject({ method: "POST", url: "/api/uploads", ...jpg });
    expect(imported.statusCode, imported.body).toBe(201);
    const captureId = imported.json().captureId as string;

    const raw = await multipartBody({}, [
      { field: "files", name: ".DS_Store", bytes: Buffer.from("junk"), type: "application/octet-stream" },
      // exiftool reads by content, so a JPEG body stands in for camera RAW bytes here.
      { field: "files", name: "IMG_0300.dng", bytes: await shot("jpeg", 31), type: "image/x-adobe-dng" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads/raw", ...raw });
    expect(res.statusCode, res.body).toBe(201);
    const [result] = res.json().results;
    expect(result).toMatchObject({ linked: true, captureId, speciesScientificName: "Testus rawensis" });

    const rawFolder = path.join(dataDir, "Birds", "Raw Test Warbler", "RAW");
    expect(readdirSync(rawFolder)).toEqual(["IMG_0300.dng"]);
    expect(tmpFiles()).toEqual([]);
  }, 60_000);

  it("never files into another user's unlinked RAWs by content hash", async () => {
    const bytes = await shot("tiff", 200);
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(bytes).digest("hex");
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size, user_id, species_id)
       VALUES (NULL, 'raw', 'path', '/elsewhere/IMG_0400.tif', true, $1, 1, $2, $3)`,
      [hash, OTHER_USER, SPECIES],
    );
    const body = await multipartBody({ speciesId: SPECIES, allowUnmatchedFallback: "1" }, [
      { field: "files", name: "IMG_0400.tif", bytes, type: "image/tiff" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads/raw", ...body });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().results[0]).toMatchObject({ filed: true });
  }, 60_000);

  it("rejects an unknown drive before processing anything", async () => {
    const body = await multipartBody({ volumeId: "dddddddd-0000-4000-8000-0000000000ff" }, [
      { field: "files", name: "IMG_0500.tif", bytes: await shot("tiff", 90), type: "image/tiff" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads/raw", ...body });
    expect(res.statusCode).toBe(400);
    expect(tmpFiles()).toEqual([]);
  });

  it("answers 413 for an oversized file and leaves no temp files behind", async () => {
    const body = await multipartBody({}, [
      { field: "files", name: "IMG_0600.tif", bytes: await shot("tiff", 120), type: "image/tiff" },
    ]);
    const res = await tinyApp.inject({ method: "POST", url: "/api/uploads/raw", ...body });
    expect(res.statusCode).toBe(413);
    expect(tmpFiles()).toEqual([]);
  });

  it("rejects a malformed regionId", async () => {
    const body = await multipartBody({ speciesId: SPECIES, regionId: "not-a-region" }, [
      { field: "file", name: "IMG_0700.jpg", bytes: await shot("jpeg", 70), type: "image/jpeg" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode).toBe(400);
  });
});
