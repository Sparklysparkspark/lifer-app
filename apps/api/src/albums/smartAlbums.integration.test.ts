// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Smart albums: rules are validated on save, membership is the owner's live Gallery matches less
// exclusions, and the album page, export and share page all read it through albumItemRows.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "5a5a5a5a-0000-4000-8000-000000000001";
const OTHER = "5a5a5a5a-0000-4000-8000-000000000002";
const BIRD = "5a5a5a5a-0000-4000-8000-00000000000a";
const MAMMAL = "5a5a5a5a-0000-4000-8000-00000000000b";
const TOKEN = "lifer_test_smart_albums_owner_5a1";
const OTHER_TOKEN = "lifer_test_smart_albums_other_5a2";
const RULES = { version: 2, query: { taxa: "aves", onlyTopRated: "1" } };

describe.skipIf(!url)("smart albums", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let thumb: string;
  let clearCaches: () => void;

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", route: string, payload?: unknown, token = TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: token } });
  const ids = async (albumId: string) =>
    ((await call("GET", `/api/albums/${albumId}`)).json().items as Array<{ captureId: string }>).map(
      (i) => i.captureId,
    );

  async function addCapture(userId: string, speciesId: string, rating: number | null) {
    const captureId = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, quality_rating, taken_at, lat, lon)
         VALUES ($1, $2, gen_random_uuid()::text, $3, now(), 10.5, -84.2) RETURNING id`,
        [userId, speciesId, rating],
      )
    ).rows[0].id;
    const photoId = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`,
        [captureId, thumb],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);
    return { captureId, photoId };
  }

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[BIRD, MAMMAL]]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-smart-albums-"));
    thumb = path.join(dataDir, "thumb.webp");
    writeFileSync(thumb, "webp");
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { albumRoutes } = await import("./routes.js");
    const { albumShareRoutes } = await import("../shares/routes.js");
    const gallery = await import("../gallery/routes.js");
    clearCaches = gallery.clearGallerySearchCaches;

    await cleanup();
    for (const [id, email, token] of [
      [OWNER, "smart-owner@test", TOKEN],
      [OTHER, "smart-other@test", OTHER_TOKEN],
    ]) {
      await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, $2, 'x')`, [id, email]);
      await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
        hashToken(token),
        id,
      ]);
    }
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 975301, 'Smartus avis', 'Smart Test Bird', 'aves'),
         ($2, 975302, 'Smartus mammalis', 'Smart Test Mammal', 'mammalia')`,
      [BIRD, MAMMAL],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(albumRoutes, { prefix: "/api" });
    await app.register(albumShareRoutes, { prefix: "/api" });
    await app.register(gallery.galleryRoutes, { prefix: "/api" });
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

  it("refuses rules that aren't the versioned Gallery query", async () => {
    const create = (rules: unknown) => call("POST", "/api/albums", { name: "Bad", rules });
    expect((await create({ version: 3, query: {} })).statusCode).toBe(400);
    expect((await create({ version: 1, query: {}, extra: 1 })).statusCode).toBe(400);
    expect((await create({ version: 1, query: { colour: "red" } })).statusCode).toBe(400);
    expect((await create({ version: 1, query: { tier: "mythical" } })).statusCode).toBe(400);
    expect((await create({ version: 1, query: { dateFrom: "2024-02-31" } })).json()).toEqual({
      error: "dateFrom and dateTo must be YYYY-MM-DD dates",
    });
    expect((await create({ version: 1, query: { ratingMin: "4", ratingMax: "2" } })).statusCode).toBe(400);
    expect((await create({ version: 1, query: { ratingMin: "3", ratingMax: "4" } })).statusCode).toBe(200);
    // Shot type: the two axes, and the older single shotKind saved rules still carry.
    expect((await create({ version: 1, query: { action: "flying,behavior", framing: "close" } })).statusCode).toBe(200);
    expect((await create({ version: 1, query: { shotKind: "flight" } })).statusCode).toBe(200);
    expect((await create({ version: 1, query: { action: "sleeping" } })).statusCode).toBe(400);
    expect((await create({ version: 1, query: { shotKind: "macro" } })).statusCode).toBe(400);
    // Appearance: lists of known stages and sexes, and any plumage or morph text.
    const looks = await create({
      version: 2,
      query: { lifeStage: ["juvenile"], sex: ["male"], morph: ["dark morph"] },
    });
    expect(looks.statusCode).toBe(200);
    expect(looks.json().rules.query).toEqual({ lifeStage: ["juvenile"], sex: ["male"], morph: ["dark morph"] });
    expect((await create({ version: 2, query: { lifeStage: ["hatchling"] } })).statusCode).toBe(400);

    // A hand-picked album never turns into a smart one.
    const manual = (await call("POST", "/api/albums", { name: "Manual" })).json();
    expect(manual.rules).toBeNull();
    const patched = await call("PATCH", `/api/albums/${manual.id}`, { rules: RULES });
    expect(patched.statusCode).toBe(409);
    expect((await call("POST", `/api/albums/${manual.id}/exclusions`, { captureIds: [OWNER] })).statusCode).toBe(409);
  });

  it("reads version 1 rules, sent or already stored, as the same album in version 2", async () => {
    const top = await addCapture(OWNER, BIRD, 5);
    const low = await addCapture(OWNER, BIRD, 2);
    const v1 = { version: 1, query: { taxa: "aves", ratingMin: "5", tag: "", tier: "common" } };
    const sent = (await call("POST", "/api/albums", { name: "Sent v1", rules: v1 })).json();
    expect(sent.rules).toEqual({
      version: 2,
      query: { taxa: "aves", ratingMin: "5", tag: [], tier: ["common"] },
    });
    // A row written before filters took lists, read back through the list and detail routes.
    const stored = (
      await db.query<{ id: string }>(
        `INSERT INTO albums (user_id, name, rules) VALUES ($1, 'Stored v1', $2) RETURNING id`,
        [OWNER, JSON.stringify({ version: 1, query: { taxa: "aves", ratingMin: "5" } })],
      )
    ).rows[0].id;
    expect(await ids(stored)).toEqual([top.captureId]);
    const detail = (await call("GET", `/api/albums/${stored}`)).json();
    expect(detail.rules).toEqual({ version: 2, query: { taxa: "aves", ratingMin: "5" } });
    // Several values in one filter are alternatives.
    const many = (
      await call("POST", "/api/albums", {
        name: "Two taxa",
        rules: { version: 2, query: { taxa: "aves", tag: ["a", "b"] } },
      })
    ).json();
    expect(many.rules.query.tag).toEqual(["a", "b"]);
    // Leave the library as the other tests expect it.
    await db.query(`DELETE FROM albums WHERE id = ANY($1)`, [[sent.id, stored, many.id]]);
    await db.query(`DELETE FROM captures_all WHERE id = ANY($1)`, [[top.captureId, low.captureId]]);
    clearCaches();
  });

  it("opens with only its first photos, agreeing with the whole album", async () => {
    const birds = [
      await addCapture(OWNER, BIRD, 5),
      await addCapture(OWNER, BIRD, 5),
      await addCapture(OWNER, BIRD, 5),
    ];
    const album = (await call("POST", "/api/albums", { name: "First page", rules: RULES })).json();
    await call("POST", `/api/albums/${album.id}/exclusions`, { captureIds: [birds[1].captureId] });
    const full = (await call("GET", `/api/albums/${album.id}`)).json();
    const started = performance.now();
    const first = await call("GET", `/api/albums/${album.id}?limit=1`);
    // Generous: the first page is a fraction of a second even for a whole-library album.
    expect(performance.now() - started).toBeLessThan(2000);
    const page = first.json();
    expect(full.items).toHaveLength(2);
    expect(full.itemCount).toBe(2);
    expect(page.items).toEqual([full.items[0]]);
    expect(page).toMatchObject({ itemCount: 2, coverPhotoId: full.coverPhotoId, quadSlots: full.quadSlots });
    expect((await call("GET", `/api/albums/${album.id}?limit=0`)).statusCode).toBe(400);
    await db.query(`DELETE FROM albums WHERE id = $1`, [album.id]);
    await db.query(`DELETE FROM captures_all WHERE id = ANY($1)`, [birds.map((b) => b.captureId)]);
    clearCaches();
  });

  it("keeps its cover one of its matches when its rules or photos change", async () => {
    const bird = await addCapture(OWNER, BIRD, 5);
    const mammal = await addCapture(OWNER, MAMMAL, 5);
    const album = (await call("POST", "/api/albums", { name: "Top", rules: { version: 2, query: {} } })).json();
    const cover = async () => {
      const listed = (await call("GET", "/api/albums")).json().albums.find((a: { id: string }) => a.id === album.id);
      const detail = (await call("GET", `/api/albums/${album.id}`)).json();
      expect(listed.coverPhotoId).toBe(detail.coverPhotoId);
      return { photoId: detail.coverPhotoId, picked: detail.coverPicked, cropX: detail.coverCropX };
    };

    // A picked cover that still matches stays, crop and all.
    await call("PATCH", `/api/albums/${album.id}`, { coverPhotoId: mammal.photoId });
    await call("PATCH", `/api/albums/${album.id}/cover-crop`, { x: 10, y: 10, size: 50 });
    await call("PATCH", `/api/albums/${album.id}`, { rules: { version: 2, query: { onlyTopRated: "1" } } });
    expect(await cover()).toEqual({ photoId: mammal.photoId, picked: true, cropX: 10 });

    // Rules that leave it out hand the cover to a match, and the stale pick is gone for good.
    const patched = await call("PATCH", `/api/albums/${album.id}`, { rules: RULES });
    expect(patched.json().coverPhotoId).toBeNull();
    expect(await cover()).toEqual({ photoId: bird.photoId, picked: false, cropX: null });
    const stored = await db.query(`SELECT cover_photo_id, cover_crop_x FROM albums WHERE id = $1`, [album.id]);
    expect(stored.rows[0]).toEqual({ cover_photo_id: null, cover_crop_x: null });

    // A cover saved before this rule (or one an edit to the photo dropped) heals on the next look.
    await db.query(`UPDATE albums SET cover_photo_id = $2 WHERE id = $1`, [album.id, mammal.photoId]);
    expect((await cover()).photoId).toBe(bird.photoId);
    expect((await db.query(`SELECT cover_photo_id FROM albums WHERE id = $1`, [album.id])).rows[0].cover_photo_id).toBe(
      null,
    );

    // An excluded cover gives way too; a trashed one is kept for a restore.
    await call("PATCH", `/api/albums/${album.id}`, { coverPhotoId: bird.photoId });
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [bird.captureId]);
    clearCaches();
    expect((await cover()).photoId).toBeNull();
    await db.query(`UPDATE captures_all SET deleted_at = NULL WHERE id = $1`, [bird.captureId]);
    clearCaches();
    expect(await cover()).toMatchObject({ photoId: bird.photoId, picked: true });
    await call("POST", `/api/albums/${album.id}/exclusions`, { captureIds: [bird.captureId] });
    expect((await cover()).photoId).toBeNull();

    await db.query(`DELETE FROM albums WHERE id = $1`, [album.id]);
    await db.query(`DELETE FROM captures_all WHERE id = ANY($1)`, [[bird.captureId, mammal.captureId]]);
    clearCaches();
  });

  it("lists the owner's live matches, minus exclusions, and refuses hand edits", async () => {
    const topBird = await addCapture(OWNER, BIRD, 5);
    const okBird = await addCapture(OWNER, BIRD, 3);
    await addCapture(OWNER, MAMMAL, 5);
    const othersBird = await addCapture(OTHER, BIRD, 5);

    const created = await call("POST", "/api/albums", { name: "Best birds", rules: RULES });
    expect(created.statusCode).toBe(200);
    const album = created.json();
    expect(album).toMatchObject({ rules: RULES, captureCount: 1 });
    expect(await ids(album.id)).toEqual([topBird.captureId]);

    // The albums list marks it smart and counts it live.
    const listed = (await call("GET", "/api/albums")).json().albums.find((a: { id: string }) => a.id === album.id);
    expect(listed).toMatchObject({ rules: RULES, captureCount: 1, coverPhotoId: topBird.photoId });

    // A new matching photo, and a rating raised to 5, join without touching the album.
    const newBird = await addCapture(OWNER, BIRD, 5);
    await db.query(`UPDATE captures_all SET quality_rating = 5 WHERE id = $1`, [okBird.captureId]);
    clearCaches();
    const live = await ids(album.id);
    expect(live.sort()).toEqual([topBird.captureId, okBird.captureId, newBird.captureId].sort());
    expect(live).not.toContain(othersBird.captureId);

    // Excluding is the user's override; restoring undoes it.
    expect(
      (await call("POST", `/api/albums/${album.id}/exclusions`, { captureIds: [okBird.captureId] })).statusCode,
    ).toBe(200);
    // Another user's capture can't be excluded into (or through) this album.
    await call("POST", `/api/albums/${album.id}/exclusions`, { captureIds: [othersBird.captureId] });
    const detail = (await call("GET", `/api/albums/${album.id}`)).json();
    expect(detail.excludedCount).toBe(1);
    expect(detail.items.map((i: { captureId: string }) => i.captureId)).not.toContain(okBird.captureId);
    const excluded = (await call("GET", `/api/albums/${album.id}/exclusions`)).json().items;
    expect(excluded.map((i: { captureId: string }) => i.captureId)).toEqual([okBird.captureId]);
    await call("DELETE", `/api/albums/${album.id}/exclusions/${okBird.captureId}`);
    expect(await ids(album.id)).toContain(okBird.captureId);

    // Manual membership routes refuse a smart album with a reason.
    const add = await call("POST", `/api/albums/${album.id}/captures`, { captureIds: [topBird.captureId] });
    expect(add.statusCode).toBe(409);
    expect(add.json().error).toMatch(/smart album/);
    const remove = await call("DELETE", `/api/albums/${album.id}/captures/${topBird.captureId}`);
    expect(remove.statusCode).toBe(409);

    // Editing the rules changes membership at once; the species view follows.
    await call("PATCH", `/api/albums/${album.id}`, { rules: { version: 1, query: { onlyTopRated: "1" } } });
    expect((await ids(album.id)).length).toBe(4);
    const species = (await call("GET", `/api/albums/${album.id}/species`)).json().items;
    expect(species.map((s: { speciesId: string }) => s.speciesId).sort()).toEqual([BIRD, MAMMAL].sort());

    // Another user can't read it.
    expect((await call("GET", `/api/albums/${album.id}`, undefined, OTHER_TOKEN)).statusCode).toBe(404);
  });

  // Remembered state (docs/docs/contributing/remembered-state.md): rules that name a tag, region,
  // trip or album that has since been deleted match nothing and never fail the album or its list.
  it("treats rules naming a deleted tag, region, trip or album as matching nothing", async () => {
    await addCapture(OWNER, BIRD, 5);
    const gone = "5a5a5a5a-0000-4000-8000-00000000dead";
    for (const query of [{ tag: "deleted-tag" }, { regionId: gone }, { tripId: gone }, { albumId: gone }]) {
      const created = await call("POST", "/api/albums", {
        name: `Dangling ${Object.keys(query)[0]}`,
        rules: { version: 2, query },
      });
      expect(created.statusCode).toBe(200);
      const detail = await call("GET", `/api/albums/${created.json().id}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().items).toEqual([]);
      expect((await call("GET", `/api/albums/${created.json().id}/species`)).statusCode).toBe(200);
    }
    expect((await call("GET", "/api/albums")).statusCode).toBe(200);
  });

  it("scopes the Gallery to a smart album's matches, even when its rules scope to itself", async () => {
    const bird = await addCapture(OWNER, BIRD, 5);
    await addCapture(OWNER, MAMMAL, 5);
    const album = (await call("POST", "/api/albums", { name: "Scoped birds", rules: RULES })).json();
    const scoped = (await call("GET", `/api/gallery?albumId=${album.id}`)).json().items;
    expect(scoped.map((i: { captureId: string }) => i.captureId)).toContain(bird.captureId);
    expect(scoped.every((i: { speciesId: string }) => i.speciesId === BIRD)).toBe(true);

    await call("PATCH", `/api/albums/${album.id}`, { rules: { version: 1, query: { albumId: album.id } } });
    expect((await call("GET", `/api/albums/${album.id}`)).json().items).toEqual([]);
  });

  it("shares the live matches, never with location, and serves only member photos", async () => {
    const album = (await call("POST", "/api/albums", { name: "Shared birds", rules: RULES })).json();
    const before = await addCapture(OWNER, BIRD, 5);
    const othersBird = await addCapture(OTHER, BIRD, 5);
    const share = (await call("POST", `/api/albums/${album.id}/shares`, {})).json();

    const later = await addCapture(OWNER, BIRD, 5);
    const page = await app.inject({ method: "GET", url: `/api/share/${share.token}` });
    const items = page.json().items as Array<Record<string, unknown>>;
    const shared = items.map((i) => i.captureId);
    expect(shared).toContain(before.captureId);
    expect(shared).toContain(later.captureId);
    expect(shared).not.toContain(othersBird.captureId);
    // The share page never carries a location, so a sensitive species' site can't leak.
    for (const item of items) {
      expect(item).not.toHaveProperty("lat");
      expect(item).not.toHaveProperty("lon");
      expect(item).not.toHaveProperty("regionId");
      expect(item).not.toHaveProperty("regionName");
    }

    const thumbOf = (photoId: string) =>
      app.inject({ method: "GET", url: `/api/share/${share.token}/photos/${photoId}/thumb` });
    expect((await thumbOf(later.photoId)).statusCode).toBe(200);
    expect((await thumbOf(othersBird.photoId)).statusCode).toBe(404);

    // An excluded photo drops off the shared page and its file stops being served.
    await call("POST", `/api/albums/${album.id}/exclusions`, { captureIds: [later.captureId] });
    const after = (await app.inject({ method: "GET", url: `/api/share/${share.token}` })).json().items;
    expect(after.map((i: { captureId: string }) => i.captureId)).not.toContain(later.captureId);
    expect((await thumbOf(later.photoId)).statusCode).toBe(404);
  });
});
