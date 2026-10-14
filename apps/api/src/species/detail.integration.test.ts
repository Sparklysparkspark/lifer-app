// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run species/detail
// GET /species/:id never hands out the server's cached image paths; images go by URL or id.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000611";
const SPECIES = "ffffffff-0000-4000-8000-000000000620";
const CACHE_DIR = "/lifer-test-cache";
const ORIGINAL = "/Users/someone/Pictures/heron.jpg";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "detail@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

// Every string that looks like a filesystem path, with the key it sits under.
function absolutePaths(value: unknown, key = ""): Array<{ key: string; value: string }> {
  if (typeof value === "string") return value.startsWith("/") && !value.startsWith("/api/") ? [{ key, value }] : [];
  if (Array.isArray(value)) return value.flatMap((v) => absolutePaths(v, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => absolutePaths(v, k));
  return [];
}

describe.skipIf(!url)("GET /species/:id", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  const cleanup = async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  };

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'detail@test', 'x')`, [USER]);
    // Already enriched with its gallery, so the page makes no live calls.
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, enriched_at, gallery_backfilled_at,
         reference_photo, reference_credit, reference_license, reference_display_path, reference_thumb_path)
       VALUES ($1, 916100, 'Ardea testis', 'aves', now(), now(), 'https://static.inaturalist.org/p.jpg', 'someone',
         'cc-by', $2, $3)`,
      [SPECIES, `${CACHE_DIR}/ref.webp`, `${CACHE_DIR}/ref-thumb.webp`],
    );
    await db.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path)
       VALUES ($1, 'https://static.inaturalist.org/g.jpg', 'someone', 'cc-by', 0, $2, $3)`,
      [SPECIES, `${CACHE_DIR}/gallery.webp`, `${CACHE_DIR}/gallery-thumb.webp`],
    );
    const capture = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, 'species-detail-1', now()) RETURNING id`,
      [USER, SPECIES],
    );
    const photo = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $3) RETURNING id`,
      [capture.rows[0].id, `${CACHE_DIR}/d.webp`, `${CACHE_DIR}/t.webp`],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [
      photo.rows[0].id,
      capture.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size)
       VALUES ($1, 'jpeg', 'path', $2, false, $3, 'species-detail-1', 1)`,
      [capture.rows[0].id, ORIGINAL, USER],
    );

    const { speciesDetailRoutes } = await import("./detail.js");
    app = Fastify();
    await app.register(async (api) => api.register(speciesDetailRoutes), { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("returns images as URLs and ids, never cached file paths", async () => {
    const res = await app.inject({ method: "GET", url: `/api/species/${SPECIES}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(res.body).not.toContain(CACHE_DIR);
    expect(res.body).not.toMatch(/"[a-z_]*(display|thumb|relative)_path"/);
    // The only paths are the user's own original file, which the page reveals and copies.
    expect(absolutePaths(body)).toEqual([{ key: "original_ref", value: ORIGINAL }]);

    expect(body.species.reference_photo_url).toMatch(/^\/api\/species\/.+\/reference-photo\/display/);
    expect(body.referencePhotos[0].photo_url).toMatch(/^\/api\/species\/reference-gallery-photo\//);
    expect(body.captures[0].photo_id).toEqual(expect.any(String));
  });
});
