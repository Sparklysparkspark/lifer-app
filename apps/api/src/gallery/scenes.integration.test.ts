// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A photo's burst and scene (GET /captures/:id/scene) and the grid's burst badges (POST /gallery/bursts).
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000e71";
const OTHER_USER = "ffffffff-0000-4000-8000-000000000e72";
const SPECIES = "ffffffff-0000-4000-8000-000000000ea1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "scenes@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

interface Frame {
  captureId: string;
}
interface Scene {
  burst: string[];
  scene: Array<{ burstId: string; frames: Frame[] }>;
  position: { burst: number; frame: number };
  truncated: boolean;
}

describe.skipIf(!url)("bursts and scenes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: Record<string, string> = {};
  let n = 0;

  const scene = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/captures/${id}/scene` });
    return { status: res.statusCode, body: res.json() as Scene };
  };
  const sizes = (s: Scene) => s.scene.map((b) => b.frames.length);

  async function capture(
    name: string,
    takenAt: string,
    o: { lat?: number; lon?: number; kind?: string; raw?: boolean; user?: string; vector?: number[] | null } = {},
  ) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, lat, lon, camera_model)
       VALUES ($1, $2, $3, $4, $5, $6, 'R5') RETURNING id`,
      [o.user ?? USER, SPECIES, `scene-${name}-${++n}`, takenAt, o.lat ?? null, o.lon ?? null],
    );
    const id = c.rows[0].id;
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, kind) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', $2) RETURNING id`,
      [id, o.kind ?? "image"],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, id]);
    if (o.raw)
      for (const kind of ["raw", "jpeg"])
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
           VALUES ($1, $2, 'path', $3, true, $4, 1)`,
          [id, kind, `/nowhere/${name}.${kind}`, `scene-hash-${name}-${kind}`],
        );
    if (o.vector !== null)
      await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
        id,
        o.vector ?? [1, 0, 0, 0],
        EMBEDDING_MODEL_VERSION,
      ]);
    ids[name] = id;
  }

  const at = (base: string, ms: number) => new Date(Date.parse(base) + ms).toISOString();

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    for (const [id, email] of [
      [USER, "scenes@test"],
      [OTHER_USER, "scenes-other@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 913801, 'Scena burstia', 'Scene Wren', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    // Day 1: twelve frames 120 ms apart (one of them a RAW with its JPEG), a video in the middle,
    // three more 40 s later, then ten minutes on and 3 km away a lone photo.
    const d1 = "2025-05-01T10:00:00.120Z";
    for (let i = 0; i < 12; i++) await capture(`a${i}`, at(d1, i * 120), { lat: 49, lon: -123, raw: i === 5 });
    await capture("video", at(d1, 500), { kind: "video", lat: 49, lon: -123 });
    for (let i = 0; i < 3; i++) await capture(`b${i}`, at(d1, 40_000 + i * 120), { lat: 49, lon: -123 });
    await capture("far", at(d1, 40_000 + 10 * 60_000), { lat: 49.027, lon: -123 });
    // Day 2: whole-second times and no vectors: 1 s apart is one burst, 2 s is another.
    const d2 = "2025-05-02T08:00:00Z";
    for (const [name, s] of [
      ["w0", 0],
      ["w1", 1],
      ["w2", 2],
      ["w3", 4],
    ] as const)
      await capture(name, at(d2, s * 1000), { vector: null });
    // Day 3: a 400-frame burst, 100 ms apart.
    const d3 = Date.parse("2025-05-03T07:00:00.050Z");
    const long = await db.query<{ id: string }>(
      `WITH c AS (
         INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, camera_model)
         SELECT $1, $2, 'scene-long-' || g, to_timestamp(($3::float8 + g * 100) / 1000), 'R5' FROM generate_series(0, 399) g
         RETURNING id, taken_at)
       SELECT id FROM c ORDER BY taken_at`,
      [USER, SPECIES, d3],
    );
    await db.query(
      `WITH p AS (INSERT INTO photos (capture_id, display_path, thumb_path)
                  SELECT id, '/nowhere/d.webp', '/nowhere/t.webp' FROM unnest($1::uuid[]) id RETURNING id, capture_id)
       UPDATE captures_all c SET current_photo_id = p.id FROM p WHERE c.id = p.capture_id`,
      [long.rows.map((r) => r.id)],
    );
    long.rows.forEach((r, i) => (ids[`long${i}`] = r.id));
    await capture("otherUser", at(d1, 60), { user: OTHER_USER });
    const { sceneRoutes } = await import("./sceneRoutes.js");
    app = Fastify();
    await app.register(sceneRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("gives a burst of twelve and the next burst 40 s later as one scene", async () => {
    const { status, body } = await scene(ids.a3);
    expect(status).toBe(200);
    expect(sizes(body)).toEqual([12, 3]);
    expect(body.burst).toEqual(Array.from({ length: 12 }, (_, i) => ids[`a${i}`]));
    expect(body.position).toEqual({ burst: 0, frame: 3 });
    expect(body.truncated).toBe(false);
    expect(body.scene[1].burstId).toBe(ids.b0);
    expect((await scene(ids.b2)).body.position).toEqual({ burst: 1, frame: 2 });
  });

  it("counts a RAW with its JPEG as one frame and leaves videos out", async () => {
    const { body } = await scene(ids.a5);
    const all = body.scene.flatMap((b) => b.frames.map((f) => f.captureId));
    expect(all.filter((id) => id === ids.a5)).toHaveLength(1);
    expect(all).not.toContain(ids.video);
  });

  it("starts a new scene ten minutes later and 3 km away", async () => {
    const { body } = await scene(ids.far);
    expect(sizes(body)).toEqual([1]);
    expect(body.burst).toEqual([ids.far]);
  });

  it("falls back to a one-second gap without sub-seconds", async () => {
    const { body } = await scene(ids.w1);
    expect(body.burst).toEqual([ids.w0, ids.w1, ids.w2]);
    expect(sizes(body)).toEqual([3, 1]);
  });

  it("cuts a 400-frame burst to the 300 frames around the photo", async () => {
    const { body } = await scene(ids.long10);
    expect(body.truncated).toBe(true);
    expect(sizes(body)).toEqual([300]);
    expect(body.scene[0].frames[body.position.frame].captureId).toBe(ids.long10);
    expect(body.scene[0].frames[0].captureId).toBe(ids.long0);
  });

  it("gives a video alone and never reaches another user's photo", async () => {
    expect(sizes((await scene(ids.video)).body)).toEqual([1]);
    expect((await scene(ids.otherUser)).status).toBe(404);
  });

  it("badges the grid's photos with their burst", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/gallery/bursts",
      payload: { captureIds: [ids.a0, ids.a7, ids.far, ids.w3, ids.long399, ids.otherUser] },
    });
    expect(res.statusCode).toBe(200);
    const bursts = (res.json() as { bursts: Array<{ burstId: string; count: number; captureIds: string[] }> }).bursts;
    expect(bursts).toEqual([
      { burstId: ids.a0, count: 12, captureIds: [ids.a0, ids.a7] },
      { burstId: ids.long0, count: 400, captureIds: [ids.long399] },
    ]);
  });
});
