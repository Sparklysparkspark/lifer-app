// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The offline picture search a phone downloads: the text encoder files and the photo vector feed.
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { float16BitsToFloat32 } from "@lifer/core/species/galleryEmbeddingsFormat.js";

const cache = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? "/tmp"}/lifer-search-model-test-${process.pid}`;
  process.env.LIFER_CACHE_DIR = dir;
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
  return dir;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000a01";
const OTHER = "eeeeeeee-0000-4000-8000-000000000a02";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000a0a";
const KEY = "lifer_test_search_model_a01";
const caps = [1, 2, 3, 4, 5].map((n) => `eeeeeeee-0000-4000-8000-000000000a1${n}`);
const [SHOWN, HIDDEN, TRASHED, OTHERS, PURGED] = caps;
const ENCODER = Buffer.from("not really onnx, but bytes that must arrive intact".repeat(40));

describe.skipIf(!url)("offline search model and vectors", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let modelDir: string;
  const get = (p: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: p, headers: { "x-api-key": KEY, ...headers } });

  const putFiles = async () => {
    const { TEXT_MODEL } = await import("@lifer/core/species/textEmbedding.js");
    modelDir = path.join(TEXT_MODEL.cacheDir, TEXT_MODEL.modelId, TEXT_MODEL.revision);
    mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
    writeFileSync(path.join(modelDir, "onnx/text_model_quantized.onnx"), ENCODER);
    for (const f of ["tokenizer.json", "tokenizer_config.json", "config.json"])
      writeFileSync(path.join(modelDir, f), `{"file":"${f}"}`);
  };

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { installSchemas } = await import("../lib/schema.js");
    const { searchModelRoutes } = await import("./searchModel.js");
    const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER]]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [[USER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    for (const [id, email] of [
      [USER, "model-a@test"],
      [OTHER, "model-b@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'phone', $2, '{companion}')`,
      [USER, hashApiKey(KEY)],
    );
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzmodel vectorus', 'Vector Bird', 'aves', 980901)`,
      [SPECIES],
    );
    for (const [i, id] of [SHOWN, HIDDEN, TRASHED, OTHERS].entries()) {
      await db.query(
        `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, hidden_at, deleted_at)
         VALUES ($1, $2, $3, $4, '2026-05-01T08:00:00Z', $5, $6)`,
        [
          id,
          id === OTHERS ? OTHER : USER,
          SPECIES,
          `model-${i}`,
          id === HIDDEN ? "2026-05-02T00:00:00Z" : null,
          id === TRASHED ? "2026-05-02T00:00:00Z" : null,
        ],
      );
      const v = Array.from({ length: 768 }, (_, k) => (k === i ? 1 : 0));
      await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
        id,
        v,
        EMBEDDING_MODEL_VERSION,
      ]);
    }
    await db.query(`INSERT INTO sync_tombstones (user_id, kind, ref) VALUES ($1, 'capture', $2)`, [USER, PURGED]);
    mkdirSync(cache, { recursive: true });
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(searchModelRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER]]);
      await db.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [[USER, OTHER]]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    rmSync(cache, { recursive: true, force: true });
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("needs a key", async () => {
    expect((await app.inject({ method: "GET", url: "/api/companion/v1/model/text" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/companion/v1/model/vectors" })).statusCode).toBe(401);
  });

  it("says the model isn't there yet, then lists the files with sizes and hashes", async () => {
    const none = (await get("/api/companion/v1/model/text")).json();
    expect(none).toMatchObject({ available: false, files: [] });
    expect((await get("/api/companion/v1/model/text/encoder")).statusCode).toBe(404);

    await putFiles();
    const manifest = (await get("/api/companion/v1/model/text")).json();
    expect(manifest).toMatchObject({ available: true, dimension: 768, normalization: "l2", output: "text_embeds" });
    expect(manifest.textModelVersion).toMatch(/^clip-vit-l14-text/);
    const encoder = manifest.files.find((f: { name: string }) => f.name === "encoder");
    expect(encoder).toMatchObject({
      size: ENCODER.length,
      sha256: createHash("sha256").update(ENCODER).digest("hex"),
      url: "/api/companion/v1/model/text/encoder",
    });
    expect(manifest.files.map((f: { name: string }) => f.name)).toEqual([
      "encoder",
      "tokenizer",
      "tokenizer-config",
      "config",
    ]);
  });

  it("serves a file whole, in a range and as a 304, and nothing outside the list", async () => {
    const whole = await get("/api/companion/v1/model/text/encoder");
    expect(whole.statusCode).toBe(200);
    expect(whole.rawPayload.equals(ENCODER)).toBe(true);
    expect(whole.headers["x-content-sha256"]).toBe(createHash("sha256").update(ENCODER).digest("hex"));
    const part = await get("/api/companion/v1/model/text/encoder", { range: "bytes=100-199" });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 100-199/${ENCODER.length}`);
    expect(part.rawPayload.equals(ENCODER.subarray(100, 200))).toBe(true);
    const again = await get("/api/companion/v1/model/text/encoder", {
      "if-none-match": String(whole.headers.etag),
    });
    expect(again.statusCode).toBe(304);
    expect((await get("/api/companion/v1/model/text/passwd")).statusCode).toBe(404);
  });

  it("sends visible photos' vectors as float16, and drops for hidden, trashed and purged ones", async () => {
    const page = (await get("/api/companion/v1/model/vectors?limit=500")).json();
    expect(page).toMatchObject({ dimension: 768, next: null });
    expect(page.items.map((i: { id: string }) => i.id)).toEqual([SHOWN]);
    const bytes = Buffer.from(page.items[0].vector, "base64");
    expect(bytes.length).toBe(768 * 2);
    const decoded = Array.from({ length: 768 }, (_, k) => float16BitsToFloat32(bytes.readUInt16LE(k * 2)));
    expect(decoded[0]).toBe(1);
    expect(decoded.slice(1).every((x) => x === 0)).toBe(true);
    expect(page.removed.map((r: { id: string }) => r.id).sort()).toEqual([HIDDEN, TRASHED, PURGED].sort());
    expect(JSON.stringify(page)).not.toContain(OTHERS);
  });

  it("pages by cursor and gives a photo's vector back when it is shown again", async () => {
    const seen: string[] = [];
    let q = "?limit=1";
    for (let i = 0; i < 10; i++) {
      const p = (await get(`/api/companion/v1/model/vectors${q}`)).json();
      seen.push(...p.items.map((x: { id: string }) => x.id), ...p.removed.map((x: { id: string }) => x.id));
      if (!p.next) break;
      q = `?limit=1&since=${encodeURIComponent(p.next.since)}&after=${p.next.after}`;
    }
    expect(seen.sort()).toEqual([SHOWN, HIDDEN, TRASHED, PURGED].sort());

    const before = (await get("/api/companion/v1/model/vectors?limit=500")).json().last;
    await db.query(`UPDATE captures_all SET hidden_at = NULL WHERE id = $1`, [HIDDEN]);
    const after = (
      await get(
        `/api/companion/v1/model/vectors?since=${encodeURIComponent(before.since)}&after=${before.after}&limit=500`,
      )
    ).json();
    expect(after.items.map((i: { id: string }) => i.id)).toEqual([HIDDEN]);
  });

  it("sends each photo's frame, with its background vector only when asked", async () => {
    const { EMBEDDING_MODEL_VERSION } = await import("@lifer/core/config.js");
    const light = { luma: 0.3, warmth: 0.1, highlights: 0, shadows: 0.1, saturation: 0.4 };
    for (const id of [SHOWN, OTHERS]) {
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1, taken_at_zoned = false WHERE id = $2`, [
        p.rows[0].id,
        id,
      ]);
      await db.query(
        `INSERT INTO capture_frames (capture_id, photo_id, version, box, box_unsure, aspect, light)
         VALUES ($1, $2, 'frame-v1', '{0.1,0.2,0.3,0.4}', false, 1.5, $3)`,
        [id, p.rows[0].id, light],
      );
      const v = Array.from({ length: 768 }, (_, k) => (k === 5 ? 1 : 0));
      await db.query(
        `INSERT INTO capture_background_embeddings (capture_id, photo_id, embedding, model_version) VALUES ($1, $2, $3, $4)`,
        [id, p.rows[0].id, v, EMBEDDING_MODEL_VERSION],
      );
    }
    const plain = (await get("/api/companion/v1/model/frames?limit=500")).json();
    expect(plain.items).toHaveLength(1);
    expect(plain.items[0]).toMatchObject({
      id: SHOWN,
      boxUnsure: false,
      aspect: 1.5,
      light,
      takenAtZoned: false,
      background: null,
    });
    expect(plain.items[0].box.map((x: number) => Math.round(x * 10) / 10)).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(JSON.stringify(plain)).not.toContain(OTHERS);

    const withVectors = (await get("/api/companion/v1/model/frames?limit=500&background=1")).json();
    const bytes = Buffer.from(withVectors.items[0].background, "base64");
    expect(bytes.length).toBe(768 * 2);
    expect(float16BitsToFloat32(bytes.readUInt16LE(5 * 2))).toBe(1);
  });
});
