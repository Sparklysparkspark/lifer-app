// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A file name typed into search finds just the photos with that file, exact names first.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000611";
const SPECIES = "ffffffff-0000-4000-8000-0000000006a1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "filename@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("GET /gallery/search by file name", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: Record<string, string> = {};

  const search = async (q: string) => {
    const res = await app.inject({ method: "GET", url: `/api/gallery/search?q=${encodeURIComponent(q)}&quick=1` });
    expect(res.statusCode).toBe(200);
    return res.json() as { items: Array<{ captureId: string }>; pending: boolean };
  };
  const found = async (q: string) => (await search(q)).items.map((i) => i.captureId);

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'filename@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 912601, 'Nomen fili', 'File Warbler', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    const files: Record<string, { ref: string; kind: string }> = {
      group: { ref: "/lib/Warbler/6F9A8042.jpg", kind: "jpeg" },
      raw: { ref: "C:\\Photos\\RAW\\6F9A8042.CR3", kind: "raw" },
      edit: { ref: "/lib/Warbler/6F9A8042-Edit.jpg", kind: "jpeg" },
      near: { ref: "/lib/Warbler/6F9A8045.JPG", kind: "jpeg" },
      other: { ref: "/lib/Warbler/IMG_0001.jpg", kind: "jpeg" },
    };
    for (const [key, f] of Object.entries(files)) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, hidden_at)
         VALUES ($1, $2, $3, '2024-05-01T10:00:00Z', $4) RETURNING id`,
        [USER, SPECIES, `filename-${key}`, key === "raw" ? new Date().toISOString() : null],
      );
      ids[key] = c.rows[0].id;
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [ids[key]],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, ids[key]]);
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, false, $5, 1000)`,
        [USER, ids[key], f.kind, f.ref, `filename-hash-${key}`],
      );
    }
    // The RAW is a linked version, hidden behind the group's photo.
    await db.query(
      `INSERT INTO capture_versions (capture_id, group_capture_id, user_id, evidence, state, hid_capture)
       VALUES ($1, $2, $3, 'manual', 'linked', true)`,
      [ids.raw, ids.group, USER],
    );
    const { galleryRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("finds the group's photo from a linked RAW's exact name, and nothing else", async () => {
    const res = await search("6F9A8042.CR3");
    expect(res.items.map((i) => i.captureId)).toEqual([ids.group]);
    expect(res.pending).toBe(false);
  });

  it("matches a stem without its extension, exact names above longer ones", async () => {
    expect(await found("6f9a8042")).toEqual([ids.group, ids.edit]);
  });

  it("matches a partial stem by prefix", async () => {
    // In file name order: "6f9a8042-edit" sorts before "6f9a8042.cr3".
    expect(await found("6F9A804")).toEqual([ids.edit, ids.group, ids.near]);
    expect(await found("img_0001")).toEqual([ids.other]);
  });

  it("falls back to the normal search when no file has the name", async () => {
    expect(await found("ZZ9Z9999.CR3")).not.toContain(ids.near);
    expect(await found("file warbler")).toHaveLength(4);
  });
});
