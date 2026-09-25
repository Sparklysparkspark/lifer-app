// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run integrations
// Exercises the integration endpoints over HTTP with a real API key, the way a script would.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000107";
const SPECIES_A = "cccccccc-0000-4000-8000-00000000000a";
const SPECIES_B = "cccccccc-0000-4000-8000-00000000000b";
const TOKEN = "lifer_test_integration_token_107";

describe.skipIf(!url)("integration endpoints (API key)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const captures: string[] = [];

  const get = (path: string, token = TOKEN) => app.inject({ method: "GET", url: path, headers: { "x-api-key": token } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    // API keys only apply in server mode (in desktop mode every request is the local user), and
    // the repo's dev .env turns desktop mode on; dotenv never overrides a variable already set.
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { integrationRoutes } = await import("./routes.js");
    const { photoRoutes } = await import("../photos/routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'integrations@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 910701, 'Testus alpha', 'Alpha Bird', 'aves'), ($2, 910702, 'Testus beta', 'Beta Fox', 'mammalia')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES_A, SPECIES_B],
    );
    for (const [i, sp] of [SPECIES_A, SPECIES_B].entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, quality_rating) VALUES ($1, $2, $3, now() - interval '1 day', 3) RETURNING id`,
        [USER, sp, `integration-${i}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', $2, true, 'abc', 1234)`,
        [c.rows[0].id, `/library/Birds/IMG_000${i}.jpg`],
      );
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected) VALUES ($1, $2, 'collected', $3, CURRENT_DATE)`,
        [USER, sp, p.rows[0].id],
      );
      captures.push(c.rows[0].id);
    }
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.read", "collection.read"],
    ]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'narrow', $2, $3)`, [
      USER,
      hashApiKey(`${TOKEN}_narrow`),
      ["stats.read"],
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(integrationRoutes, { prefix: "/api" });
    await app.register(photoRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id IN ($1, $2)`, [SPECIES_A, SPECIES_B]);
    await db.end();
    const { pool } = await import("../db.js");
    await pool.end();
  });

  it("lists photos with species, originals for matching, and image links", async () => {
    const res = await get("/api/captures");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    const a = body.items.find((i: { speciesId: string }) => i.speciesId === SPECIES_A);
    expect(a.commonName).toBe("Alpha Bird");
    expect(a.originals.jpeg).toEqual({ fileName: "IMG_0000.jpg", sizeBytes: 1234, sha256: "abc" });
    expect(a.images.thumb).toBe(`/api/photos/${a.photoId}/thumb`);
    expect(body.nextCursor).toBeNull();
    // Full microsecond precision, so it round-trips exactly as `since`.
    expect(a.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  });

  it("pages with a cursor and returns only what changed with since", async () => {
    const first = (await get("/api/captures?limit=1")).json();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await get(`/api/captures?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.items).toHaveLength(1);
    expect(second.items[0].captureId).not.toBe(first.items[0].captureId);

    const mark = second.items[0].updatedAt;
    await new Promise((ok) => setTimeout(ok, 20));
    await db.query(`UPDATE captures_all SET quality_rating = 5 WHERE id = $1`, [captures[0]]);
    const changed = (await get(`/api/captures?since=${encodeURIComponent(mark)}`)).json();
    expect(changed.items.map((i: { captureId: string }) => i.captureId)).toEqual([captures[0]]);
    expect(changed.items[0].rating).toBe(5);
  });

  it("summarizes the life list", async () => {
    const res = await get("/api/life-list/summary");
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.photographedSpecies).toBe(2);
    expect(s.photos).toBe(2);
    expect(s.byTaxonClass).toEqual({ aves: 1, mammalia: 1 });
    expect(s.latestLifer.speciesId).toBeTruthy();
    const list = (await get("/api/life-list?taxonClass=aves")).json();
    expect(list.species.map((x: { scientificName: string }) => x.scientificName)).toEqual(["Testus alpha"]);
    expect(list.species[0].photoCount).toBe(1);
  });

  it("lets a photos.read key fetch images (404 here only because the test file doesn't exist)", async () => {
    const item = (await get("/api/captures")).json().items[0];
    expect((await get(item.images.thumb)).statusCode).toBe(404);
    expect((await get(item.images.thumb, `${TOKEN}_narrow`)).statusCode).toBe(401);
  });

  it("refuses a key without the scope, or no key", async () => {
    expect((await get("/api/captures", `${TOKEN}_narrow`)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/life-list/summary" })).statusCode).toBe(401);
  });
});
