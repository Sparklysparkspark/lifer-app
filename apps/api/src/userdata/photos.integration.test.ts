// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /userdata/v1/species/:id/photos over HTTP with a real key: order, exclusions, limit, featured,
// other users' data and the scope.
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000701";
const OTHER = "cccccccc-0000-4000-8000-000000000702";
const SP = "cccccccc-0000-4000-8000-0000000007a0";
const SP2 = "cccccccc-0000-4000-8000-0000000007b0";
const TOKEN = "lifer_test_userdata_photos_701";
const NARROW = "lifer_test_userdata_photos_703";

type Item = { photoId: string; captureId: string; thumbnailUrl: string; rating: number | null; featured: boolean };

describe.skipIf(!url)("GET /userdata/v1/species/:id/photos", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let file = "";
  const ids: Record<string, string> = {};

  const get = (p: string, token = TOKEN) => app.inject({ method: "GET", url: p, headers: { "x-api-key": token } });
  const list = async (q = "") => {
    const res = await get(`/api/userdata/v1/species/${SP}/photos${q}`);
    expect(res.statusCode).toBe(200);
    return (res.json() as { items: Item[] }).items;
  };

  async function capture(name: string, user: string, species: string, rating: number | null, takenAt: string | null) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating)
       VALUES ($1, $2, gen_random_uuid()::text, $3, $4) RETURNING id`,
      [user, species, takenAt, rating],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`,
      [c.rows[0].id, file],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    ids[name] = p.rows[0].id;
    return c.rows[0].id;
  }

  async function cleanup() {
    for (const u of [USER, OTHER]) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP, SP2]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    dir = await mkdtemp(path.join(os.tmpdir(), "lifer-userdata-photos-"));
    file = path.join(dir, "t.webp");
    await sharp({ create: { width: 4, height: 4, channels: 3, background: "#336699" } })
      .webp()
      .toFile(file);
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { installSchemas, replyToValidationError } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    await cleanup();

    for (const [u, email] of [
      [USER, "userdata-photos@test"],
      [OTHER, "userdata-photos-other@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [u, email]);
    for (const [i, id] of [SP, SP2].entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, 'x', 'aves')`,
        [id, 970700 + i, `Photosus ${"ab"[i]}`],
      );

    await capture("old4", USER, SP, 4, "2026-01-01Z");
    await capture("new4", USER, SP, 4, "2026-03-01Z");
    await capture("five", USER, SP, 5, "2025-01-01Z");
    await capture("unrated", USER, SP, null, "2026-06-01Z");
    // An additional subject of a photo of another species still counts.
    const extra = await capture("extra", USER, SP2, 3, "2026-02-01Z");
    await db.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`, [extra, SP]);
    const hidden = await capture("hidden", USER, SP, 5, "2026-01-01Z");
    await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [hidden]);
    const trashed = await capture("trashed", USER, SP, 5, "2026-01-01Z");
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [trashed]);
    await capture("others", OTHER, SP, 5, "2026-01-01Z");
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id) VALUES ($1, $2, 'collected', $3)`,
      [USER, SP, ids.new4],
    );

    const key = `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'k', $2, $3)`;
    await db.query(key, [USER, hashApiKey(TOKEN), ["userdata.read"]]);
    await db.query(key, [USER, hashApiKey(NARROW), ["userdata.write", "imports.write", "opendata.read"]]);

    app = Fastify();
    installSchemas(app);
    // As index.ts does, so a malformed id answers 404.
    app.setErrorHandler((err: FastifyError, request, reply) => {
      if (!replyToValidationError(err, request, reply)) reply.send(err);
    });
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    await rm(dir, { recursive: true, force: true });
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("ranks by rating, then newest, with only the user's visible photos", async () => {
    const items = await list();
    const name = (id: string) => Object.keys(ids).find((k) => ids[k] === id);
    expect(items.map((i) => name(i.photoId))).toEqual(["five", "new4", "old4", "extra", "unrated"]);
    expect(items.find((i) => i.photoId === ids.unrated)!.rating).toBeNull();
    expect(items.filter((i) => i.featured).map((i) => i.photoId)).toEqual([ids.new4]);
  });

  it("honours limit and validates input", async () => {
    expect((await list("?limit=2")).map((i) => i.photoId)).toEqual([ids.five, ids.new4]);
    expect((await get(`/api/userdata/v1/species/${SP}/photos?limit=201`)).statusCode).toBe(400);
    expect((await get(`/api/userdata/v1/species/${SP}/photos?limit=0`)).statusCode).toBe(400);
    expect((await get(`/api/userdata/v1/species/not-a-uuid/photos`)).statusCode).toBe(404);
    expect((await get(`/api/userdata/v1/species/cccccccc-0000-4000-8000-0000000007ff/photos`)).statusCode).toBe(404);
  });

  it("hands out thumbnails that work with the same key", async () => {
    const [first] = await list();
    const thumb = await get(first.thumbnailUrl);
    expect(thumb.statusCode).toBe(200);
    expect(thumb.headers["content-type"]).toContain("image/webp");
    expect((await get(`/api/userdata/v1/photos/${ids.others}/thumb`)).statusCode).toBe(404);
    expect((await get(`/api/userdata/v1/photos/${ids.hidden}/thumb`)).statusCode).toBe(404);
  });

  it("refuses a key without userdata.read", async () => {
    // Every API-key failure answers alike (auth/session.ts verifyApiKeyScope).
    expect((await get(`/api/userdata/v1/species/${SP}/photos`, NARROW)).statusCode).toBe(401);
    expect((await get(`/api/userdata/v1/photos/${ids.five}/thumb`, NARROW)).statusCode).toBe(401);
  });
});
