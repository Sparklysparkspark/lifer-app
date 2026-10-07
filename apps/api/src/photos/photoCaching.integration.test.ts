// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run photoCaching
// Conditional requests on photo files, and a missing rendition served from its sibling.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const dirs = vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const base = `${process.env.TMPDIR ?? "/tmp"}/lifer-photocache-${process.pid}`;
  process.env.APP_DATA_DIR = `${base}/app`;
  return { base };
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000511";
const SPECIES = "ffffffff-0000-4000-8000-0000000005a1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "pc@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("photo file caching", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let photoId: string;
  let brokenPhotoId: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-photos-"));
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pc@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 913500, 'Cachea photo', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    const webp = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a6" } })
      .webp()
      .toBuffer();
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: "#3a6" } })
      .jpeg()
      .toBuffer();
    writeFileSync(path.join(dir, "d.webp"), webp);
    writeFileSync(path.join(dir, "t.webp"), webp);
    writeFileSync(path.join(dir, "orig.jpg"), jpeg);
    writeFileSync(path.join(dir, "clip.mp4"), Buffer.alloc(4096, 7));
    const add = async (fp: string, thumb: string) => {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, fp],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path, preview_path) VALUES ($1, $2, $3, $4) RETURNING id`,
        [c.rows[0].id, path.join(dir, "d.webp"), thumb, path.join(dir, "clip.mp4")],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', $2, false, 'h', 1)`,
        [c.rows[0].id, path.join(dir, "orig.jpg")],
      );
      return p.rows[0].id;
    };
    photoId = await add("pc-1", path.join(dir, "t.webp"));
    brokenPhotoId = await add("pc-2", path.join(dir, "gone.webp"));
    // The first photo doubles as a video, so /video serves its preview_path.
    await db.query(`UPDATE photos SET kind = 'video' WHERE id = $1`, [photoId]);
    const { photoRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(photoRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dirs.base, { recursive: true, force: true });
  });

  const get = (u: string, headers: Record<string, string> = {}) =>
    app.inject({ method: "GET", url: `/api${u}`, headers });

  it("answers 304 for an unchanged thumbnail and original", async () => {
    for (const u of [`/photos/${photoId}/thumb`, `/photos/${photoId}/original`]) {
      const first = await get(u);
      expect(first.statusCode).toBe(200);
      expect(first.headers["last-modified"]).toBeTruthy();
      const again = await get(u, { "if-none-match": first.headers.etag as string });
      expect(again.statusCode).toBe(304);
      expect(again.body).toBe("");
    }
  });

  it("serves video ranges, with 304 and If-Range", async () => {
    const full = await get(`/photos/${photoId}/video`);
    expect(full.statusCode).toBe(200);
    const etag = full.headers.etag as string;
    expect((await get(`/photos/${photoId}/video`, { "if-none-match": etag })).statusCode).toBe(304);
    const part = await get(`/photos/${photoId}/video`, { range: "bytes=0-99", "if-range": etag });
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-length"]).toBe("100");
    const stale = await get(`/photos/${photoId}/video`, { range: "bytes=0-99", "if-range": '"stale"' });
    expect(stale.statusCode).toBe(200);
  });

  it("shows the display image in place of a missing thumbnail and repairs it behind", async () => {
    const res = await get(`/photos/${brokenPhotoId}/thumb`);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers.etag).toBeUndefined();
    // The repair rebuilds both files from the JPEG original and repoints the row.
    for (let i = 0; i < 50; i++) {
      const row = await db.query<{ thumb_path: string }>(`SELECT thumb_path FROM photos WHERE id = $1`, [
        brokenPhotoId,
      ]);
      if (!row.rows[0].thumb_path.endsWith("gone.webp")) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const healed = await get(`/photos/${brokenPhotoId}/thumb`);
    expect(healed.statusCode).toBe(200);
    expect(healed.headers.etag).toBeTruthy();
  });

  it("answers 404 for a malformed photo id, as for an unknown one", async () => {
    const expected: Record<string, string> = {
      "/photos/nope/thumb": "Photo not found",
      "/photos/nope/medium": "Photo not found",
      "/photos/nope/original": "Original not found",
      "/photos/nope/original-raw": "No RAW original for this photo",
      "/photos/nope/video": "No video for this photo",
    };
    for (const [u, error] of Object.entries(expected)) {
      const res = await get(u);
      expect([u, res.statusCode, res.json()]).toEqual([u, 404, { error }]);
    }
  });

  it("serves the owner's trashed and hidden photos, for the Trash page and the Hidden filter", async () => {
    const trashed = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, deleted_at) VALUES ($1, $2, 'pc-trashed', now()) RETURNING id`,
      [USER, SPECIES],
    );
    const hidden = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, hidden_at) VALUES ($1, $2, 'pc-hidden', now()) RETURNING id`,
      [USER, SPECIES],
    );
    const ids: string[] = [];
    for (const c of [trashed.rows[0].id, hidden.rows[0].id]) {
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path, preview_path, kind) VALUES ($1, $2, $3, $4, 'video') RETURNING id`,
        [c, path.join(dir, "d.webp"), path.join(dir, "t.webp"), path.join(dir, "clip.mp4")],
      );
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', $2, false, 'h', 1)`,
        [c, path.join(dir, "orig.jpg")],
      );
      ids.push(p.rows[0].id);
    }
    for (const id of ids) {
      for (const kind of ["thumb", "display", "medium", "video", "original"]) {
        const res = await get(`/photos/${id}/${kind}`);
        expect([id, kind, res.statusCode]).toEqual([id, kind, 200]);
      }
    }
  });

  it("only accepts 0 or 1 for download", async () => {
    const bad = await get(`/photos/${photoId}/original?download=yes`);
    expect([bad.statusCode, bad.json()]).toEqual([
      400,
      { error: "Invalid query: download must be one of 0, 1", code: "invalid_request" },
    ]);
    const inline = await get(`/photos/${photoId}/original?download=0`);
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-disposition"]).toBeUndefined();
    const download = await get(`/photos/${photoId}/original?download=1`);
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toMatch(/^attachment/);
  });
});
