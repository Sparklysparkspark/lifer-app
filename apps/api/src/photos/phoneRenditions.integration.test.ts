// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// What a paired phone reads: stable renditions with ETags and the full-size render, by device key.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dirs = vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
  const base = `${process.env.TMPDIR ?? "/tmp"}/lifer-phonerend-${process.pid}`;
  process.env.APP_DATA_DIR = `${base}/app`;
  return { base };
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000611";
const SPECIES = "ffffffff-0000-4000-8000-0000000006a1";
const DEVICE = "lifer_test_device_rend_611";
const NARROW = "lifer_test_gallery_only_611";

describe.skipIf(!url)("phone renditions", () => {
  let app: FastifyInstance;
  let gated: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let jpegPhoto: string;
  let pngPhoto: string;
  let rawPhoto: string;
  let barePhoto: string;
  let lostPng: string;
  let lostRaw: string;
  let lostBare: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-phonerend-"));
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'phonerend@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES
         ($1, 'Test phone (ios)', $2, '{companion}'),
         ($1, 'narrow', $3, '{gallery.read}')`,
      [USER, hashApiKey(DEVICE), hashApiKey(NARROW)],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 913611, 'Phonea rend', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: "#3a6" } })
      .webp()
      .toBuffer();
    const small = await sharp({ create: { width: 400, height: 267, channels: 3, background: "#3a6" } })
      .webp()
      .toBuffer();
    writeFileSync(path.join(dir, "d.webp"), big);
    writeFileSync(path.join(dir, "t.webp"), small);
    writeFileSync(
      path.join(dir, "o.jpg"),
      await sharp({ create: { width: 64, height: 48, channels: 3, background: "#fa0" } })
        .jpeg()
        .toBuffer(),
    );
    writeFileSync(
      path.join(dir, "o.png"),
      await sharp({ create: { width: 64, height: 48, channels: 3, background: "#0af" } })
        .png()
        .toBuffer(),
    );
    writeFileSync(path.join(dir, "o.nef"), Buffer.alloc(512, 3));
    const add = async (fp: string, original: [string, string] | null, display = "d.webp") => {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, fp],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $3) RETURNING id`,
        [c.rows[0].id, path.join(dir, display), path.join(dir, "t.webp")],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      if (original) {
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, $2, 'path', $3, false, 'h', 1)`,
          [c.rows[0].id, original[0], path.join(dir, original[1])],
        );
      }
      return p.rows[0].id;
    };
    jpegPhoto = await add("pr-1", ["jpeg", "o.jpg"]);
    pngPhoto = await add("pr-2", ["jpeg", "o.png"]);
    rawPhoto = await add("pr-3", ["raw", "o.nef"]);
    barePhoto = await add("pr-4", null);
    lostPng = await add("pr-5", ["jpeg", "o.png"], "gone.webp");
    lostRaw = await add("pr-7", ["raw", "o.nef"], "gone.webp");
    lostBare = await add("pr-8", null, "gone.webp");

    const { photoRoutes } = await import("./routes.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    const { installSchemas } = await import("../lib/schema.js");
    const build = async (gate: boolean) => {
      const a = Fastify();
      installSchemas(a);
      await a.register(cookie);
      if (gate)
        a.addHook(
          "onRequest",
          desktopRequestGate(4311, () => ({ token: "t", allowUntokened: false })),
        );
      await a.register(photoRoutes, { prefix: "/api" });
      await a.ready();
      return a;
    };
    app = await build(false);
    gated = await build(true);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await gated?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirs.base, { recursive: true, force: true });
  });

  const key = { "x-api-key": DEVICE };
  const get = (u: string, headers: Record<string, string> = key, a = app) =>
    a.inject({ method: "GET", url: `/api${u}`, headers });

  it("serves thumb, display and a 2,048px phone copy with stable ETags", async () => {
    for (const kind of ["thumb", "display", "phone"]) {
      const first = await get(`/photos/${jpegPhoto}/${kind}`);
      expect(first.statusCode, kind).toBe(200);
      expect(first.headers["content-type"]).toBe("image/webp");
      const etag = first.headers.etag as string;
      expect(etag).toBeTruthy();
      expect((await get(`/photos/${jpegPhoto}/${kind}`)).headers.etag).toBe(etag);
      const again = await get(`/photos/${jpegPhoto}/${kind}`, { ...key, "if-none-match": etag });
      expect(again.statusCode).toBe(304);
    }
    const phone = await get(`/photos/${jpegPhoto}/phone`);
    const meta = await sharp(phone.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([2048, 1365]);
  });

  it("streams a JPEG original as it is and renders other originals to JPEG", async () => {
    const jpeg = await get(`/photos/${jpegPhoto}/full`);
    expect([jpeg.statusCode, jpeg.headers["content-type"]]).toEqual([200, "image/jpeg"]);
    expect(
      (await get(`/photos/${jpegPhoto}/full`, { ...key, "if-none-match": jpeg.headers.etag as string })).statusCode,
    ).toBe(304);
    const png = await get(`/photos/${pngPhoto}/full`);
    expect([png.statusCode, png.headers["content-type"]]).toEqual([200, "image/jpeg"]);
    expect((await sharp(png.rawPayload).metadata()).format).toBe("jpeg");
    const again = await get(`/photos/${pngPhoto}/full`, { ...key, "if-none-match": png.headers.etag as string });
    expect(again.statusCode).toBe(304);
  });

  it("answers 404 when there is nothing to render", async () => {
    expect((await get(`/photos/${rawPhoto}/full`)).statusCode).toBe(404);
    expect((await get(`/photos/${barePhoto}/full`)).statusCode).toBe(404);
  });

  it("makes the phone copy from the original when the display image is missing", async () => {
    for (const id of [lostPng]) {
      const res = await get(`/photos/${id}/phone`);
      expect(res.statusCode, id).toBe(200);
      expect(res.headers["content-type"]).toBe("image/webp");
      expect((await sharp(res.rawPayload).metadata()).width).toBe(64);
      expect((await get(`/photos/${id}/phone`, { ...key, "if-none-match": res.headers.etag as string })).statusCode).toBe(304);
    }
  });

  it("answers 404 with a reason, never the thumbnail, when no picture can be made", async () => {
    for (const id of [lostRaw, lostBare]) {
      const res = await get(`/photos/${id}/phone`);
      expect(res.statusCode, id).toBe(404);
      expect(res.headers["x-lifer-reason"]).toBe("no-image");
    }
  });

  it("refuses a key without the companion or photos scope", async () => {
    const narrow = { "x-api-key": NARROW };
    for (const kind of ["thumb", "display", "phone", "full"]) {
      expect((await get(`/photos/${jpegPhoto}/${kind}`, narrow)).statusCode, kind).toBe(401);
      expect((await get(`/photos/${jpegPhoto}/${kind}`, {})).statusCode, kind).toBe(401);
    }
  });

  it("reaches the renditions through the desktop gate with a device key, and not the originals", async () => {
    const hosted = { ...key, host: "127.0.0.1:4311" };
    for (const kind of ["thumb", "display", "phone", "full"]) {
      expect((await get(`/photos/${jpegPhoto}/${kind}`, hosted, gated)).statusCode, kind).toBe(200);
    }
    expect((await get(`/photos/${jpegPhoto}/original`, hosted, gated)).statusCode).toBe(401);
    expect((await get(`/photos/${jpegPhoto}/original-raw`, hosted, gated)).statusCode).toBe(401);
  });
});
