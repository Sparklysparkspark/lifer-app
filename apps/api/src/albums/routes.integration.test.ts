// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Album routes validate their input before touching the database: malformed ids answer 404 like
// unknown ones, and malformed bodies a 400 naming the problem, while the web app's requests work.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000601";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000060a";
const NO_SUCH = "eeeeeeee-0000-4000-8000-0000000006ff";
const TOKEN = "lifer_test_album_routes_owner_601";
const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("album routes input validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let albumId: string;
  let captureId: string;
  let photoId: string;

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-album-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { albumRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'album-routes@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 920601, 'Testus albumus', 'Album Bird', 'aves')`,
      [SPECIES],
    );
    captureId = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, 'album-routes-1') RETURNING id`,
        [OWNER, SPECIES],
      )
    ).rows[0].id;
    photoId = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [captureId],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);

    app = Fastify();
    await app.register(cookie);
    await app.register(albumRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates an album from the web app's body, and refuses wrong types and extra fields", async () => {
    const created = await call("POST", "/api/albums", { name: "Shorebirds" });
    expect(created.statusCode).toBe(200);
    albumId = created.json().id;
    // The collections page sends no name for an "Untitled Album".
    expect((await call("POST", "/api/albums", {})).statusCode).toBe(200);

    const wrongType = await call("POST", "/api/albums", { name: 42 });
    expect([wrongType.statusCode, wrongType.json()]).toEqual([400, invalid(/^Invalid body: name must be string$/)]);
    const extra = await call("POST", "/api/albums", { name: "x", owner: OWNER });
    expect([extra.statusCode, extra.json()]).toEqual([400, invalid(/unexpected field owner/)]);
  });

  it("answers a malformed album id like an unknown one", async () => {
    for (const id of ["nope", NO_SUCH]) {
      const res = await call("GET", `/api/albums/${id}`);
      expect([id, res.statusCode, res.json()]).toEqual([id, 404, { error: "Album not found" }]);
    }
    const res = await call("DELETE", `/api/albums/${albumId}/captures/not-a-capture`);
    expect([res.statusCode, res.json()]).toEqual([404, { error: "Album not found" }]);
  });

  it("adds captures only as a non-empty list of ids", async () => {
    const add = (body: unknown) => call("POST", `/api/albums/${albumId}/captures`, body);
    expect((await add({})).json()).toEqual(invalid(/captureIds is required/));
    expect((await add({ captureIds: [] })).statusCode).toBe(400);
    expect((await add({ captureIds: ["nope"] })).json()).toEqual(invalid(/captureIds\.0 must be an id/));
    expect((await add({ captureIds: captureId })).statusCode).toBe(400);

    const ok = await add({ captureIds: [captureId] });
    expect([ok.statusCode, ok.json()]).toEqual([200, { ok: true }]);
    expect((await call("GET", `/api/albums/${albumId}`)).json().items).toHaveLength(1);
  });

  it("updates an album with known fields and refuses an unknown cover layout", async () => {
    const patch = (body: unknown) => call("PATCH", `/api/albums/${albumId}`, body);
    expect((await patch({ coverLayout: "grid" })).json()).toEqual(invalid(/coverLayout must be one of single, quad/));
    expect((await patch({ coverPhotoId: "nope" })).statusCode).toBe(400);
    expect((await patch({ description: null })).statusCode).toBe(200);
    const ok = await patch({ coverPhotoId: photoId, coverLayout: "quad", name: "Waders" });
    expect([ok.statusCode, ok.json()]).toMatchObject([200, { name: "Waders", coverLayout: "quad" }]);
  });

  it("keeps crops within 0-100 and quad slots within 0-3", async () => {
    const crop = (body: unknown) => call("PATCH", `/api/albums/${albumId}/cover-crop`, body);
    expect((await crop({ x: 10, y: 10, size: 101 })).json()).toEqual(invalid(/size must be <= 100/));
    expect((await crop({ x: -1, y: 10, size: 50 })).statusCode).toBe(400);
    expect((await crop({ x: 10, y: 10, size: 0 })).statusCode).toBe(400);
    expect((await crop({ x: 10, y: 10, size: 50 })).json()).toEqual({ ok: true });
    expect((await crop({ reset: true })).json()).toEqual({ ok: true });

    const slot = (body: unknown) => call("PATCH", `/api/albums/${albumId}/quad-slot`, body);
    expect((await slot({ slot: 4, photoId })).json()).toEqual(invalid(/slot must be <= 3/));
    expect((await slot({ slot: 1.5, photoId })).statusCode).toBe(400);
    expect((await slot({ photoId })).json()).toEqual(invalid(/slot is required/));
    expect((await slot({ slot: 0, crop: { x: 1, y: 1, size: 200 } })).statusCode).toBe(400);
    // What AlbumDetailPage sends: a photo, a photo with its crop, and a crop reset.
    expect((await slot({ slot: 0, photoId })).json()).toEqual({ ok: true });
    expect((await slot({ slot: 0, photoId, crop: { x: 5, y: 5, size: 90 } })).json()).toEqual({ ok: true });
    expect((await slot({ slot: 0, crop: null })).json()).toEqual({ ok: true });
  });
});
