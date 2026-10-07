// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run captures/routes
// Capture edits through the real routes: only the owner can change a capture, write access is
// needed, each route validates its input, and a species correction keeps the old species' card,
// the library files and the embedded species names consistent.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000501";
const OTHER = "eeeeeeee-0000-4000-8000-000000000502";
const SPECIES_A = "eeeeeeee-0000-4000-8000-00000000050a";
const SPECIES_B = "eeeeeeee-0000-4000-8000-00000000050b";
const SPECIES_C = "eeeeeeee-0000-4000-8000-00000000050c";
const NO_SUCH_SPECIES = "eeeeeeee-0000-4000-8000-0000000005ff";
const OWNER_TOKEN = "lifer_test_capture_routes_owner_501";
const OTHER_TOKEN = "lifer_test_capture_routes_other_502";
const READ_KEY = "lifer_test_capture_routes_read_key_501";
const WRITE_KEY = "lifer_test_capture_routes_write_key_501";
const REGION = "Zzcapture Routes Region";

describe.skipIf(!url)("capture routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let regionId: string;
  let n = 0;

  const call = (method: "POST" | "PATCH" | "DELETE", route: string, payload?: unknown, token = OWNER_TOKEN) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: token } });

  /** A capture with one photo; `days` ago sets taken_at, so "newest" is predictable. */
  async function makeCapture(userId: string, speciesId: string, days: number, rating: number | null = null) {
    n++;
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, quality_rating)
       VALUES ($1, $2, $3, now() - ($4 || ' days')::interval, $5) RETURNING id`,
      [userId, speciesId, `capture-routes-${n}`, String(days), rating],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    return { captureId: c.rows[0].id, photoId: p.rows[0].id };
  }

  const captureRow = async (id: string) =>
    (
      await db.query(
        `SELECT species_id, taken_at, region_id, location_label, quality_rating FROM captures_all WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const userSpecies = async (userId: string, speciesId: string) =>
    (
      await db.query(
        `SELECT state, cover_photo_id, best_quality, card_crop_x::float AS card_crop_x, is_target
         FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [userId, speciesId],
      )
    ).rows[0];
  const tinyJpeg = () =>
    sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
      .jpeg()
      .toBuffer();
  const tags = async (captureId: string) =>
    (await db.query(`SELECT species_id FROM capture_species WHERE capture_id = $1`, [captureId])).rows.map(
      (r) => r.species_id,
    );

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM api_keys WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B, SPECIES_C]]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [REGION]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-capture-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    const { hashApiKey } = await import("../auth/apiKeys.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, species_naming_styles) VALUES
         ($1, 'routes-owner@test', 'x', '{common,aba_code}'), ($2, 'routes-other@test', 'x', '{}')`,
      [OWNER, OTHER],
    );
    await db.query(
      `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $3, now() + interval '1 day'), ($2, $4, now() + interval '1 day')`,
      [hashToken(OWNER_TOKEN), hashToken(OTHER_TOKEN), OWNER, OTHER],
    );
    await db.query(
      `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES
         ($1, 'read only', $2, '{photos.read}'), ($1, 'writer', $3, '{photos.write}')`,
      [OWNER, hashApiKey(READ_KEY), hashApiKey(WRITE_KEY)],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, family, aba_code) VALUES
         ($1, 920501, 'Testus alphus', 'Routes Bird A', 'aves', 'Testidae', 'RBDA'),
         ($2, 920502, 'Testus betus', 'Routes Bird B', 'aves', 'Testidae', NULL),
         ($3, 920503, 'Testus gammus', 'Routes Bird C', 'aves', 'Testidae', NULL)`,
      [SPECIES_A, SPECIES_B, SPECIES_C],
    );
    regionId = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [REGION])).rows[0]
      .id;

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM user_species WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
    await db.query(`DELETE FROM captures_all WHERE user_id = ANY($1)`, [[OWNER, OTHER]]);
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("who may edit a capture", () => {
    it("never lets another user tag, untag, reassign, date, place or rate someone else's capture", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1, 2);
      await db.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`, [captureId, SPECIES_C]);
      const before = await captureRow(captureId);

      const attempts = [
        await call("POST", `/api/captures/${captureId}/species`, { speciesId: SPECIES_B }, OTHER_TOKEN),
        await call("DELETE", `/api/captures/${captureId}/species/${SPECIES_C}`, undefined, OTHER_TOKEN),
        await call("PATCH", `/api/captures/${captureId}/reassign`, { speciesId: SPECIES_B }, OTHER_TOKEN),
        await call("PATCH", `/api/captures/${captureId}/taken-at`, { takenAt: "2001-01-01T00:00:00Z" }, OTHER_TOKEN),
        await call("PATCH", `/api/captures/${captureId}/region`, { regionId, locationLabel: "Theirs" }, OTHER_TOKEN),
        await call("PATCH", `/api/captures/${captureId}/rating`, { rating: 5 }, OTHER_TOKEN),
      ];
      expect(attempts.map((r) => [r.statusCode, r.json().error])).toEqual([
        [404, "Capture not found"],
        [404, "Tag not found"],
        [404, "Capture not found"],
        [404, "Capture not found"],
        [404, "Capture not found"],
        [404, "Capture not found"],
      ]);
      expect(await captureRow(captureId)).toEqual(before);
      expect(await tags(captureId)).toEqual([SPECIES_C]);
      expect(await userSpecies(OTHER, SPECIES_B)).toBeUndefined();
    });

    it("needs a signed-in user or an API key with write access", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      const routes: Array<["POST" | "PATCH" | "DELETE", string, unknown]> = [
        ["POST", `/api/captures/${captureId}/species`, { speciesId: SPECIES_B }],
        ["DELETE", `/api/captures/${captureId}/species/${SPECIES_B}`, undefined],
        ["PATCH", `/api/captures/${captureId}/reassign`, { speciesId: SPECIES_B }],
        ["PATCH", `/api/captures/${captureId}/taken-at`, { takenAt: null }],
        ["PATCH", `/api/captures/${captureId}/region`, { locationLabel: "x" }],
        ["PATCH", `/api/captures/${captureId}/rating`, { rating: 3 }],
      ];
      for (const [method, route, payload] of routes) {
        const anonymous = await app.inject({ method, url: route, payload: payload as object });
        const readOnly = await app.inject({
          method,
          url: route,
          payload: payload as object,
          headers: { "x-api-key": READ_KEY },
        });
        expect([route, anonymous.statusCode, readOnly.statusCode]).toEqual([route, 401, 401]);
      }
      const before = await captureRow(captureId);
      expect(before.species_id).toBe(SPECIES_A);
      expect(before.location_label).toBeNull();

      // A key with write access gets through on every route.
      for (const [method, route, payload] of routes) {
        const res = await app.inject({
          method,
          url: route,
          payload: payload as object,
          headers: { "x-api-key": WRITE_KEY },
        });
        expect([route, res.statusCode]).toEqual([route, method === "POST" ? 201 : 200]);
      }
      const after = await captureRow(captureId);
      expect([after.species_id, after.location_label, after.quality_rating]).toEqual([SPECIES_B, "x", 3]);
    });
  });

  describe("secondary species tags", () => {
    it("tags a second species, marks it collected with this photo as its cover, and untags it", async () => {
      const { captureId, photoId } = await makeCapture(OWNER, SPECIES_A, 3);
      const res = await call("POST", `/api/captures/${captureId}/species`, { speciesId: SPECIES_B });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toEqual({ ok: true });
      expect(await tags(captureId)).toEqual([SPECIES_B]);
      expect(await userSpecies(OWNER, SPECIES_B)).toMatchObject({ state: "collected", cover_photo_id: photoId });

      // Tagging again is harmless.
      expect((await call("POST", `/api/captures/${captureId}/species`, { speciesId: SPECIES_B })).statusCode).toBe(201);
      expect(await tags(captureId)).toEqual([SPECIES_B]);

      const untag = await call("DELETE", `/api/captures/${captureId}/species/${SPECIES_B}`);
      expect(untag.statusCode).toBe(200);
      expect(untag.json()).toEqual({ ok: true });
      expect(await tags(captureId)).toEqual([]);
      // Untagging doesn't decide whether you've seen the species.
      expect(await userSpecies(OWNER, SPECIES_B)).toMatchObject({ state: "collected" });
      expect((await call("DELETE", `/api/captures/${captureId}/species/${SPECIES_B}`)).statusCode).toBe(404);
    });

    it("refuses a missing, malformed, unknown or primary species", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      const post = (body: unknown) => call("POST", `/api/captures/${captureId}/species`, body);
      expect((await post({})).json()).toEqual({
        error: expect.stringMatching(/^Invalid body: speciesId is required$/),
        code: "invalid_request",
      });
      expect((await post({ speciesId: "nope" })).json()).toEqual({
        error: expect.stringMatching(/^Invalid body: speciesId must be an id/),
        code: "invalid_request",
      });
      expect((await post({ speciesId: SPECIES_B, extra: 1 })).json()).toEqual({
        error: expect.stringMatching(/unexpected field extra/),
        code: "invalid_request",
      });
      const unknown = await post({ speciesId: NO_SUCH_SPECIES });
      expect([unknown.statusCode, unknown.json()]).toEqual([400, { error: "Unknown species" }]);
      const primary = await post({ speciesId: SPECIES_A });
      expect([primary.statusCode, primary.json()]).toEqual([
        400,
        { error: "That's already this photo's primary species" },
      ]);
      expect(await tags(captureId)).toEqual([]);
      const notFound = [
        await call("POST", `/api/captures/${NO_SUCH_SPECIES}/species`, { speciesId: SPECIES_B }),
        await call("POST", "/api/captures/nope/species", { speciesId: SPECIES_B }),
        await call("DELETE", `/api/captures/nope/species/${SPECIES_B}`),
        await call("DELETE", `/api/captures/${captureId}/species/nope`),
      ];
      expect(notFound.map((r) => [r.statusCode, r.json().error])).toEqual([
        [404, "Capture not found"],
        [404, "Capture not found"],
        [404, "Tag not found"],
        [404, "Tag not found"],
      ]);
    });

    it("writes every species, in the owner's naming style, into a managed JPEG and never into a linked one", async () => {
      const jpeg = await tinyJpeg();
      const managedFile = path.join(dataDir, "managed.jpg");
      const linkedFile = path.join(dataDir, "linked.jpg");
      writeFileSync(managedFile, jpeg);
      writeFileSync(linkedFile, jpeg);
      const managed = await makeCapture(OWNER, SPECIES_A, 1);
      const linked = await makeCapture(OWNER, SPECIES_A, 1);
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size) VALUES
           ($1, 'jpeg', 'path', $2, true, $5, 'routes-managed', 1), ($3, 'jpeg', 'path', $4, false, $5, 'routes-linked', 1)`,
        [managed.captureId, managedFile, linked.captureId, linkedFile, OWNER],
      );
      expect(
        (await call("POST", `/api/captures/${managed.captureId}/species`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(201);
      expect(
        (await call("POST", `/api/captures/${linked.captureId}/species`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(201);

      const { readExifTags } = await import("../uploads/exif.js");
      const written = await readExifTags(managedFile);
      expect(written.Title).toBe("Routes Bird A (RBDA), Routes Bird B");
      expect(written.Subject).toEqual(
        expect.arrayContaining(["Routes Bird A", "Testus alphus", "RBDA", "Routes Bird B", "Testus betus"]),
      );
      expect((await readExifTags(linkedFile)).Title).toBeUndefined();
    });
  });

  describe("reassigning a capture's species", () => {
    it("refuses a missing, malformed, unknown or unchanged species, and an unknown capture", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      const patch = (body: unknown) => call("PATCH", `/api/captures/${captureId}/reassign`, body);
      expect((await patch({})).json()).toEqual({
        error: expect.stringMatching(/^Invalid body: speciesId is required$/),
        code: "invalid_request",
      });
      expect((await patch({ speciesId: 42 })).json()).toEqual({
        error: expect.stringMatching(/^Invalid body: speciesId must be string$/),
        code: "invalid_request",
      });
      const unknown = await patch({ speciesId: NO_SUCH_SPECIES });
      expect([unknown.statusCode, unknown.json()]).toEqual([400, { error: "Unknown species" }]);
      const same = await patch({ speciesId: SPECIES_A });
      expect([same.statusCode, same.json()]).toEqual([400, { error: "That's already this photo's species" }]);
      const missing = await call("PATCH", `/api/captures/${NO_SUCH_SPECIES}/reassign`, { speciesId: SPECIES_B });
      expect([missing.statusCode, missing.json()]).toEqual([404, { error: "Capture not found" }]);
      expect((await call("PATCH", "/api/captures/nope/reassign", { speciesId: SPECIES_B })).json()).toEqual({
        error: "Capture not found",
      });
      expect((await captureRow(captureId)).species_id).toBe(SPECIES_A);
    });

    it("moves a managed original into the new species' folder and leaves a linked one where it is", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      const oldDir = path.join(dataDir, "Birds", "Routes Bird A (RBDA)", "Adjusted");
      mkdirSync(oldDir, { recursive: true });
      const stored = path.join(oldDir, "IMG_0001.jpg");
      writeFileSync(stored, await tinyJpeg());
      const linkedDir = mkdtempSync(path.join(tmpdir(), "lifer-capture-linked-"));
      const linkedRaw = path.join(linkedDir, "IMG_0001.CR3");
      writeFileSync(linkedRaw, "raw");
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size) VALUES
           ($1, 'jpeg', 'path', $2, true, $4, 'routes-move-jpeg', 1), ($1, 'raw', 'path', $3, false, $4, 'routes-move-raw', 1)`,
        [captureId, stored, linkedRaw, OWNER],
      );

      const res = await call("PATCH", `/api/captures/${captureId}/reassign`, { speciesId: SPECIES_B });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      const moved = path.join(dataDir, "Birds", "Routes Bird B", "Adjusted", "IMG_0001.jpg");
      expect(existsSync(moved)).toBe(true);
      expect(existsSync(stored)).toBe(false);
      expect(existsSync(linkedRaw)).toBe(true);
      const refs = await db.query(`SELECT kind, ref FROM originals WHERE capture_id = $1 ORDER BY kind`, [captureId]);
      expect(refs.rows).toEqual([
        { kind: "jpeg", ref: moved },
        { kind: "raw", ref: linkedRaw },
      ]);
      expect((await captureRow(captureId)).species_id).toBe(SPECIES_B);
      rmSync(linkedDir, { recursive: true, force: true });
    });

    it("moves the files back and changes nothing when saving the new species fails", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      await db.query(`UPDATE captures_all SET fingerprint = 'capture-routes-fail' WHERE id = $1`, [captureId]);
      const stored = path.join(dataDir, "Birds", "Routes Bird A (RBDA)", "Adjusted", "IMG_0002.jpg");
      mkdirSync(path.dirname(stored), { recursive: true });
      writeFileSync(stored, await tinyJpeg());
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size)
         VALUES ($1, 'jpeg', 'path', $2, true, $3, 'routes-fail-jpeg', 1)`,
        [captureId, stored, OWNER],
      );
      // Only this capture's species change fails, inside the reassign's transaction.
      await db.query(`CREATE OR REPLACE FUNCTION capture_routes_test_fail() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'simulated failure'; END $$ LANGUAGE plpgsql`);
      await db.query(`CREATE TRIGGER capture_routes_test_fail BEFORE UPDATE OF species_id ON captures_all
        FOR EACH ROW WHEN (NEW.fingerprint = 'capture-routes-fail') EXECUTE FUNCTION capture_routes_test_fail()`);
      try {
        const res = await call("PATCH", `/api/captures/${captureId}/reassign`, { speciesId: SPECIES_B });
        expect(res.statusCode).toBe(500);
      } finally {
        await db.query(`DROP TRIGGER capture_routes_test_fail ON captures_all`);
        await db.query(`DROP FUNCTION capture_routes_test_fail()`);
      }
      expect(existsSync(stored)).toBe(true);
      expect(existsSync(path.join(dataDir, "Birds", "Routes Bird B", "Adjusted", "IMG_0002.jpg"))).toBe(false);
      const ref = await db.query(`SELECT ref FROM originals WHERE capture_id = $1`, [captureId]);
      expect(ref.rows).toEqual([{ ref: stored }]);
      expect((await captureRow(captureId)).species_id).toBe(SPECIES_A);
    });

    it("files by the photo's own capture year when organizing by year", async () => {
      await db.query(`UPDATE users SET organize_originals_by_year = true WHERE id = $1`, [OWNER]);
      try {
        // The database says 2021; the camera says 2019, and the folder goes by the camera.
        const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
        await db.query(`UPDATE captures_all SET taken_at = '2021-07-01T12:00:00Z' WHERE id = $1`, [captureId]);
        const stored = path.join(dataDir, "IMG_0003.jpg");
        const withDate = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#808080" } })
          .withExif({ IFD2: { DateTimeOriginal: "2019:06:01 08:30:00" } })
          .jpeg()
          .toBuffer();
        writeFileSync(stored, withDate);
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size)
           VALUES ($1, 'jpeg', 'path', $2, true, $3, 'routes-year-jpeg', 1)`,
          [captureId, stored, OWNER],
        );
        expect((await call("PATCH", `/api/captures/${captureId}/reassign`, { speciesId: SPECIES_B })).statusCode).toBe(
          200,
        );
        const ref = await db.query(`SELECT ref FROM originals WHERE capture_id = $1`, [captureId]);
        expect(ref.rows).toEqual([
          { ref: path.join(dataDir, "Wildlife 2019", "Birds", "Routes Bird B", "Adjusted", "IMG_0003.jpg") },
        ]);
      } finally {
        await db.query(`UPDATE users SET organize_originals_by_year = false WHERE id = $1`, [OWNER]);
      }
    });

    it("repoints the old species' cover at its newest remaining photo, clears the crop and recomputes the best rating", async () => {
      const older = await makeCapture(OWNER, SPECIES_A, 10, 2);
      const newer = await makeCapture(OWNER, SPECIES_A, 5, 3);
      const moving = await makeCapture(OWNER, SPECIES_A, 1, 5);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, best_quality, card_crop_x, card_crop_y, card_crop_size)
         VALUES ($1, $2, 'collected', $3, 5, 0.1, 0.2, 0.3)`,
        [OWNER, SPECIES_A, moving.photoId],
      );
      expect(
        (await call("PATCH", `/api/captures/${moving.captureId}/reassign`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(200);
      expect(await userSpecies(OWNER, SPECIES_A)).toEqual({
        state: "collected",
        cover_photo_id: newer.photoId,
        best_quality: 3,
        card_crop_x: null,
        is_target: false,
      });
      expect(await userSpecies(OWNER, SPECIES_B)).toMatchObject({ state: "collected", cover_photo_id: moving.photoId });
      expect(older.photoId).not.toBe(newer.photoId);
    });

    it("keeps the old species' cover and crop when another photo was the cover", async () => {
      const cover = await makeCapture(OWNER, SPECIES_A, 10, 4);
      const moving = await makeCapture(OWNER, SPECIES_A, 1, 1);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, best_quality, card_crop_x, card_crop_y, card_crop_size)
         VALUES ($1, $2, 'collected', $3, 4, 0.5, 0.5, 0.5)`,
        [OWNER, SPECIES_A, cover.photoId],
      );
      expect(
        (await call("PATCH", `/api/captures/${moving.captureId}/reassign`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(200);
      expect(await userSpecies(OWNER, SPECIES_A)).toMatchObject({
        cover_photo_id: cover.photoId,
        card_crop_x: 0.5,
        best_quality: 4,
      });
    });

    it("keeps the old species collected when another photo is tagged with it", async () => {
      const moving = await makeCapture(OWNER, SPECIES_A, 1);
      const tagged = await makeCapture(OWNER, SPECIES_C, 2);
      await db.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`, [
        tagged.captureId,
        SPECIES_A,
      ]);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id) VALUES ($1, $2, 'collected', $3)`,
        [OWNER, SPECIES_A, moving.photoId],
      );
      expect(
        (await call("PATCH", `/api/captures/${moving.captureId}/reassign`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(200);
      expect(await userSpecies(OWNER, SPECIES_A)).toMatchObject({ state: "collected", cover_photo_id: tagged.photoId });
    });

    it("keeps a target species' row, stripped of its photo, when its last capture moves away", async () => {
      const moving = await makeCapture(OWNER, SPECIES_A, 1, 4);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, best_quality, card_crop_x, card_crop_y, card_crop_size, is_target)
         VALUES ($1, $2, 'collected', $3, 4, 0.1, 0.1, 0.1, true)`,
        [OWNER, SPECIES_A, moving.photoId],
      );
      expect(
        (await call("PATCH", `/api/captures/${moving.captureId}/reassign`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(200);
      expect(await userSpecies(OWNER, SPECIES_A)).toEqual({
        state: null,
        cover_photo_id: null,
        best_quality: null,
        card_crop_x: null,
        is_target: true,
      });
    });

    it("drops a non-target species with no capture left", async () => {
      const moving = await makeCapture(OWNER, SPECIES_A, 1);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id) VALUES ($1, $2, 'collected', $3)`,
        [OWNER, SPECIES_A, moving.photoId],
      );
      expect(
        (await call("PATCH", `/api/captures/${moving.captureId}/reassign`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(200);
      expect(await userSpecies(OWNER, SPECIES_A)).toBeUndefined();
    });

    it("leaves another user's collection alone", async () => {
      const mine = await makeCapture(OWNER, SPECIES_A, 1);
      const theirs = await makeCapture(OTHER, SPECIES_A, 1);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id) VALUES ($1, $3, 'collected', $4), ($2, $3, 'collected', $5)`,
        [OWNER, OTHER, SPECIES_A, mine.photoId, theirs.photoId],
      );
      expect(
        (await call("PATCH", `/api/captures/${mine.captureId}/reassign`, { speciesId: SPECIES_B })).statusCode,
      ).toBe(200);
      expect(await userSpecies(OTHER, SPECIES_A)).toMatchObject({ state: "collected", cover_photo_id: theirs.photoId });
    });
  });

  describe("date, place and rating", () => {
    it("sets and clears the capture date, refusing anything that isn't a date", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      const patch = (body: unknown) => call("PATCH", `/api/captures/${captureId}/taken-at`, body);
      const set = await patch({ takenAt: "2019-06-01T08:30:00Z" });
      expect([set.statusCode, set.json()]).toEqual([200, { ok: true }]);
      expect((await captureRow(captureId)).taken_at.toISOString()).toBe("2019-06-01T08:30:00.000Z");
      const bad = await patch({ takenAt: "not a date" });
      expect([bad.statusCode, bad.json()]).toEqual([400, { error: "takenAt must be a valid date, or null to clear" }]);
      expect((await captureRow(captureId)).taken_at.toISOString()).toBe("2019-06-01T08:30:00.000Z");
      expect((await patch({ takenAt: null })).statusCode).toBe(200);
      expect((await captureRow(captureId)).taken_at).toBeNull();
      for (const id of [NO_SUCH_SPECIES, "nope"]) {
        const res = await call("PATCH", `/api/captures/${id}/taken-at`, { takenAt: null });
        expect([res.statusCode, res.json()]).toEqual([404, { error: "Capture not found" }]);
      }
    });

    it("changes only the place fields sent, trimming the label and clearing a blank one", async () => {
      const { captureId } = await makeCapture(OWNER, SPECIES_A, 1);
      const patch = (body: unknown) => call("PATCH", `/api/captures/${captureId}/region`, body);
      const place = async () => {
        const row = await captureRow(captureId);
        return { region_id: row.region_id, location_label: row.location_label };
      };
      const set = await patch({ regionId, locationLabel: "  Kenai River  " });
      expect([set.statusCode, set.json()]).toEqual([200, { ok: true }]);
      expect(await place()).toEqual({ region_id: regionId, location_label: "Kenai River" });

      expect((await patch({ locationLabel: "Homer Spit" })).statusCode).toBe(200);
      expect(await place()).toEqual({ region_id: regionId, location_label: "Homer Spit" });
      expect((await patch({ regionId: null })).statusCode).toBe(200);
      expect(await place()).toEqual({ region_id: null, location_label: "Homer Spit" });
      expect((await patch({ locationLabel: "   " })).statusCode).toBe(200);
      expect(await place()).toEqual({ region_id: null, location_label: null });

      const bad = await patch({ regionId: "nope" });
      expect([bad.statusCode, bad.json()]).toEqual([
        400,
        { error: expect.stringMatching(/^Invalid body: regionId must be an id/), code: "invalid_request" },
      ]);
      for (const id of [NO_SUCH_SPECIES, "nope"]) {
        const res = await call("PATCH", `/api/captures/${id}/region`, { locationLabel: "x" });
        expect([res.statusCode, res.json()]).toEqual([404, { error: "Capture not found" }]);
      }
    });

    it("rates a photo 1 to 5 or clears it, keeping the species' best rating as the maximum", async () => {
      const a = await makeCapture(OWNER, SPECIES_A, 2, 3);
      const b = await makeCapture(OWNER, SPECIES_A, 1, null);
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, best_quality) VALUES ($1, $2, 'collected', 3)`,
        [OWNER, SPECIES_A],
      );
      const rate = (captureId: string, rating: unknown) =>
        call("PATCH", `/api/captures/${captureId}/rating`, { rating });

      const set = await rate(b.captureId, 5);
      expect([set.statusCode, set.json()]).toEqual([200, { ok: true }]);
      expect((await userSpecies(OWNER, SPECIES_A)).best_quality).toBe(5);
      expect((await rate(b.captureId, 1)).statusCode).toBe(200);
      expect((await userSpecies(OWNER, SPECIES_A)).best_quality).toBe(3);
      expect((await rate(a.captureId, null)).statusCode).toBe(200);
      expect((await captureRow(a.captureId)).quality_rating).toBeNull();
      expect((await userSpecies(OWNER, SPECIES_A)).best_quality).toBe(1);

      for (const bad of [0, 6, 2.5, "3", undefined]) {
        const res = await rate(b.captureId, bad);
        expect([bad, res.statusCode, res.json()]).toEqual([
          bad,
          400,
          { error: expect.stringMatching(/^Invalid body: rating /), code: "invalid_request" },
        ]);
      }
      for (const id of [NO_SUCH_SPECIES, "nope"]) {
        const res = await rate(id, 3);
        expect([res.statusCode, res.json()]).toEqual([404, { error: "Capture not found" }]);
      }
      expect((await captureRow(b.captureId)).quality_rating).toBe(1);
    });
  });
});
