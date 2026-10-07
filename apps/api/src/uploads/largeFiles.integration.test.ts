// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run largeFiles
// Resumable (tus) uploads: chunked and resumed uploads imported by uploadId, owner isolation,
// a file over 2 GB with flat memory, a huge panorama, edited and sensor-data TIFFs, WebP and HEIC.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import compress from "@fastify/compress";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import { ExifTool, type WriteTags } from "exiftool-vendored";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTiffPhotometric, tusPatch, tusUpload } from "@lifer/core/uploads/testImages.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000120";
const OTHER_USER = "dddddddd-0000-4000-8000-000000000121";
const SPECIES = "dddddddd-0000-4000-8000-00000000000c";
const KEY = "lifer_test_large_files_key_120";
const OTHER_KEY = "lifer_test_large_files_key_121";
const SESSION = "lifer_test_large_files_session_120";
const OTHER_SESSION = "lifer_test_large_files_session_121";
const TAKEN = "2024:05:01 10:00:00";
const API = { "x-api-key": KEY };

const hasHeicEncoder = process.platform === "darwin" ? existsSync("/usr/bin/sips") : existsSync("/usr/bin/heif-enc") || existsSync("/opt/homebrew/bin/heif-enc");

async function jpeg(shade: number, size = { width: 64, height: 48 }): Promise<Buffer> {
  return sharp({ create: { ...size, channels: 3, background: { r: shade, g: 90, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: TAKEN } })
    .toBuffer();
}

async function form(fields: Record<string, string>, files: { field: string; name: string; bytes: Buffer; type: string }[] = []) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const file of files) f.append(file.field, new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const res = new Response(f);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { ...API, "content-type": res.headers.get("content-type")! } };
}

