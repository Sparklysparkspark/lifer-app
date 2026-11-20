// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run trips/routes
// Request validation on the trip routes: malformed input is refused before a handler runs, a
// malformed trip id answers 404 like an unknown one, and the requests the web app sends still work.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000641";
const TOKEN = "lifer_test_trip_routes_owner_641";
const NO_SUCH_TRIP = "eeeeeeee-0000-4000-8000-0000000006ff";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000064a";

const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("trip route validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let sourceFolder: string;
  let cookieName: string;
  let tripId: string;

  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    // Real path: the destination check compares the resolved source folder with DATA_DIR, and
    // macOS's temp folder is a symlink.
    dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-trip-routes-")));
    sourceFolder = path.join(dataDir, "Costa Rica");
    mkdirSync(sourceFolder);
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { tripsRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'trip-routes@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.ready();

    const created = await call("POST", "/api/trips", { name: "Costa Rica", sourceFolder });
    expect(created.statusCode).toBe(201);
    tripId = created.json().id;
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("limits trip names to 255 characters on create, start and rename", async () => {
    const tooLong = "t".repeat(256);
    const create = await call("POST", "/api/trips", { name: tooLong, sourceFolder });
    expect([create.statusCode, create.json().error]).toEqual([400, "Names can be at most 255 characters"]);
    const start = await call("POST", "/api/trips/start", { name: tooLong, startDate: "2026-05-01" });
    expect(start.statusCode).toBe(400);
    expect((await call("PATCH", `/api/trips/${tripId}`, { name: tooLong })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/trips/${tripId}`, { name: "t".repeat(255) })).statusCode).toBe(200);
    expect((await call("POST", "/api/trips", { name: "t".repeat(255), sourceFolder })).statusCode).toBe(201);
  });

  it("creates a trip from the web app's request, and refuses a missing, mistyped or extra field", async () => {
    // The web app leaves name and destinationFolder out when they're empty.
    const ok = await call("POST", "/api/trips", { sourceFolder, destinationFolder: path.join(dataDir, "Out") });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ id: expect.any(String), destinationFolder: path.join(dataDir, "Out") });

    expect((await call("POST", "/api/trips", { name: "x" })).json()).toEqual(
      invalid(/^Invalid body: sourceFolder is required$/),
    );
    const typed = await call("POST", "/api/trips", { sourceFolder: 7 });
    expect([typed.statusCode, typed.json()]).toEqual([400, invalid(/^Invalid body: sourceFolder must be string$/)]);
    const extra = await call("POST", "/api/trips", { sourceFolder, owner: OWNER });
    expect([extra.statusCode, extra.json()]).toEqual([400, invalid(/unexpected field owner/)]);
    // The path rules still apply once the shape is right.
    const relative = await call("POST", "/api/trips", { sourceFolder: "relative/folder" });
    expect([relative.statusCode, relative.json()]).toEqual([
      400,
      { error: "sourceFolder must be an absolute folder path" },
    ]);
  });

  it("keeps a destination folder inside the library, whatever its last segment", async () => {
    mkdirSync(path.join(dataDir, "a", "b"), { recursive: true });
    const dotDot = await call("POST", "/api/trips", {
      sourceFolder,
      destinationFolder: path.join(dataDir, "a", "b", ".."),
    });
    expect([dotDot.statusCode, dotDot.json().destinationFolder]).toEqual([201, path.join(dataDir, "a")]);
    expect(existsSync(path.join(path.dirname(dataDir), "b"))).toBe(false);

    const outside = mkdtempSync(path.join(tmpdir(), "lifer-trip-outside-"));
    try {
      symlinkSync(outside, path.join(dataDir, "Escape"));
      const linked = await call("POST", "/api/trips", {
        sourceFolder,
        destinationFolder: path.join(dataDir, "Escape"),
      });
      expect(linked.statusCode).toBe(403);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("answers 404 for a malformed or unknown trip id on every kind of route", async () => {
    for (const id of ["nope", NO_SUCH_TRIP]) {
      for (const [method, route, body] of [
        ["GET", `/api/trips/${id}`, undefined],
        ["GET", `/api/trips/${id}/photos`, undefined],
        ["PATCH", `/api/trips/${id}`, { name: "x" }],
        ["DELETE", `/api/trips/${id}`, undefined],
        ["POST", `/api/trips/${id}/scan`, {}],
        ["GET", `/api/trips/${id}/import/status`, undefined],
      ] as const) {
        const res = await call(method, route, body);
        expect([id, route, res.statusCode, res.json()]).toEqual([id, route, 404, { error: "Trip not found" }]);
      }
    }
  });

  it("shows each species by the trip's own best photo, not its featured one", async () => {
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 920641, 'Testus tripus', 'Trip Bird', 'aves')`,
      [SPECIES],
    );
    const photoFor = async (fingerprint: string, rating: number | null, tripOrNull: string | null) => {
      const capture = (
        await db.query<{ id: string }>(
          `INSERT INTO captures (user_id, species_id, fingerprint, quality_rating, trip_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [OWNER, SPECIES, fingerprint, rating, tripOrNull],
        )
      ).rows[0].id;
      const photo = (
        await db.query<{ id: string }>(
          `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
          [capture],
        )
      ).rows[0].id;
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photo, capture]);
      return photo;
    };
    const featured = await photoFor("trip-species-featured", 5, null);
    await photoFor("trip-species-low", 1, tripId);
    const best = await photoFor("trip-species-best", 3, tripId);
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected) VALUES ($1, $2, 'collected', $3, CURRENT_DATE)`,
      [OWNER, SPECIES, featured],
    );
    expect((await call("GET", `/api/trips/${tripId}/species`)).json().items).toEqual([
      expect.objectContaining({ speciesId: SPECIES, coverPhotoUrl: `/api/photos/${best}/thumb` }),
    ]);
  });

  // Remembered state (docs/docs/contributing/remembered-state.md): a trip whose folder is gone.
  it("still opens a trip whose folder is gone, and a scan marks its photos missing, not deleted", async () => {
    const folder = path.join(dataDir, "Unplugged");
    mkdirSync(folder);
    const id = (await call("POST", "/api/trips", { name: "Unplugged", sourceFolder: folder })).json().id;
    const capture = (
      await db.query<{ id: string }>(
        // SPECIES is made by the test above.
        `INSERT INTO captures (user_id, species_id, fingerprint, trip_id) VALUES ($1, $2, 'trip-unplugged', $3) RETURNING id`,
        [OWNER, SPECIES, id],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, 'jpeg', 'path', $2, false, 'trip-unplugged-hash', 1)`,
      [capture, path.join(folder, "Wildlife", "a.jpg")],
    );
    rmSync(folder, { recursive: true });

    expect((await call("GET", `/api/trips/${id}`)).statusCode).toBe(200);
    expect((await call("GET", "/api/trips")).statusCode).toBe(200);
    const { scanTrip } = await import("./scan.js");
    const result = await scanTrip(id, OWNER, folder, path.join(folder, "Wildlife"));
    expect(result).toMatchObject({ markedStale: 1, newFiles: [] });
    const original = await db.query(`SELECT stale FROM originals WHERE capture_id = $1`, [capture]);
    expect(original.rows).toEqual([{ stale: true }]);

    // Its photos still list, a RAW-only one marked as such for the web's RAW files filter.
    const rawCapture = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, trip_id) VALUES ($1, $2, 'trip-unplugged-raw', $3) RETURNING id`,
        [OWNER, SPECIES, id],
      )
    ).rows[0].id;
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, 'raw', 'path', $2, false, 'trip-unplugged-raw-hash', 1)`,
      [rawCapture, path.join(folder, "Wildlife", "b.cr3")],
    );
    for (const c of [capture, rawCapture]) {
      await db.query(
        `WITH p AS (INSERT INTO photos (capture_id, display_path, thumb_path)
           VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id)
         UPDATE captures_all SET current_photo_id = (SELECT id FROM p) WHERE id = $1`,
        [c],
      );
    }
    const photos = (await call("GET", `/api/trips/${id}/photos`)).json().items;
    expect(photos.map((p: { captureId: string; originalKind: string }) => [p.captureId, p.originalKind]).sort()).toEqual(
      [
        [capture, "jpeg"],
        [rawCapture, "raw"],
      ].sort(),
    );
  });

  it("updates a trip the way the web app does, refusing an unknown layout or extra field", async () => {
    expect((await call("PATCH", `/api/trips/${tripId}`, { description: "" })).json()).toEqual({ ok: true });
    expect((await call("PATCH", `/api/trips/${tripId}`, { coverLayout: "quad" })).json()).toEqual({ ok: true });
    expect((await call("GET", `/api/trips/${tripId}`)).json()).toMatchObject({
      coverLayout: "quad",
      description: null,
    });

    const layout = await call("PATCH", `/api/trips/${tripId}`, { coverLayout: "grid" });
    expect([layout.statusCode, layout.json()]).toEqual([
      400,
      invalid(/^Invalid body: coverLayout must be one of single, quad$/),
    ]);
    const extra = await call("PATCH", `/api/trips/${tripId}`, { name: "x", userId: OWNER });
    expect([extra.statusCode, extra.json()]).toEqual([400, invalid(/unexpected field userId/)]);
    const empty = await call("PATCH", `/api/trips/${tripId}`, {});
    expect(empty.statusCode).toBe(400);
  });

  it("checks a cover pick and crop: a uuid or null, numbers within 0-100", async () => {
    const cover = await call("PUT", `/api/trips/${tripId}/cover`, { captureId: "nope" });
    expect([cover.statusCode, cover.json()]).toEqual([400, invalid(/^Invalid body: captureId /)]);
    expect((await call("PUT", `/api/trips/${tripId}/cover`, {})).statusCode).toBe(400);
    expect((await call("PUT", `/api/trips/${tripId}/cover`, { captureId: null })).json()).toEqual({ ok: true });

    for (const body of [
      { x: 101, y: 0, size: 10 },
      { x: 0, y: -1, size: 10 },
      { x: 0, y: 0, size: 0 },
      { x: "5", y: 0, size: 5 },
    ]) {
      const res = await call("PATCH", `/api/trips/${tripId}/cover-crop`, body);
      expect([body, res.statusCode, res.json().code]).toEqual([body, 400, "invalid_request"]);
    }
    // A valid crop gets past validation to the handler's own rule: there's no cover yet.
    const crop = await call("PATCH", `/api/trips/${tripId}/cover-crop`, { x: 10, y: 10, size: 50 });
    expect([crop.statusCode, crop.json()]).toEqual([400, { error: "No cover photo set for this trip yet" }]);
  });

  it("checks an import request's files and region before starting a job", async () => {
    const importing = (body: unknown) => call("POST", `/api/trips/${tripId}/import`, body);
    expect((await importing({ files: [] })).json()).toEqual(invalid(/^Invalid body: files must /));
    expect((await importing({ files: [{ relativePath: "a.jpg", speciesId: "nope" }] })).json()).toEqual(
      invalid(/^Invalid body: files\.0\.speciesId must be an id/),
    );
    expect(
      (await importing({ files: [{ relativePath: "a.jpg", speciesId: NO_SUCH_TRIP }], regionId: 5 })).statusCode,
    ).toBe(400);
    const inspect = await call("POST", `/api/trips/${tripId}/inspect`, { regionId: null });
    expect([inspect.statusCode, inspect.json()]).toEqual([400, invalid(/^Invalid body: relativePath is required$/)]);
    const preview = await call("GET", `/api/trips/${tripId}/scan-preview`);
    expect([preview.statusCode, preview.json()]).toEqual([400, invalid(/^Invalid query: file is required$/)]);
  });
});
