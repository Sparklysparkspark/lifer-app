// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Album routes validate their input before touching the database: malformed ids answer 404 like
// unknown ones, and malformed bodies a 400 naming the problem, while the web app's requests work.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The detector finds the animal here in every photo, so default crops are predictable.
vi.mock("../species/detectAndCrop.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../species/detectAndCrop.js")>()),
  detectDefaultCardCrop: async () => ({ x: 20, y: 30, size: 40 }),
}));

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

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [`pinned_filters:${OWNER}`]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [OWNER]);
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
    const { pinnedFilterRoutes } = await import("./pinnedFilters.js");
    const { changeRoutes } = await import("../changes/routes.js");

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
    await app.register(pinnedFilterRoutes, { prefix: "/api" });
    await app.register(changeRoutes, { prefix: "/api" });
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

  it("limits album names to 255 characters on create and rename", async () => {
    const ok = await call("POST", "/api/albums", { name: "a".repeat(255) });
    expect(ok.statusCode).toBe(200);
    const long = await call("POST", "/api/albums", { name: "a".repeat(256) });
    expect([long.statusCode, long.json().error]).toEqual([400, "Names can be at most 255 characters"]);
    const id = ok.json().id;
    expect((await call("PATCH", `/api/albums/${id}`, { name: "b".repeat(255) })).statusCode).toBe(200);
    expect((await call("PATCH", `/api/albums/${id}`, { name: "b".repeat(256) })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/albums/${id}`, { name: "  " })).statusCode).toBe(400);
    // A stored name over the limit still lists and shows.
    await db.query(`UPDATE albums SET name = $2 WHERE id = $1`, [id, "c".repeat(600)]);
    expect((await call("GET", `/api/albums/${id}`)).json().name).toHaveLength(600);
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

  it("keeps pinned filters as upgraded rules, in order, and refuses bad ones", async () => {
    expect((await call("GET", "/api/pinned-filters")).json()).toEqual({ pins: [] });
    const pins = [
      { id: "a", name: " Flight ", rules: { version: 1, query: { regionId: NO_SUCH } } },
      { id: "b", name: "Stars", rules: { version: 2, query: { ratingMin: "3" } } },
    ];
    const saved = await call("PUT", "/api/pinned-filters", { pins });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().pins[0]).toMatchObject({
      name: "Flight",
      rules: { version: 2, query: { regionId: [NO_SUCH] } },
    });
    expect((await call("GET", "/api/pinned-filters")).json().pins.map((p: { id: string }) => p.id)).toEqual(["a", "b"]);
    expect((await call("PUT", "/api/pinned-filters", { pins: [pins[0], pins[0]] })).statusCode).toBe(400);
    expect((await call("PUT", "/api/pinned-filters", { pins: [{ ...pins[0], name: "" }] })).statusCode).toBe(400);
  });

  it("undoes the newest recorded change once, then has nothing left to undo", async () => {
    const album = (await call("POST", "/api/albums", { name: "Assistant album" })).json().id;
    await call("POST", `/api/albums/${album}/captures`, { captureIds: [captureId] });
    const undo = [{ op: "removeFromAlbum", albumId: album, captureIds: [captureId] }];
    expect((await call("POST", "/api/changes", { summary: "Added a photo", undo })).statusCode).toBe(200);
    expect((await call("POST", "/api/changes", { summary: "x", undo: [{ op: "dropTable" }] })).statusCode).toBe(400);

    const first = await call("POST", "/api/changes/undo-last");
    expect(first.json().undone).toMatchObject({ summary: "Added a photo" });
    const members = await db.query(`SELECT 1 FROM album_captures WHERE album_id = $1`, [album]);
    expect(members.rowCount).toBe(0);
    expect((await call("POST", "/api/changes/undo-last")).json()).toEqual({ undone: null });
    expect((await call("GET", "/api/changes")).json().changes[0]).toMatchObject({ summary: "Added a photo" });
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

  it("lists albums and their species with every field the web app reads", async () => {
    await call("PATCH", `/api/albums/${albumId}/cover-crop`, { x: 10, y: 20, size: 50 });
    await call("PATCH", `/api/albums/${albumId}/quad-slot`, { slot: 0, photoId, crop: { x: 5, y: 5, size: 90 } });
    const { albums } = (await call("GET", "/api/albums")).json();
    const listed = albums.find((a: { id: string }) => a.id === albumId);
    expect(listed).toEqual({
      id: albumId,
      name: "Waders",
      description: null,
      coverPhotoId: photoId,
      coverLayout: "quad",
      coverCropX: 10,
      coverCropY: 20,
      coverCropSize: 50,
      quadSlots: [{ photoId, cropX: 5, cropY: 5, cropSize: 90 }, null, null, null],
      createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      rules: null,
      captureCount: 1,
    });
    const detail = (await call("GET", `/api/albums/${albumId}`)).json();
    expect(detail).toMatchObject({ id: albumId, coverPhotoId: photoId, quadSlots: listed.quadSlots });
    expect(detail.items[0]).toMatchObject({ captureId, photoId, scientificName: "Testus albumus", tags: [] });
    const species = (await call("GET", `/api/albums/${albumId}/species`)).json();
    expect(species.items).toEqual([
      expect.objectContaining({ speciesId: SPECIES, scientificName: "Testus albumus", commonName: "Album Bird" }),
    ]);
  });

  // Remembered state (docs/docs/contributing/remembered-state.md): a picked cover in the Trash.
  it("lets a picked cover in the Trash fall back, without its crop, and come back on restore", async () => {
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [captureId]);
    try {
      const detail = await call("GET", `/api/albums/${albumId}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json()).toMatchObject({ coverPhotoId: null, coverPicked: false, coverCropX: null, items: [] });
      const { albums } = (await call("GET", "/api/albums")).json();
      expect(albums.find((a: { id: string }) => a.id === albumId)).toMatchObject({ coverPhotoId: null });
    } finally {
      await db.query(`UPDATE captures_all SET deleted_at = NULL WHERE id = $1`, [captureId]);
    }
    expect((await call("GET", `/api/albums/${albumId}`)).json()).toMatchObject({
      coverPhotoId: photoId,
      coverPicked: true,
    });
  });

  it("frames an uncropped cover and tile on the animal, never over the user's crop", async () => {
    const displayPath = path.join(dataDir, "framed.webp");
    writeFileSync(displayPath, "photo");
    const capture = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, 'album-routes-2') RETURNING id`,
        [OWNER, SPECIES],
      )
    ).rows[0].id;
    const photo = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, '/nowhere/t.webp') RETURNING id`,
        [capture, displayPath],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photo, capture]);
    const id = (await call("POST", "/api/albums", { name: "Raptors" })).json().id;
    await call("POST", `/api/albums/${id}/captures`, { captureIds: [capture] });
    await call("PATCH", `/api/albums/${id}`, { coverLayout: "quad" });

    const detected = { photoId: photo, cropX: 20, cropY: 30, cropSize: 40 };
    // Detection runs after the first load answers.
    await vi.waitFor(async () =>
      expect((await call("GET", `/api/albums/${id}`)).json()).toMatchObject({
        coverPhotoId: photo,
        coverCropX: 20,
        coverCropY: 30,
        coverCropSize: 40,
        quadSlots: [detected, null, null, null],
      }),
    );
    const listed = (await call("GET", "/api/albums")).json().albums.find((a: { id: string }) => a.id === id);
    expect(listed).toMatchObject({ coverCropX: 20, quadSlots: [detected, null, null, null] });

    await call("PATCH", `/api/albums/${id}/quad-slot`, { slot: 0, photoId: photo, crop: { x: 5, y: 5, size: 90 } });
    expect((await call("GET", `/api/albums/${id}`)).json().quadSlots[0]).toEqual({
      photoId: photo,
      cropX: 5,
      cropY: 5,
      cropSize: 90,
    });
    await call("PATCH", `/api/albums/${id}/quad-slot`, { slot: 0, crop: null });
    expect((await call("GET", `/api/albums/${id}`)).json().quadSlots[0]).toEqual(detected);
  });

  it("shows each species by the album's own best photo, framed on the animal", async () => {
    const photoFor = async (fingerprint: string, rating: number | null, displayPath = "/nowhere/d.webp") => {
      const capture = (
        await db.query<{ id: string }>(
          `INSERT INTO captures (user_id, species_id, fingerprint, quality_rating) VALUES ($1, $2, $3, $4) RETURNING id`,
          [OWNER, SPECIES, fingerprint, rating],
        )
      ).rows[0].id;
      const photo = (
        await db.query<{ id: string }>(
          `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, '/nowhere/t.webp') RETURNING id`,
          [capture, displayPath],
        )
      ).rows[0].id;
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photo, capture]);
      return { capture, photo };
    };
    const displayPath = path.join(dataDir, "best.webp");
    writeFileSync(displayPath, "photo");
    const unrated = await photoFor("album-species-unrated", null);
    const best = await photoFor("album-species-best", 4, displayPath);
    const lower = await photoFor("album-species-lower", 2);
    // The species' featured photo is outside the album and has the user's crop.
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected, card_crop_x, card_crop_y, card_crop_size)
       VALUES ($1, $2, 'collected', $3, CURRENT_DATE, 1, 2, 3)
       ON CONFLICT (user_id, species_id) DO UPDATE SET state = 'collected', cover_photo_id = $3,
         card_crop_x = 1, card_crop_y = 2, card_crop_size = 3`,
      [OWNER, SPECIES, photoId],
    );
    const id = (await call("POST", "/api/albums", { name: "Best of" })).json().id;
    for (const c of [unrated, best, lower])
      await call("POST", `/api/albums/${id}/captures`, { captureIds: [c.capture] });

    await vi.waitFor(async () =>
      expect((await call("GET", `/api/albums/${id}/species`)).json().items).toEqual([
        expect.objectContaining({
          speciesId: SPECIES,
          coverPhotoUrl: `/api/photos/${best.photo}/thumb`,
          cardCropX: 20,
          cardCropY: 30,
          cardCropSize: 40,
        }),
      ]),
    );

    // Unrated photos tie, so the first in the album's order (newest added) wins.
    const ties = (await call("POST", "/api/albums", { name: "Ties" })).json().id;
    for (const c of [unrated, lower])
      await db.query(`UPDATE captures_all SET quality_rating = NULL WHERE id = $1`, [c.capture]);
    await call("POST", `/api/albums/${ties}/captures`, { captureIds: [unrated.capture] });
    await call("POST", `/api/albums/${ties}/captures`, { captureIds: [lower.capture] });
    const [tied] = (await call("GET", `/api/albums/${ties}/species`)).json().items;
    expect(tied.coverPhotoUrl).toBe(`/api/photos/${lower.photo}/thumb`);
    // The user's crop belongs to their featured photo, so it doesn't carry over.
    expect(tied.cardCropX).not.toBe(1);
  });

  it("puts many left-out photos back at once", async () => {
    const id = (await call("POST", "/api/albums", { name: "Smart" })).json().id;
    await db.query(`UPDATE albums SET rules = '{"query":{}}' WHERE id = $1`, [id]);
    const excluded = (await db.query<{ id: string }>(`SELECT id FROM captures WHERE user_id = $1`, [OWNER])).rows.map(
      (r) => r.id,
    );
    expect(excluded.length).toBeGreaterThan(1);
    await call("POST", `/api/albums/${id}/exclusions`, { captureIds: excluded });
    expect((await call("GET", `/api/albums/${id}/exclusions`)).json().items).toHaveLength(excluded.length);

    const restore = (body: unknown) => call("POST", `/api/albums/${id}/exclusions/restore`, body);
    expect((await restore({ captureIds: [] })).statusCode).toBe(400);
    expect((await restore({ captureIds: excluded })).json()).toEqual({ ok: true });
    expect((await call("GET", `/api/albums/${id}/exclusions`)).json().items).toEqual([]);
  });
});