describe.skipIf(!url)("large files and new formats", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let scratch: string;
  let exiftool: ExifTool;
  let cookieName = "";
  const tusDir = () => path.join(dataDir, "app-data", "uploads", "tus");

  async function cleanup() {
    for (const u of [USER, OTHER_USER]) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-large-files-"));
    scratch = mkdtempSync(path.join(tmpdir(), "lifer-large-files-src-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    delete process.env.MAX_UPLOAD_BYTES;
    db = new pg.Pool({ connectionString: url });
    exiftool = new ExifTool();
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { uploadRoutes } = await import("./routes.js");
    const { isBlockedCrossSiteWrite } = await import("@lifer/core/lib/requestGuard.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'large@test', 'x'), ($2, 'large-other@test', 'x')`, [USER, OTHER_USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910803, 'Testus giganticus', 'Large Test Tern', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 't', $2, $3), ($4, 't', $5, $3)`, [
      USER,
      hashApiKey(KEY),
      ["photos.write"],
      OTHER_USER,
      hashApiKey(OTHER_KEY),
    ]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`, [
      hashToken(SESSION),
      USER,
      hashToken(OTHER_SESSION),
      OTHER_USER,
    ]);

    // Wired like index.ts: the cross-site guard, helmet and compression in front of the routes.
    app = Fastify({ bodyLimit: 1024 * 1024 });
    app.addHook("onRequest", async (request, reply) => {
      if (isBlockedCrossSiteWrite(request.method, request.headers, [request.headers.host, request.host])) {
        return reply.code(403).send({ error: "Cross-site request blocked" });
      }
    });
    await app.register(cookie);
    await app.register(helmet, { contentSecurityPolicy: false });
    await app.register(compress, { threshold: 1 });
    await app.register(multipart, { limits: { fileSize: Infinity } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    await exiftool.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  it("uploads in chunks, inspects and imports by uploadId without resending", async () => {
    const bytes = await jpeg(20, { width: 900, height: 600 });
    const { id, offset } = await tusUpload(app, bytes, { headers: API, filename: "IMG_1000.jpg", filetype: "image/jpeg", chunkSize: 8 * 1024 });
    expect(offset).toBe(bytes.length);
    expect(id.startsWith(`${USER}_`)).toBe(true);

    const check = await form({ uploadId: id });
    const inspect = await app.inject({ method: "POST", url: "/api/uploads/inspect", ...check });
    expect(inspect.statusCode, inspect.body).toBe(200);
    expect(inspect.json()).toMatchObject({ uploadId: id, stagedId: null, previewDataUrl: null });
    expect(inspect.json().takenAt).toBeTruthy();

    const body = await form({ speciesId: SPECIES, uploadId: id });
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(res.statusCode, res.body).toBe(201);
    const stored = await db.query<{ ref: string; content_hash: string; file_size: string }>(
      `SELECT ref, content_hash, file_size FROM originals WHERE capture_id = $1 AND kind = 'jpeg'`,
      [res.json().captureId],
    );
    expect(path.basename(stored.rows[0].ref)).toBe("IMG_1000.jpg");
    expect(stored.rows[0].content_hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(Number(stored.rows[0].file_size)).toBe(bytes.length);
    // Used up: its bytes became the library file, so a second import by the same id gets 410.
    expect(readdirSync(path.join(tusDir(), "files")).filter((f) => f.startsWith(id))).toEqual([]);
    const again = await app.inject({ method: "POST", url: "/api/uploads", ...body });
    expect(again.statusCode).toBe(410);
  }, 60_000);

  it("resumes after an interrupted PATCH from the offset HEAD reports", async () => {
    // Noise, so the file is big enough for several chunks.
    const bytes = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#000", noise: { type: "gaussian", mean: 128, sigma: 50 } } })
      .jpeg({ quality: 95 })
      .withExif({ IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: TAKEN } })
      .toBuffer();
    expect(bytes.length).toBeGreaterThan(20_000);
    const opts = { headers: API, filename: "IMG_1001.jpg", filetype: "image/jpeg", chunkSize: 4096 };
    const { url: uploadUrl, offset: partial } = await tusUpload(app, bytes, { ...opts, stopAt: 8192 });
    expect(partial).toBe(8192);

    // A real connection dropped mid-chunk: whatever arrived is kept.
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "PATCH",
        path: uploadUrl,
        headers: { ...API, "tus-resumable": "1.0.0", "upload-offset": "8192", "content-type": "application/offset+octet-stream", "content-length": String(bytes.length - 8192) },
      });
      req.on("error", () => resolve());
      req.on("response", () => resolve());
      req.write(bytes.subarray(8192, 8192 + 5000));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 300);
    });
    await new Promise((r) => setTimeout(r, 300));

    const head = await app.inject({ method: "HEAD", url: uploadUrl, headers: { ...API, "tus-resumable": "1.0.0" } });
    expect(head.statusCode).toBe(200);
    const resumeAt = Number(head.headers["upload-offset"]);
    expect(resumeAt).toBeGreaterThanOrEqual(8192);
    expect(resumeAt).toBeLessThanOrEqual(8192 + 5000);
    expect(head.headers["upload-length"]).toBe(String(bytes.length));

    expect(await tusPatch(app, uploadUrl, bytes, resumeAt, opts)).toBe(bytes.length);
    const id = uploadUrl.split("/").pop()!;
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...(await form({ speciesId: SPECIES, uploadId: id })) });
    expect(res.statusCode, res.body).toBe(201);
    const stored = await db.query<{ content_hash: string }>(`SELECT content_hash FROM originals WHERE capture_id = $1`, [res.json().captureId]);
    expect(stored.rows[0].content_hash).toBe(createHash("sha256").update(bytes).digest("hex"));
  }, 60_000);

  it("keeps each user's uploads to themselves", async () => {
    const bytes = await jpeg(60);
    const { id, url: uploadUrl } = await tusUpload(app, bytes, { headers: API, filename: "IMG_1002.jpg", filetype: "image/jpeg" });
    const other = { "x-api-key": OTHER_KEY, "tus-resumable": "1.0.0" };
    expect((await app.inject({ method: "HEAD", url: uploadUrl, headers: other })).statusCode).toBe(404);
    expect((await app.inject({ method: "DELETE", url: uploadUrl, headers: other })).statusCode).toBe(404);
    const theirs = async (fields: Record<string, string>, route: string) => {
      const body = await form(fields);
      return app.inject({ method: "POST", url: route, payload: body.payload, headers: { ...body.headers, "x-api-key": OTHER_KEY } });
    };
    expect((await theirs({ uploadId: id }, "/api/uploads/inspect")).statusCode).toBe(410);
    expect((await theirs({ speciesId: SPECIES, uploadId: id }, "/api/uploads")).statusCode).toBe(410);
    // /uploads/raw takes a browser session, not a key.
    const rawBody = await form({ uploadIds: id });
    const raw = await app.inject({
      method: "POST",
      url: "/api/uploads/raw",
      payload: rawBody.payload,
      headers: { "content-type": rawBody.headers["content-type"], "x-lifer-client": "1" },
      cookies: { [cookieName]: OTHER_SESSION },
    });
    expect(raw.json().results[0]).toMatchObject({ uploadId: id, linked: false });
    expect(raw.json().results[0].error).toBeTruthy();
    // Still there for its owner.
    expect((await app.inject({ method: "HEAD", url: uploadUrl, headers: { ...API, "tus-resumable": "1.0.0" } })).statusCode).toBe(200);
  }, 60_000);

  it("authenticates tus requests like every other upload", async () => {
    const create = { "tus-resumable": "1.0.0", "upload-length": "10" };
    // No credentials: the cross-site guard answers first, then authentication.
    expect((await app.inject({ method: "POST", url: "/api/uploads/tus", headers: create })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/uploads/tus", headers: { ...create, "x-lifer-client": "1" } })).statusCode).toBe(401);
    // A cookie alone is refused by the cross-site guard; with x-lifer-client it's a normal upload.
    const cookies = { [cookieName]: SESSION };
    expect((await app.inject({ method: "POST", url: "/api/uploads/tus", headers: create, cookies })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/uploads/tus", headers: { ...create, "x-lifer-client": "1" }, cookies });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.headers["access-control-allow-origin"]).toBeUndefined();
    const del = await app.inject({ method: "DELETE", url: String(ok.headers.location), headers: { "tus-resumable": "1.0.0", "x-lifer-client": "1" }, cookies });
    expect(del.statusCode).toBe(204);
    // An upload's owner comes from its credentials, whatever the request claims.
    const forged = await app.inject({ method: "POST", url: "/api/uploads/tus", headers: { ...create, ...API, "x-lifer-tus-user": OTHER_USER } });
    expect(String(forged.headers.location).split("/").pop()!.startsWith(`${USER}_`)).toBe(true);
  });

  it("takes a file over the old 2 GB cap in one PATCH with flat memory", async () => {
    const size = 2 * 1024 * 1024 * 1024 + 64 * 1024 * 1024;
    const created = await app.inject({
      method: "POST",
      url: "/api/uploads/tus",
      headers: { ...API, "tus-resumable": "1.0.0", "upload-length": String(size), "upload-metadata": `filename ${Buffer.from("big.bin").toString("base64")}` },
    });
    expect(created.statusCode, created.body).toBe(201);
    if (!app.server.listening) await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;

    const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
    const expected = createHash("sha256");
    const baseline = process.memoryUsage().rss;
    let peak = baseline;
    const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 50);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "PATCH",
          path: String(created.headers.location),
          headers: { ...API, "tus-resumable": "1.0.0", "upload-offset": "0", "content-type": "application/offset+octet-stream", "content-length": String(size) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      let sent = 0;
      const pump = () => {
        while (sent < size) {
          const piece = sent + chunk.length <= size ? chunk : chunk.subarray(0, size - sent);
          expected.update(piece);
          sent += piece.length;
          if (!req.write(piece)) return void req.once("drain", pump);
        }
        req.end();
      };
      pump();
    });
    clearInterval(sampler);
    expect(status).toBe(204);
    const id = String(created.headers.location).split("/").pop()!;
    const { finishedTusUpload, removeTusUpload } = await import("../lib/tusUploads.js");
    const finished = await finishedTusUpload(USER, id);
    expect(finished?.size).toBe(size);
    expect(finished?.sha256).toBe(expected.digest("hex"));
    // Streamed to disk and hashed on the way: memory stays near where it started.
    expect(peak - baseline).toBeLessThan(400 * 1024 * 1024);
    await removeTusUpload(id);
  }, 300_000);

  it("imports a panorama over sharp's default 268 MP limit", async () => {
    const width = 24000;
    const height = 12000;
    const bytes = await sharp({ create: { width: 64, height: 32, channels: 3, background: { r: 30, g: 120, b: 200 } } })
      .resize(width, height, { kernel: "nearest" })
      .jpeg({ quality: 80 })
      .toBuffer();
    const { id } = await tusUpload(app, bytes, { headers: API, filename: "PANO_0001.jpg", filetype: "image/jpeg", chunkSize: 4 * 1024 * 1024 });
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...(await form({ speciesId: SPECIES, uploadId: id })) });
    expect(res.statusCode, res.body).toBe(201);
    const photo = await db.query<{ width: number; height: number; display_path: string }>(`SELECT width, height, display_path FROM photos WHERE id = $1`, [res.json().photoId]);
    expect(photo.rows[0]).toMatchObject({ width: 2560, height: 1280 });
    expect(existsSync(photo.rows[0].display_path)).toBe(true);
  }, 120_000);

  it("imports an edited TIFF as a photo paired with its RAW, and a sensor-data TIFF as a RAW", async () => {
    const exif = { IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: "2024:05:02 11:00:00" } };
    const edited = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#228833" } }).tiff().withExif(exif).toBuffer();
    const raw = await sharp({ create: { width: 80, height: 60, channels: 3, background: "#228833" } }).jpeg().withExif(exif).toBuffer();
    const pair = await form({ speciesId: SPECIES }, [
      { field: "file", name: "IMG_2000.tif", bytes: edited, type: "image/tiff" },
      // exiftool reads by content, so a JPEG body stands in for camera RAW bytes here.
      { field: "rawFile", name: "IMG_2000.dng", bytes: raw, type: "image/x-adobe-dng" },
    ]);
    const res = await app.inject({ method: "POST", url: "/api/uploads", ...pair });
    expect(res.statusCode, res.body).toBe(201);
    const rows = await db.query<{ kind: string; ref: string }>(`SELECT kind, ref FROM originals WHERE capture_id = $1 ORDER BY kind`, [res.json().captureId]);
    expect(rows.rows.map((r) => [r.kind, path.basename(r.ref), path.basename(path.dirname(r.ref))])).toEqual([
      ["jpeg", "IMG_2000.tif", "Adjusted"],
      ["raw", "IMG_2000.dng", "RAW"],
    ]);
    const photo = await db.query<{ width: number }>(`SELECT width FROM photos WHERE id = $1`, [res.json().photoId]);
    expect(photo.rows[0].width).toBe(80);

    // The import screen gets a JPEG preview of a TIFF, which browsers can't show.
    const check = await app.inject({ method: "POST", url: "/api/uploads/inspect", ...(await form({}, [{ field: "file", name: "IMG_2001.tif", bytes: edited, type: "image/tiff" }])) });
    expect(check.json().previewDataUrl).toMatch(/^data:image\/jpeg;base64,/);

    const cfa = setTiffPhotometric(edited, 32803);
    const rawRes = await app.inject({ method: "POST", url: "/api/uploads", ...(await form({ speciesId: SPECIES }, [{ field: "file", name: "IMG_2002.tif", bytes: cfa, type: "image/tiff" }])) });
    expect(rawRes.statusCode, rawRes.body).toBe(201);
    expect(rawRes.json()).toMatchObject({ linkedExisting: false });
    const rawRows = await db.query<{ kind: string; ref: string }>(`SELECT kind, ref FROM originals WHERE capture_id = $1`, [rawRes.json().captureId]);
    expect(rawRows.rows.map((r) => [r.kind, path.basename(path.dirname(r.ref))])).toEqual([["raw", "RAW"]]);
  }, 60_000);

  it("imports a WebP with derivatives, keyword suggestions and metadata written into the file", async () => {
    const webp = await sharp({ create: { width: 120, height: 90, channels: 3, background: "#884422" } }).webp().toBuffer();
    const file = path.join(scratch, "IMG_3000.webp");
    writeFileSync(file, webp);
    await exiftool.write(file, { "XMP-dc:Subject": ["Testus giganticus"], "XMP-exif:DateTimeOriginal": "2024:05:03 09:00:00" } as WriteTags, { writeArgs: ["-overwrite_original"] });
    const bytes = readFileSync(file);

    const check = await app.inject({ method: "POST", url: "/api/uploads/inspect", ...(await form({}, [{ field: "file", name: "IMG_3000.webp", bytes, type: "image/webp" }])) });
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json().suggestions[0]).toMatchObject({ id: SPECIES, source: "keyword_tag" });
    expect(check.json().previewDataUrl).toBeNull();

    const res = await app.inject({ method: "POST", url: "/api/uploads", ...(await form({ speciesId: SPECIES }, [{ field: "file", name: "IMG_3000.webp", bytes, type: "image/webp" }])) });
    expect(res.statusCode, res.body).toBe(201);
    const row = await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [res.json().captureId]);
    expect(path.extname(row.rows[0].ref)).toBe(".webp");
    const photo = await db.query<{ width: number; display_path: string }>(`SELECT width, display_path FROM photos WHERE id = $1`, [res.json().photoId]);
    expect(photo.rows[0].width).toBe(120);
    expect(existsSync(photo.rows[0].display_path)).toBe(true);
    await waitFor(async () => ((await exiftool.read(row.rows[0].ref)).Title as string | undefined) === "Large Test Tern");
    expect((await sharp(row.rows[0].ref).metadata()).format).toBe("webp");
  }, 60_000);

  it("imports a video sent as a resumable upload", async () => {
    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    const video = path.join(scratch, "clip.mp4");
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=64x48:rate=10", "-pix_fmt", "yuv420p", "-c:v", "libx264", video], { stdio: "ignore" });
    const bytes = readFileSync(video);
    const cookies = { [cookieName]: SESSION };
    const { id } = await tusUpload(app, bytes, { headers: { "x-lifer-client": "1" }, cookies, filename: "CLIP_0001.mp4", filetype: "video/mp4", chunkSize: 4096 });
    const body = await form({ speciesId: SPECIES, uploadId: id });
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads/video",
      payload: body.payload,
      headers: { "content-type": body.headers["content-type"], "x-lifer-client": "1" },
      cookies,
    });
    expect(res.statusCode, res.body).toBe(201);
    const row = await db.query<{ ref: string; content_hash: string }>(`SELECT ref, content_hash FROM originals WHERE capture_id = $1 AND kind = 'video'`, [res.json().captureId]);
    expect(path.basename(row.rows[0].ref)).toBe("CLIP_0001.mp4");
    expect(row.rows[0].content_hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(readFileSync(row.rows[0].ref).equals(bytes)).toBe(true);
  }, 60_000);

  it.skipIf(!hasHeicEncoder)("imports a HEIC upright, reading its EXIF, and matches on the decoded image", async () => {
    // 300x200 landscape stored as a 90 degree turn: left half red, right half blue. Upright it's
    // 200x300 with red on top.
    const src = path.join(scratch, "src.jpg");
    await sharp({ create: { width: 300, height: 200, channels: 3, background: "#ff0000" } })
      .composite([{ input: await sharp({ create: { width: 150, height: 200, channels: 3, background: "#0000ff" } }).png().toBuffer(), left: 150, top: 0 }])
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toFile(src);
    await exiftool.write(src, { DateTimeOriginal: "2024:05:06 07:08:09", GPSLatitude: 49.25, GPSLatitudeRef: "N", GPSLongitude: -123.1, GPSLongitudeRef: "W" } as WriteTags, { writeArgs: ["-overwrite_original"] });
    const heic = path.join(scratch, "IMG_4000.HEIC");
    if (process.platform === "darwin") execFileSync("/usr/bin/sips", ["-s", "format", "heic", src, "--out", heic], { stdio: "ignore" });
    else execFileSync(existsSync("/usr/bin/heif-enc") ? "/usr/bin/heif-enc" : "/opt/homebrew/bin/heif-enc", [src, "-o", heic], { stdio: "ignore" });
    await exiftool.write(heic, { "XMP-dc:Subject": ["Large Test Tern"] } as WriteTags, { writeArgs: ["-overwrite_original"] });
    const bytes = readFileSync(heic);

    // Sent as a resumable upload with no MIME type, as most desktop browsers do for HEIC.
    const { id } = await tusUpload(app, bytes, { headers: API, filename: "IMG_4000.HEIC", filetype: "", chunkSize: 1024 });
    const check = await app.inject({ method: "POST", url: "/api/uploads/inspect", ...(await form({ uploadId: id })) });
    expect(check.statusCode, check.body).toBe(200);
    expect(check.json().suggestions[0]).toMatchObject({ id: SPECIES, source: "keyword_tag" });
    expect(check.json().previewDataUrl).toMatch(/^data:image\/jpeg;base64,/);
    const preview = await sharp(Buffer.from(check.json().previewDataUrl.split(",")[1], "base64")).metadata();
    expect([preview.width, preview.height]).toEqual([200, 300]);

    const res = await app.inject({ method: "POST", url: "/api/uploads", ...(await form({ speciesId: SPECIES, uploadId: id })) });
    expect(res.statusCode, res.body).toBe(201);
    const capture = await db.query<{ lat: number; lon: number; taken_at: Date }>(`SELECT lat, lon, taken_at FROM captures WHERE id = $1`, [res.json().captureId]);
    expect(capture.rows[0].lat).toBeCloseTo(49.25);
    expect(capture.rows[0].lon).toBeCloseTo(-123.1);
    expect(capture.rows[0].taken_at).toBeTruthy();
    const row = await db.query<{ ref: string; content_hash: string }>(`SELECT ref, content_hash FROM originals WHERE capture_id = $1`, [res.json().captureId]);
    // The original is kept as it came (metadata aside, which is written into it afterwards).
    expect(path.basename(row.rows[0].ref)).toBe("IMG_4000.heic");
    expect(row.rows[0].content_hash).toBe(createHash("sha256").update(bytes).digest("hex"));
    const photo = await db.query<{ width: number; height: number; display_path: string }>(`SELECT width, height, display_path FROM photos WHERE id = $1`, [res.json().photoId]);
    expect(photo.rows[0]).toMatchObject({ width: 200, height: 300 });
    const { data, info } = await sharp(photo.rows[0].display_path).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => Array.from(data.subarray((y * info.width + x) * info.channels, (y * info.width + x) * info.channels + 3));
    expect(at(100, 20)[0]).toBeGreaterThan(200);
    expect(at(100, 280)[2]).toBeGreaterThan(200);

    // Species matching gets the decoded pixels: the bundled animal detector runs on it.
    const { analyzeImage } = await import("@lifer/core/species/inference.js");
    const analysis = await analyzeImage({ path: row.rows[0].ref }, { targets: [], presence: true, priority: "interactive" });
    expect(analysis.presence).toBeTruthy();
    await waitFor(async () => ((await exiftool.read(row.rows[0].ref)).Title as string | undefined) === "Large Test Tern");
  }, 60_000);
});

async function waitFor(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Timed out waiting");
}
