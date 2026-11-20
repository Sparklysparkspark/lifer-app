// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Similar photos from stored vectors: the review list (GET /gallery/similar) and the Gallery's
// ?similarTo= scope.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { EMBEDDING_MODEL_VERSION } from "@lifer/core/config.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000d71";
const OTHER_USER = "ffffffff-0000-4000-8000-000000000d72";
const SPECIES = "ffffffff-0000-4000-8000-000000000da1";
const SPECIES_2 = "ffffffff-0000-4000-8000-000000000da2";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "similar@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("similar photos", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: Record<string, string> = {};

  const get = async (path: string) => {
    const res = await app.inject({ method: "GET", url: `/api${path}` });
    return { status: res.statusCode, body: res.json() };
  };

  async function capture(name: string, user: string, species: string, takenAt: string, vector: number[] | null) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, $4) RETURNING id`,
      [user, species, `similar-${name}`, takenAt],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    if (vector)
      await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
        c.rows[0].id,
        vector,
        EMBEDDING_MODEL_VERSION,
      ]);
    ids[name] = c.rows[0].id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    for (const [id, email] of [
      [USER, "similar@test"],
      [OTHER_USER, "similar-other@test"],
    ])
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 913701, 'Simila burstia', 'Burst Wren', 'aves'), ($2, 913702, 'Simila altera', 'Other Wren', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES, SPECIES_2],
    );
    const same = [1, 0, 0, 0];
    const near = [0.99, 0.141, 0, 0];
    const different = [0, 1, 0, 0];
    // A burst of three, a pair a day later, a frame of another scene in the burst's minute, a
    // lone photo, the same look in another species, and another user's copy of the burst.
    await capture("b1", USER, SPECIES, "2025-05-01T10:00:00Z", same);
    await capture("b2", USER, SPECIES, "2025-05-01T10:00:01Z", near);
    await capture("b3", USER, SPECIES, "2025-05-01T10:00:02Z", same);
    await capture("scene", USER, SPECIES, "2025-05-01T10:00:03Z", different);
    await capture("p1", USER, SPECIES, "2025-05-02T08:00:00Z", same);
    await capture("p2", USER, SPECIES, "2025-05-02T08:01:00Z", same);
    await capture("lone", USER, SPECIES, "2025-06-01T08:00:00Z", same);
    await capture("noVector", USER, SPECIES, "2025-06-01T08:00:01Z", null);
    await capture("otherSpecies", USER, SPECIES_2, "2025-05-01T10:00:01Z", same);
    await capture("otherUser", OTHER_USER, SPECIES, "2025-05-01T10:00:01Z", same);
    const { galleryRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, SPECIES_2]]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("lists groups largest first, with their species, span and previews", async () => {
    const { status, body } = await get("/gallery/similar");
    expect(status).toBe(200);
    expect(body.total).toBe(2);
    expect(body.groups.map((g: { count: number }) => g.count)).toEqual([3, 2]);
    const [burst, pair] = body.groups;
    expect(burst).toMatchObject({
      captureId: ids.b1,
      speciesId: SPECIES,
      commonName: "Burst Wren",
      firstTakenAt: "2025-05-01T10:00:00.000Z",
      lastTakenAt: "2025-05-01T10:00:02.000Z",
    });
    expect(burst.previewPhotoIds).toHaveLength(3);
    expect(pair.captureId).toBe(ids.p1);
  });

  it("pages through the groups", async () => {
    const { body } = await get("/gallery/similar?limit=1&offset=1");
    expect(body.total).toBe(2);
    expect(body.groups.map((g: { captureId: string }) => g.captureId)).toEqual([ids.p1]);
  });

  it("scopes the Gallery to a photo's group, whatever the RAW and video presets", async () => {
    const { status, body } = await get(`/gallery?similarTo=${ids.b2}&includeRaw=0&excludeVideo=1`);
    expect(status).toBe(200);
    expect(body.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual([ids.b1, ids.b2, ids.b3].sort());
    expect(body.total).toBe(3);
    const idsRes = await get(`/gallery/ids?similarTo=${ids.b3}`);
    expect(idsRes.body.captureIds).toHaveLength(3);
  });

  it("shows only the photo itself when nothing is near-identical", async () => {
    for (const name of ["lone", "noVector", "scene"]) {
      const { body } = await get(`/gallery?similarTo=${ids[name]}`);
      expect(body.items.map((i: { captureId: string }) => i.captureId)).toEqual([ids[name]]);
    }
  });

  it("never reaches another user's photo", async () => {
    const { body } = await get(`/gallery?similarTo=${ids.otherUser}`);
    expect(body.items).toEqual([]);
  });

  it("drops a hidden photo from its group", async () => {
    await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [ids.b2]);
    try {
      const { body } = await get(`/gallery?similarTo=${ids.b1}`);
      // b1 and b3 still match each other directly.
      expect(body.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual([ids.b1, ids.b3].sort());
    } finally {
      await db.query(`UPDATE captures_all SET hidden_at = NULL WHERE id = $1`, [ids.b2]);
    }
  });

  it("keeps a dismissed group gone, and undo brings it back", async () => {
    const send = (method: "POST" | "DELETE", payload: object) =>
      app.inject({ method, url: "/api/gallery/similar/dismiss", payload });
    const done = (await send("POST", { captureId: ids.p1 })).json();
    expect(done.captureIds.sort()).toEqual([ids.p1, ids.p2].sort());
    expect((await get("/gallery/similar")).body.groups.map((g: { captureId: string }) => g.captureId)).toEqual([
      ids.b1,
    ]);
    expect((await get(`/gallery?similarTo=${ids.p1}`)).body.items).toHaveLength(1);
    // Asking again changes nothing.
    await send("POST", { captureId: ids.p2 });
    expect((await send("DELETE", { captureIds: done.captureIds })).json()).toEqual({ ok: true });
    expect((await get("/gallery/similar")).body.total).toBe(2);
  });
});
