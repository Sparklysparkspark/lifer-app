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
// The species page an import started from, when its RAW belongs to a photo filed as SPECIES.
const PAGE_SPECIES = "dddddddd-0000-4000-8000-00000000000c";
const TOKEN = "lifer_test_raw_upload_session_109";
const TAKEN = "2024:05:01 10:00:00";
let cookieName = "";

// "tiff" is a sensor-data TIFF (Color Filter Array), the kind that counts as a RAW.
async function shot(format: "jpeg" | "tiff", shade: number, taken = TAKEN): Promise<Buffer> {
  const img = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } });
  const exif = { IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: taken } };
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
      await db.query(`DELETE FROM albums WHERE user_id = $1`, [u]);
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
    const { captureRoutes } = await import("../captures/routes.js");
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'raw-uploads@test', 'x'), ($2, 'raw-other@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910802, 'Testus rawensis', 'Raw Test Warbler', 'aves'),
              ($2, 910803, 'Testus paginae', 'Page Test Kingfisher', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES, PAGE_SPECIES],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.register(captureRoutes, { prefix: "/api" });
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
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, PAGE_SPECIES]]);
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

  // The species page's import: a RAW is never turned away for its species. One with no photo of
  // its own becomes a photo of the page's species; one of a photo already filed as another species
  // joins that photo, and the review then corrects the photo when the user picked the page's.
  it("imports a RAW from a species page whatever photo it belongs to", async () => {
    const lone = await multipartBody({ speciesId: PAGE_SPECIES, mode: "store" }, [
      { field: "file", name: "6F9A8041.cr3", bytes: await shot("jpeg", 40, "2024:05:02 09:00:00"), type: "" },
    ]);
    const loneRes = await app.inject({ method: "POST", url: "/api/uploads", ...lone });
    expect(loneRes.statusCode, loneRes.body).toBe(201);
    expect(loneRes.json()).toMatchObject({ linkedExisting: false });
    const loneSpecies = await db.query(`SELECT species_id FROM captures WHERE id = $1`, [loneRes.json().captureId]);
    expect(loneSpecies.rows[0].species_id).toBe(PAGE_SPECIES);

    const jpg = await multipartBody({ speciesId: SPECIES }, [
      { field: "file", name: "6F9A8042.jpg", bytes: await shot("jpeg", 50, "2024:05:03 09:00:00"), type: "image/jpeg" },
    ]);
    const filed = await app.inject({ method: "POST", url: "/api/uploads", ...jpg });
    expect(filed.statusCode, filed.body).toBe(201);
    const captureId = filed.json().captureId as string;

    const raw = await multipartBody({ speciesId: PAGE_SPECIES, mode: "store" }, [
      { field: "file", name: "6F9A8042.cr3", bytes: await shot("jpeg", 51, "2024:05:03 09:00:00"), type: "" },
    ]);
    const linked = await app.inject({ method: "POST", url: "/api/uploads", ...raw });
    expect(linked.statusCode, linked.body).toBe(201);
    expect(linked.json()).toMatchObject({ captureId, linkedExisting: true });

    const fix = await app.inject({
      method: "PATCH",
      url: `/api/captures/${captureId}/reassign`,
      payload: { speciesId: PAGE_SPECIES },
      cookies: { [cookieName]: TOKEN },
    });
    expect(fix.statusCode, fix.body).toBe(200);
    const after = await db.query<{ species_id: string; kinds: string[] }>(
      `SELECT c.species_id, array_agg(o.kind ORDER BY o.kind) AS kinds
       FROM captures c JOIN originals o ON o.capture_id = c.id WHERE c.id = $1 GROUP BY c.species_id`,
      [captureId],
    );
    expect(after.rows[0]).toEqual({ species_id: PAGE_SPECIES, kinds: ["jpeg", "raw"] });
    expect(readdirSync(path.join(dataDir, "Birds", "Page Test Kingfisher", "RAW"))).toContain("6F9A8042.cr3");
  }, 60_000);

  // Undo of an import whose RAW joined an older photo takes off only that RAW: the photo, its
  // species, rating and album stay, and a species the import changed goes back.
  it("undoes a RAW that joined an older photo without touching the photo", async () => {
    const album = await db.query<{ id: string }>(
      `INSERT INTO albums (user_id, name) VALUES ($1, 'Undo test') RETURNING id`,
      [USER],
    );
    const albumId = album.rows[0].id;
    const jpg = await multipartBody({ speciesId: SPECIES, albumId }, [
      { field: "file", name: "6F9A9001.jpg", bytes: await shot("jpeg", 60, "2024:05:04 09:00:00"), type: "image/jpeg" },
    ]);
    const filed = await app.inject({ method: "POST", url: "/api/uploads", ...jpg });
    expect(filed.statusCode, filed.body).toBe(201);
    const captureId = filed.json().captureId as string;
    await db.query(`UPDATE captures SET quality_rating = 4 WHERE id = $1`, [captureId]);

    const raw = await multipartBody({ speciesId: PAGE_SPECIES, mode: "store" }, [
      { field: "file", name: "6F9A9001.cr3", bytes: await shot("jpeg", 61, "2024:05:04 09:00:00"), type: "" },
    ]);
    const linked = await app.inject({ method: "POST", url: "/api/uploads", ...raw });
    expect(linked.statusCode, linked.body).toBe(201);
    expect(linked.json()).toMatchObject({ captureId, linkedExisting: true });
    const originalId = linked.json().linkedOriginalId as string;
    const rawRef = (await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE id = $1`, [originalId])).rows[0]
      .ref;
    expect(existsSync(rawRef)).toBe(true);
    // The species page's review then files the photo under the page's species.
    const auth = { cookies: { [cookieName]: TOKEN } };
    const fix = await app.inject({
      method: "PATCH",
      url: `/api/captures/${captureId}/reassign`,
      payload: { speciesId: PAGE_SPECIES },
      ...auth,
    });
    expect(fix.statusCode, fix.body).toBe(200);

    // What the web's Undo sends: the old species back, then the RAW off.
    const back = await app.inject({
      method: "PATCH",
      url: `/api/captures/${captureId}/reassign`,
      payload: { speciesId: SPECIES },
      ...auth,
    });
    expect(back.statusCode, back.body).toBe(200);
    const undo = await app.inject({
      method: "POST",
      url: "/api/uploads/raw/undo-link",
      payload: { originalId },
      ...auth,
    });
    expect(undo.statusCode, undo.body).toBe(200);

    const after = await db.query<{ species_id: string; quality_rating: number; kinds: string[]; albums: number }>(
      `SELECT c.species_id, c.quality_rating,
              ARRAY(SELECT kind FROM originals WHERE capture_id = c.id) AS kinds,
              (SELECT count(*)::int FROM album_captures WHERE capture_id = c.id AND album_id = $2) AS albums
       FROM captures c WHERE c.id = $1`,
      [captureId, albumId],
    );
    expect(after.rows[0]).toEqual({ species_id: SPECIES, quality_rating: 4, kinds: ["jpeg"], albums: 1 });
    expect(existsSync(rawRef)).toBe(false);

    // A second undo, or one aimed at the photo's own file, changes nothing.
    const again = await app.inject({
      method: "POST",
      url: "/api/uploads/raw/undo-link",
      payload: { originalId },
      ...auth,
    });
    expect(again.statusCode).toBe(404);
    const jpegId = (await db.query<{ id: string }>(`SELECT id FROM originals WHERE capture_id = $1`, [captureId]))
      .rows[0].id;
    const ownFile = await app.inject({
      method: "POST",
      url: "/api/uploads/raw/undo-link",
      payload: { originalId: jpegId },
      ...auth,
    });
    expect(ownFile.statusCode).toBe(404);
    expect((await db.query(`SELECT 1 FROM originals WHERE id = $1`, [jpegId])).rowCount).toBe(1);
  }, 60_000);

  it("never takes the only file off a RAW-only photo, or another user's RAW", async () => {
    const lone = await multipartBody({ speciesId: SPECIES, mode: "store" }, [
      { field: "file", name: "6F9A9100.cr3", bytes: await shot("jpeg", 70, "2024:05:05 09:00:00"), type: "" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...lone });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ linkedExisting: false });
    const rawId = (
      await db.query<{ id: string }>(`SELECT id FROM originals WHERE capture_id = $1`, [res.json().captureId])
    ).rows[0].id;
    const undo = await app.inject({
      method: "POST",
      url: "/api/uploads/raw/undo-link",
      payload: { originalId: rawId },
      cookies: { [cookieName]: TOKEN },
    });
    expect(undo.statusCode).toBe(404);
    expect((await db.query(`SELECT 1 FROM originals WHERE id = $1`, [rawId])).rowCount).toBe(1);
  }, 60_000);

  // An import that created the photo: Undo sends the whole photo to the Trash, restorable.
  it("undoes a new photo by sending it to the Trash", async () => {
    const jpg = await multipartBody({ speciesId: SPECIES }, [
      { field: "file", name: "6F9A9200.jpg", bytes: await shot("jpeg", 80, "2024:05:06 09:00:00"), type: "image/jpeg" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...jpg });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().linkedExisting).toBeUndefined();
    const captureId = res.json().captureId as string;
    const del = await app.inject({
      method: "DELETE",
      url: `/api/captures/${captureId}`,
      cookies: { [cookieName]: TOKEN },
    });
    expect(del.statusCode, del.body).toBe(200);
    const trashed = await db.query(`SELECT 1 FROM captures_all WHERE id = $1 AND deleted_at IS NOT NULL`, [captureId]);
    expect(trashed.rowCount).toBe(1);
  }, 60_000);
});
