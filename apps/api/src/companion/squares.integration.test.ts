// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The pre-cropped squares a paired phone fetches for cards and covers.
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dirs = vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
  const base = `${process.env.TMPDIR ?? "/tmp"}/lifer-squares-${process.pid}`;
  process.env.APP_DATA_DIR = `${base}/app`;
  return { base };
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000721";
const OTHER = "ffffffff-0000-4000-8000-000000000722";
const SPECIES = "ffffffff-0000-4000-8000-0000000007a1";
const ALBUM = "ffffffff-0000-4000-8000-0000000007b1";
const DEVICE = "lifer_test_device_square_721";

describe.skipIf(!url)("phone squares", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let photo: string;
  let theirs: string;

  const get = (u: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api/companion/v1/square/${u}`, headers: { "x-api-key": DEVICE, ...headers } });
  const setCrop = (x: number, y: number, size: number) =>
    db.query(`UPDATE user_species SET card_crop_x = $1, card_crop_y = $2, card_crop_size = $3 WHERE user_id = $4`, [x, y, size, USER]);

  beforeAll(async () => {
    const displayDir = path.join(dirs.base, "app", "display");
    mkdirSync(displayDir, { recursive: true });
    // Left half red, right half blue, so a crop's side shows in its pixels.
    const halves = await sharp({ create: { width: 2000, height: 1000, channels: 3, background: "#ff0000" } })
      .composite([{ input: { create: { width: 1000, height: 1000, channels: 3, background: "#0000ff" } }, left: 1000, top: 0 }])
      .webp()
      .toBuffer();
    const file = path.join(displayDir, "p.webp");
    await sharp(halves).toFile(file);
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { squareRoutes } = await import("./squares.js");
    const { installSchemas } = await import("../lib/schema.js");
    for (const id of [USER, OTHER]) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [id]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [id]);
      await db.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'sq721@test', 'x'), ($2, 'sq722@test', 'x')`, [USER, OTHER]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'Test phone (ios)', $2, '{companion}')`, [USER, hashApiKey(DEVICE)]);
    await db.query(`INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzsquare alpha', 'Square Bird', 'aves', 980721)`, [SPECIES]);
    const mk = async (user: string, tag: string) => {
      const capture = (await db.query(`INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, now()) RETURNING id`, [user, SPECIES, tag])).rows[0].id;
      const id = (await db.query(`INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`, [capture, file])).rows[0].id;
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [id, capture]);
      return id as string;
    };
    photo = await mk(USER, "sq-1");
    theirs = await mk(OTHER, "sq-2");
    await db.query(`INSERT INTO user_species (user_id, species_id, state, cover_photo_id) VALUES ($1, $2, 'collected', $3)`, [USER, SPECIES, photo]);
    await db.query(`INSERT INTO albums (id, user_id, name, cover_photo_id, cover_crop_x, cover_crop_y, cover_crop_size) VALUES ($1, $2, 'Covers', $3, 0, 0, 40)`, [ALBUM, USER, photo]);
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(squareRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM albums WHERE id = $1`, [ALBUM]);
      for (const id of [USER, OTHER]) {
        await db.query(`DELETE FROM user_species WHERE user_id = $1`, [id]);
        await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [id]);
        await db.query(`DELETE FROM users WHERE id = $1`, [id]);
      }
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    rmSync(dirs.base, { recursive: true, force: true });
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("cuts the card crop to a square, and the ETag changes with the crop", async () => {
    await setCrop(50, 0, 50); // the right (blue) half, 1000 px wide
    const first = await get(`species/Zzsquare_alpha?photo=${photo}`);
    expect(first.statusCode).toBe(200);
    expect(first.headers["content-type"]).toBe("image/webp");
    const meta = await sharp(first.rawPayload).metadata();
    expect([meta.width, meta.height]).toEqual([1000, 1000]);
    const px = await sharp(first.rawPayload).raw().toBuffer();
    expect(px[2]).toBeGreaterThan(180);
    expect(px[0]).toBeLessThan(80);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]+"$/);

    expect((await get(`species/Zzsquare_alpha?photo=${photo}`, { "if-none-match": etag })).statusCode).toBe(304);

    await setCrop(0, 0, 50); // the left (red) half
    const second = await get(`species/Zzsquare_alpha?photo=${photo}`, { "if-none-match": etag });
    expect(second.statusCode).toBe(200);
    expect(second.headers.etag).not.toBe(etag);
    const red = await sharp(second.rawPayload).raw().toBuffer();
    expect(red[0]).toBeGreaterThan(180);
    expect(red[2]).toBeLessThan(80);
  });

  it("uses an album's cover crop, and centres when the photo is not the chosen cover", async () => {
    const album = await get(`album/${ALBUM}?photo=${photo}`);
    expect(album.statusCode).toBe(200);
    expect((await sharp(album.rawPayload).metadata()).width).toBe(800);
    await db.query(`UPDATE albums SET cover_photo_id = NULL WHERE id = $1`, [ALBUM]);
    const centred = await get(`album/${ALBUM}?photo=${photo}`);
    expect((await sharp(centred.rawPayload).metadata()).width).toBe(1000);
    expect(centred.headers.etag).not.toBe(album.headers.etag);
  });

  it("refuses another account's photo and a request with no key", async () => {
    expect((await get(`species/Zzsquare_alpha?photo=${theirs}`)).statusCode).toBe(404);
    const bare = await app.inject({ method: "GET", url: `/api/companion/v1/square/species/Zzsquare_alpha?photo=${photo}` });
    expect(bare.statusCode).toBe(401);
  });
});
