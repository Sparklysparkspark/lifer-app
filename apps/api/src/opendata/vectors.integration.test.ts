// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The open reference vector routes: only CC0, Public Domain Mark and CC BY vectors, with credits.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000801";
const SP = "cccccccc-0000-4000-8000-0000000008a0";
const TOKEN = "lifer_test_opendata_vectors_801";
// Licence as tagged on the vector; null means never tagged.
const SEEDED: [string, string | null][] = [
  ["open-cc0", "cc0"],
  ["open-ccby", "CC-BY-4.0"],
  ["open-pd", "pd"],
  ["closed-nc", "cc-by-nc"],
  ["closed-sa", "cc-by-sa"],
  ["closed-nd", "cc-by-nc-nd-4.0"],
  ["closed-untagged", null],
];

describe.skipIf(!url)("opendata open vectors (API key)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const get = (p: string) => app.inject({ method: "GET", url: p, headers: { "x-api-key": TOKEN } });

  // Every page, keeping only this test's rows (other tests may seed vectors too).
  async function all(path: string) {
    const items: Record<string, unknown>[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const res = await get(`${path}${path.includes("?") ? "&" : "?"}limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      expect(res.statusCode).toBe(200);
      const body = res.json() as { items: Record<string, unknown>[]; nextCursor: string | null };
      items.push(...body.items.filter((it) => it.speciesId === SP));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return items;
  }

  async function cleanup() {
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SP]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    const { CLIP_SPACE } = await import("@lifer/core/species/embeddings.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'opendata-vectors@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 970801, 'Vectorus apertus', 'Open Vector Bird', 'aves')`,
      [SP],
    );
    const vec = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    for (const [name, license] of SEEDED) {
      const photo = await db.query<{ id: string }>(
        `INSERT INTO species_reference_photos (species_id, photo_url, credit, license) VALUES ($1, $2, 'Photo Credit', $3) RETURNING id`,
        [SP, `https://x/${name}.jpg`, license ?? "cc-by"],
      );
      await db.query(
        `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version, license, photographer, source_url)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          photo.rows[0].id,
          SP,
          vec,
          CLIP_SPACE.modelVersion,
          license,
          name === "open-cc0" ? "Vector Tagged Name" : null,
          name === "open-cc0" ? `https://x/${name}` : null,
        ],
      );
    }
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'k', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["opendata.read"],
    ]);
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("serves only openly licensed gallery vectors, across pages", async () => {
    const items = await all("/api/opendata/v1/gallery-vectors");
    expect(items.map((i) => i.photoUrl).sort()).toEqual(
      ["https://x/open-cc0.jpg", "https://x/open-ccby.jpg", "https://x/open-pd.jpg"].sort(),
    );
    const cc0 = items.find((i) => i.license === "cc0")!;
    expect(cc0).toMatchObject({
      scientificName: "Vectorus apertus",
      photographer: "Vector Tagged Name",
      sourceUrl: "https://x/open-cc0",
    });
    expect((cc0.embedding as number[]).length).toBe(768);
    expect(items.find((i) => i.license === "pd")).toMatchObject({
      photographer: "Photo Credit",
      sourceUrl: "https://x/open-pd.jpg",
    });

    const later = await get(`/api/opendata/v1/gallery-vectors?since=${encodeURIComponent(cc0.updatedAt as string)}`);
    expect(later.statusCode).toBe(200);
    expect((await get("/api/opendata/v1/gallery-vectors?space=other-model")).statusCode).toBe(409);
    expect((await get("/api/opendata/v1/gallery-vectors?cursor=bogus")).statusCode).toBe(400);
  });

  it("credits the same open vectors without the vectors", async () => {
    const items = await all("/api/opendata/v1/attribution");
    expect(items.map((i) => i.license).sort()).toEqual(["CC-BY-4.0", "cc0", "pd"]);
    for (const i of items) {
      expect(i).not.toHaveProperty("embedding");
      expect(i.photographer).toBeTruthy();
      expect(i.sourceUrl).toBeTruthy();
    }
  });
});
