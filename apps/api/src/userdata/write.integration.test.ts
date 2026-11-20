// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The userdata.write routes and the userdata.read companions to them, over HTTP with real keys:
// each write allowed, refused without the scope, attributed to the app, undone from Lifer, and the
// "needs a better photo" mark reaching the phone's sync feed.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000701";
const OTHER = "cccccccc-0000-4000-8000-000000000702";
const SP = "cccccccc-0000-4000-8000-0000000007a0";
const BARE = "cccccccc-0000-4000-8000-0000000007b0";
const WRITE = "lifer_test_userdata_write_701";
const READ = "lifer_test_userdata_read_701";
const PHONE = "lifer_test_userdata_phone_701";
const OTHER_WRITE = "lifer_test_userdata_write_702";
const SESSION = "lifer_test_userdata_session_701";

// Unit vectors leaning away from axis 0 by `tilt`, so a smaller tilt is closer to the query.
const vector = (tilt: number) =>
  Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : i === 1 ? tilt : 0) / Math.hypot(1, tilt));

describe.skipIf(!url)("userdata.write endpoints (API key)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let model: string;
  const photos: string[] = [];
  const captures: string[] = [];
  let otherPhoto = "";

  const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", p: string, token = WRITE, payload?: object) =>
    app.inject({ method, url: p, headers: { "x-api-key": token }, ...(payload ? { payload } : {}) });
  const asLifer = (method: "GET" | "POST", p: string) =>
    app.inject({ method, url: p, cookies: { [cookieName]: SESSION } });
  const capture = async (id: string) =>
    (await db.query(`SELECT quality_rating, cull_verdict, cull_label FROM captures_all WHERE id = $1`, [id])).rows[0];
  const mark = async () =>
    (await db.query(`SELECT * FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SP])).rows[0];
  async function undo(changeId: string) {
    const res = await asLifer("POST", `/api/changes/${changeId}/undo`);
    expect(res.statusCode).toBe(200);
  }

  async function addCapture(user: string, tilt: number, rating: number | null): Promise<[string, string]> {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating)
       VALUES ($1, $2, gen_random_uuid()::text, now() - interval '1 day', $3) RETURNING id`,
      [user, SP, rating],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`,
      [c.rows[0].id, "/nonexistent/lifer-test.webp"],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(`INSERT INTO capture_embeddings (capture_id, embedding, model_version) VALUES ($1, $2, $3)`, [
      c.rows[0].id,
      vector(tilt),
      model,
    ]);
    return [c.rows[0].id, p.rows[0].id];
  }

  async function cleanup() {
    for (const u of [USER, OTHER]) {
      await db.query(`DELETE FROM change_batches WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SP, BARE]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { hashToken } = await import("../auth/session.js");
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    ({ SESSION_COOKIE_NAME: cookieName, EMBEDDING_MODEL_VERSION: model } = await import("@lifer/core/config.js"));
    await cleanup();

    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'write@test', 'x'), ($2, 'write-other@test', 'x')`,
      [USER, OTHER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 970701, 'Scribus primus', 'Test Writer', 'aves'), ($2, 970702, 'Scribus nudus', NULL, 'aves')`,
      [SP, BARE],
    );
    for (const [tilt, rating] of [
      [0.1, 3],
      [0.5, null],
      [2, 5],
    ] as const) {
      const [c, p] = await addCapture(USER, tilt, rating);
      captures.push(c);
      photos.push(p);
    }
    [, otherPhoto] = await addCapture(OTHER, 0, null);
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, card_crop_x, card_crop_y, card_crop_size, best_quality)
       VALUES ($1, $2, 'collected', $3, 10, 20, 30, 5)`,
      [USER, SP, photos[2]],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [OTHER, SP]);

    const key = `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, $2, $3, $4)`;
    await db.query(key, [USER, "Sample Companion", hashApiKey(WRITE), ["userdata.read", "userdata.write"]]);
    await db.query(key, [USER, "Reader", hashApiKey(READ), ["userdata.read", "photos.write", "collection.write"]]);
    await db.query(key, [USER, "Phone", hashApiKey(PHONE), ["companion"]]);
    await db.query(key, [OTHER, "Sample Companion", hashApiKey(OTHER_WRITE), ["userdata.write"]]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(SESSION),
      USER,
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

  it("refuses every write without userdata.write, even with broader scopes", async () => {
    const writes = [
      call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, READ, { rating: 1 }),
      call("PUT", `/api/userdata/v1/species/${SP}/featured`, READ, { photoId: photos[0] }),
      call("PUT", `/api/userdata/v1/species/${SP}/card-crop`, READ, { x: 1, y: 1, size: 50 }),
      call("PUT", `/api/userdata/v1/species/${SP}/needs-better-photo`, READ),
      call("DELETE", `/api/userdata/v1/species/${SP}/needs-better-photo`, READ),
    ];
    for (const res of await Promise.all(writes)) expect(res.statusCode).toBe(401);
    expect(await capture(captures[0])).toMatchObject({ quality_rating: 3 });
    // And a write key alone can't read.
    expect((await call("GET", `/api/userdata/v1/species/${SP}/featured`, OTHER_WRITE)).statusCode).toBe(401);
  });

  it("sets rating, pick and label, attributes the change to the app, and undoes it from Lifer", async () => {
    const res = await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, {
      rating: 5,
      flag: "pick",
      label: "red",
    });
    expect(res.statusCode).toBe(200);
    const { changeId } = res.json() as { changeId: string };
    expect(await capture(captures[0])).toEqual({ quality_rating: 5, cull_verdict: "pick", cull_label: "red" });

    const list = (await asLifer("GET", "/api/changes/apps")).json() as {
      changes: { id: string; appName: string; summary: string; undoneAt: string | null }[];
    };
    expect(list.changes[0]).toMatchObject({ id: changeId, appName: "Sample Companion", undoneAt: null });
    expect(list.changes[0].summary).toBe("Rated a photo 5 stars, marked a photo as a pick, gave a photo a red label");
    // The assistant's own list and "undo last" leave app changes alone.
    expect(((await asLifer("GET", "/api/changes")).json() as { changes: unknown[] }).changes).toEqual([]);
    expect((await asLifer("POST", "/api/changes/undo-last")).json()).toEqual({ undone: null });
    // An app can't list or undo changes.
    expect((await call("GET", "/api/changes/apps")).statusCode).toBe(401);
    expect((await call("POST", `/api/changes/${changeId}/undo`)).statusCode).toBe(401);

    await undo(changeId);
    expect(await capture(captures[0])).toEqual({ quality_rating: 3, cull_verdict: null, cull_label: null });
    // Once only.
    expect((await asLifer("POST", `/api/changes/${changeId}/undo`)).statusCode).toBe(404);
  });

  it("logs nothing when nothing changed, and only the fields that changed", async () => {
    const same = await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, { rating: 3 });
    expect(same.json()).toEqual({ ok: true, changeId: null });
    const res = await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, { rating: 3, flag: "reject" });
    const { changeId } = res.json() as { changeId: string };
    // The user rates the photo themselves after the app's change; undoing the app's pick keeps it.
    await db.query(`UPDATE captures_all SET quality_rating = 4 WHERE id = $1`, [captures[0]]);
    await undo(changeId);
    expect(await capture(captures[0])).toEqual({ quality_rating: 4, cull_verdict: null, cull_label: null });
    await db.query(`UPDATE captures_all SET quality_rating = 3 WHERE id = $1`, [captures[0]]);
  });

  it("validates the body and only touches the user's own photos", async () => {
    expect((await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, {})).statusCode).toBe(400);
    expect((await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, { rating: 6 })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, { label: "teal" })).statusCode).toBe(
      400,
    );
    expect((await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, WRITE, { speciesId: BARE })).statusCode).toBe(
      400,
    );
    expect((await call("PATCH", `/api/userdata/v1/photos/${otherPhoto}`, WRITE, { rating: 1 })).statusCode).toBe(404);
    expect((await call("PATCH", `/api/userdata/v1/photos/${photos[0]}`, OTHER_WRITE, { rating: 1 })).statusCode).toBe(
      404,
    );
  });

  it("sets the featured photo and crop, and undo puts the old ones back", async () => {
    expect(
      (await call("PUT", `/api/userdata/v1/species/${SP}/featured`, WRITE, { photoId: otherPhoto })).statusCode,
    ).toBe(403);
    const res = await call("PUT", `/api/userdata/v1/species/${SP}/featured`, WRITE, { photoId: photos[1] });
    expect(res.statusCode).toBe(200);
    const featured = (res.json() as { changeId: string }).changeId;
    expect(await mark()).toMatchObject({ cover_photo_id: photos[1], cover_chosen_photo_id: photos[1] });

    const crop = await call("PUT", `/api/userdata/v1/species/${SP}/card-crop`, WRITE, { x: 5, y: 6, size: 70 });
    const cropped = (crop.json() as { changeId: string }).changeId;
    expect(await mark()).toMatchObject({ card_crop_x: "5", card_crop_y: "6", card_crop_size: "70" });

    const read = (await call("GET", `/api/userdata/v1/species/${SP}/featured`)).json();
    expect(read).toEqual({
      photo: {
        photoId: photos[1],
        chosenByUser: true,
        cardCrop: { x: 5, y: 6, size: 70 },
        rating: null,
        flag: null,
        label: null,
      },
      needsBetterPhoto: false,
    });

    await undo(cropped);
    expect(await mark()).toMatchObject({ cover_photo_id: photos[1], card_crop_size: null });
    await undo(featured);
    expect(await mark()).toMatchObject({
      cover_photo_id: photos[2],
      cover_chosen_photo_id: null,
      card_crop_x: "10",
      card_crop_y: "20",
      card_crop_size: "30",
    });
    // A species the user has no mark for.
    expect((await call("GET", `/api/userdata/v1/species/${BARE}/featured`)).statusCode).toBe(404);
    expect(
      (await call("PUT", `/api/userdata/v1/species/${BARE}/card-crop`, WRITE, { x: 1, y: 1, size: 9 })).statusCode,
    ).toBe(404);
  });

  it("sets and clears the needs-a-better-photo mark, and the phone's sync feed carries it", async () => {
    const phoneMark = async () =>
      (
        (await call("GET", "/api/sync/user-species", PHONE)).json() as {
          items: { scientificName: string; needsBetterPhoto: boolean }[];
        }
      ).items.find((i) => i.scientificName === "Scribus primus");

    const set = await call("PUT", `/api/userdata/v1/species/${SP}/needs-better-photo`);
    const setId = (set.json() as { changeId: string }).changeId;
    expect(setId).toBeTruthy();
    expect((await mark()).needs_better_photo).toBe(true);
    expect(await phoneMark()).toMatchObject({ needsBetterPhoto: true });
    const list = (await asLifer("GET", "/api/changes/apps")).json() as { changes: { id: string; summary: string }[] };
    expect(list.changes.find((c) => c.id === setId)?.summary).toBe("Marked Test Writer as needing a better photo");
    // The featured read says so too.
    expect(
      ((await call("GET", `/api/userdata/v1/species/${SP}/featured`)).json() as { needsBetterPhoto: boolean })
        .needsBetterPhoto,
    ).toBe(true);

    // A push that leaves the field out (an older peer) keeps the mark.
    const { upsertUserSpecies, listUserSpeciesByName } = await import("../sync/changes.js");
    const [row] = await listUserSpeciesByName(db, USER, ["Scribus primus"]);
    const { needsBetterPhoto: _drop, ...without } = row;
    await upsertUserSpecies(db, USER, [{ ...without, isTarget: true }], { mirrored: false });
    expect(await mark()).toMatchObject({ needs_better_photo: true, is_target: true });
    await db.query(`UPDATE user_species SET is_target = false WHERE user_id = $1 AND species_id = $2`, [USER, SP]);

    await undo(setId);
    expect((await mark()).needs_better_photo).toBe(false);
    expect(await phoneMark()).toMatchObject({ needsBetterPhoto: false });

    // Clearing from Lifer itself (a session) works and isn't logged as an app's change.
    await call("PUT", `/api/userdata/v1/species/${SP}/needs-better-photo`);
    const before = ((await asLifer("GET", "/api/changes/apps")).json() as { changes: unknown[] }).changes.length;
    const cleared = await app.inject({
      method: "DELETE",
      url: `/api/userdata/v1/species/${SP}/needs-better-photo`,
      cookies: { [cookieName]: SESSION },
    });
    expect(cleared.json()).toEqual({ ok: true, changeId: null });
    expect((await mark()).needs_better_photo).toBe(false);
    expect(((await asLifer("GET", "/api/changes/apps")).json() as { changes: unknown[] }).changes.length).toBe(before);
    expect((await call("PUT", `/api/userdata/v1/species/${BARE}/needs-better-photo`)).statusCode).toBe(404);
  });

  it("finds the species' photos closest to a vector, with their marks and the featured one", async () => {
    const res = await call("POST", `/api/userdata/v1/species/${SP}/similar-photos`, READ, {
      model,
      vector: vector(0).map((v) => v * 3),
      limit: 2,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      model: string;
      items: { photoId: string; rating: number | null; featured: boolean; similarity: number }[];
    };
    expect(body.model).toBe(model);
    expect(body.items.map((i) => i.photoId)).toEqual([photos[0], photos[1]]);
    expect(body.items[0]).toMatchObject({ rating: 3, featured: false });
    expect(body.items[0].similarity).toBeGreaterThan(body.items[1].similarity);
    // The featured one, further away, shows when asked for all.
    const all = (
      await call("POST", `/api/userdata/v1/species/${SP}/similar-photos`, READ, { model, vector: vector(0) })
    ).json() as { items: { photoId: string; featured: boolean }[] };
    expect(all.items.map((i) => [i.photoId, i.featured])).toEqual([
      [photos[0], false],
      [photos[1], false],
      [photos[2], true],
    ]);
    // Never another user's photos, never another model's vectors, never without the scope.
    expect(all.items.map((i) => i.photoId)).not.toContain(otherPhoto);
    expect(
      (await call("POST", `/api/userdata/v1/species/${SP}/similar-photos`, READ, { model: "other", vector: vector(0) }))
        .statusCode,
    ).toBe(400);
    expect(
      (await call("POST", `/api/userdata/v1/species/${SP}/similar-photos`, READ, { model, vector: [1, 0] })).statusCode,
    ).toBe(400);
    expect(
      (await call("POST", `/api/userdata/v1/species/${SP}/similar-photos`, PHONE, { model, vector: vector(0) }))
        .statusCode,
    ).toBe(401);
  });

  it("limits how fast an app can write", async () => {
    const { isRateLimited, recordAttempt } = await import("../auth/rateLimiter.js");
    const key = `userdata-write:${USER}:Sample Companion`;
    while (!isRateLimited(key, 600, 60_000)) recordAttempt(key);
    const res = await call("PUT", `/api/userdata/v1/species/${SP}/needs-better-photo`);
    expect(res.statusCode).toBe(429);
    expect((await mark()).needs_better_photo).toBe(false);
  });
});
