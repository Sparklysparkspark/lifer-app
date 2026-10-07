// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run captures
// Batch trash, emptying the trash (covers repointed, derivative files removed) and a species
// correction that carries the card framing and leaves the old species with nothing behind it.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000201";
const SPECIES_A = "eeeeeeee-0000-4000-8000-00000000000a";
const SPECIES_B = "eeeeeeee-0000-4000-8000-00000000000b";
const TOKEN = "lifer_test_trash_session_201";

describe.skipIf(!url)("captures trash and reassign", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let appDataDir: string;
  let cookieName: string;
  const captures: string[] = [];
  const photos: string[] = [];
  let albumId: string;
  let linkedFile: string;

  const call = (method: "POST" | "PATCH" | "DELETE", url: string, payload?: unknown) =>
    app.inject({ method, url, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-trash-"));
    appDataDir = path.join(dataDir, "app-data");
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = appDataDir;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'trash@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [hashToken(TOKEN), USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 920101, 'Testus trashus', 'Trash Bird', 'aves'), ($2, 920102, 'Testus fixus', 'Fixed Bird', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES_A, SPECIES_B],
    );
    mkdirSync(path.join(appDataDir, "medium"), { recursive: true });
    for (let i = 0; i < 3; i++) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, now() - ($4 || ' days')::interval) RETURNING id`,
        [USER, SPECIES_A, `trash-${i}`, String(3 - i)],
      );
      const display = path.join(dataDir, `d${i}.webp`);
      writeFileSync(display, "x");
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id, display],
      );
      writeFileSync(path.join(appDataDir, "medium", `${p.rows[0].id}.webp`), "x");
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      captures.push(c.rows[0].id);
      photos.push(p.rows[0].id);
    }
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected) VALUES ($1, $2, 'collected', $3, CURRENT_DATE)`,
      [USER, SPECIES_A, photos[0]],
    );
    // Capture 0 has a JPEG Lifer stored in the library; capture 1 links a file it doesn't own.
    const storedDir = path.join(dataDir, "Birds", "Trash Bird");
    mkdirSync(storedDir, { recursive: true });
    writeFileSync(path.join(storedDir, "stored.jpg"), "x");
    const linkedDir = mkdtempSync(path.join(tmpdir(), "lifer-linked-"));
    writeFileSync(path.join(linkedDir, "linked.jpg"), "x");
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size) VALUES
         ($1, 'jpeg', 'path', $2, true, $5, 'trash-stored', 1), ($3, 'jpeg', 'path', $4, false, $5, 'trash-linked', 1)`,
      [captures[0], path.join(storedDir, "stored.jpg"), captures[1], path.join(linkedDir, "linked.jpg"), USER],
    );
    linkedFile = path.join(linkedDir, "linked.jpg");

    const album = await db.query<{ id: string }>(
      `INSERT INTO albums (user_id, name, cover_photo_id) VALUES ($1, 'Test', $2) RETURNING id`,
      [USER, photos[0]],
    );
    albumId = album.rows[0].id;
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2), ($1, $3)`, [albumId, captures[0], captures[2]]);

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B]]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("rejects an oversized batch and trashes a batch in one go", async () => {
    const tooMany = Array.from({ length: 5001 }, () => captures[0]);
    expect((await call("POST", "/api/captures/batch-delete", { captureIds: tooMany })).statusCode).toBe(400);

    // A malformed id fails the whole batch; an unknown one only counts as not found.
    const malformed = await call("POST", "/api/captures/batch-delete", { captureIds: [captures[0], "not-a-uuid"] });
    expect([malformed.statusCode, malformed.json().code]).toEqual([400, "invalid_request"]);
    const unknownId = "eeeeeeee-0000-4000-8000-0000000002ff";
    const res = await call("POST", "/api/captures/batch-delete", { captureIds: [captures[0], captures[1], unknownId] });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ deleted: 2, notFound: 1 });
  });

  it("empties the trash, repoints covers and removes derivative files", async () => {
    const res = await call("POST", "/api/trash/empty", {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ purged: 2 });

    const left = await db.query(`SELECT id FROM captures_all WHERE user_id = $1`, [USER]);
    expect(left.rows.map((r) => r.id)).toEqual([captures[2]]);
    const us = await db.query(`SELECT cover_photo_id FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES_A]);
    expect(us.rows[0].cover_photo_id).toBe(photos[2]);
    const album = await db.query(`SELECT cover_photo_id FROM albums WHERE id = $1`, [albumId]);
    expect(album.rows[0].cover_photo_id).toBe(photos[2]);
    expect(existsSync(path.join(dataDir, "d0.webp"))).toBe(false);
    expect(existsSync(path.join(appDataDir, "medium", `${photos[0]}.webp`))).toBe(false);
    expect(existsSync(path.join(appDataDir, "medium", `${photos[2]}.webp`))).toBe(true);
    // The stored JPEG and its now-empty species folder are gone; a linked file is never touched.
    expect(existsSync(path.join(dataDir, "Birds", "Trash Bird", "stored.jpg"))).toBe(false);
    expect(existsSync(path.join(dataDir, "Birds", "Trash Bird"))).toBe(false);
    expect(existsSync(linkedFile)).toBe(true);
    rmSync(path.dirname(linkedFile), { recursive: true, force: true });
  });

  it("moves the last capture to another species, carrying its card framing, and drops the empty old one", async () => {
    await db.query(
      `UPDATE user_species SET card_crop_x = 10, card_crop_y = 20, card_crop_size = 30 WHERE user_id = $1 AND species_id = $2`,
      [USER, SPECIES_A],
    );
    const res = await call("PATCH", `/api/captures/${captures[2]}/reassign`, { speciesId: SPECIES_B });
    expect(res.statusCode, res.body).toBe(200);
    const rows = await db.query<{ species_id: string; state: string; cover_photo_id: string; card_crop_x: number; card_crop_y: number; card_crop_size: number }>(
      `SELECT species_id, state, cover_photo_id, card_crop_x::float AS card_crop_x, card_crop_y::float AS card_crop_y, card_crop_size::float AS card_crop_size FROM user_species WHERE user_id = $1 ORDER BY species_id`,
      [USER],
    );
    expect(rows.rows).toEqual([
      { species_id: SPECIES_B, state: "collected", cover_photo_id: photos[2], card_crop_x: 10, card_crop_y: 20, card_crop_size: 30 },
    ]);
  });

  it("answers 404 for a malformed capture id", async () => {
    expect((await call("PATCH", "/api/captures/nope/tags", { tags: ["a"] })).statusCode).toBe(404);
    expect((await call("PATCH", "/api/captures/nope/rating", { rating: 3 })).statusCode).toBe(404);
    expect((await call("POST", "/api/trash/nope/restore", {})).statusCode).toBe(404);
  });

  it("refuses a malformed species or region id in the body", async () => {
    const tag = await call("POST", `/api/captures/${captures[2]}/species`, { speciesId: "nope" });
    expect(tag.statusCode).toBe(400);
    expect(tag.json()).toEqual({ error: expect.stringMatching(/^Invalid body: speciesId must be an id/), code: "invalid_request" });
    expect((await call("PATCH", `/api/captures/${captures[2]}/reassign`, { speciesId: "nope" })).statusCode).toBe(400);
    expect((await call("PATCH", `/api/captures/${captures[2]}/region`, { regionId: "nope" })).statusCode).toBe(400);
  });

  it("validates trash and tag input", async () => {
    const invalid = (res: { statusCode: number; json: () => { code?: string; error?: string } }) => [
      res.statusCode,
      res.json().code,
    ];
    const batch = (body: unknown) => call("POST", "/api/captures/batch-delete", body);
    expect(invalid(await batch({}))).toEqual([400, "invalid_request"]);
    expect(invalid(await batch({ captureIds: [] }))).toEqual([400, "invalid_request"]);
    expect(invalid(await batch({ captureIds: captures[2] }))).toEqual([400, "invalid_request"]);
    expect(invalid(await batch({ captureIds: [captures[2]], deleteRaw: "yes" }))).toEqual([400, "invalid_request"]);
    expect((await batch({ captureIds: [captures[2]], extra: 1 })).json().error).toBe("Invalid body: unexpected field extra");
    // A malformed id is a 404 like an unknown one; deleteRaw only takes "1".
    expect((await call("DELETE", "/api/captures/nope")).json()).toEqual({ error: "Capture not found" });
    expect(invalid(await call("DELETE", `/api/captures/${captures[2]}?deleteRaw=yes`))).toEqual([400, "invalid_request"]);

    const tagsUrl = `/api/captures/${captures[2]}/tags`;
    expect(invalid(await call("PATCH", tagsUrl, { tags: "flight" }))).toEqual([400, "invalid_request"]);
    expect(invalid(await call("PATCH", tagsUrl, { tags: [1] }))).toEqual([400, "invalid_request"]);
    expect(invalid(await call("PATCH", tagsUrl, {}))).toEqual([400, "invalid_request"]);
    const tagged = await call("PATCH", tagsUrl, { tags: [" flight ", "flight", ""] });
    expect([tagged.statusCode, tagged.json()]).toEqual([200, { tags: ["flight"] }]);

    const bulk = (body: unknown) => call("PATCH", "/api/captures/tags", body);
    expect(invalid(await bulk({ captureIds: ["nope"], tags: ["a"] }))).toEqual([400, "invalid_request"]);
    expect(invalid(await bulk({ captureIds: [], tags: ["a"] }))).toEqual([400, "invalid_request"]);
    expect((await bulk({ captureIds: [captures[2]], tags: ["perched"] })).json()).toEqual({ ok: true, updated: 1 });
    expect(invalid(await call("PATCH", "/api/captures/tags/rename", { from: "perched" }))).toEqual([400, "invalid_request"]);
    expect((await call("PATCH", "/api/captures/tags/rename", { from: " ", to: "x" })).statusCode).toBe(400);
    const renamed = await call("PATCH", "/api/captures/tags/rename", { from: "perched", to: "sitting" });
    expect(renamed.json()).toEqual({ ok: true, updated: 1 });
    expect(invalid(await call("DELETE", "/api/captures/tags", { tag: 3 }))).toEqual([400, "invalid_request"]);
    expect((await call("DELETE", "/api/captures/tags", { tag: "sitting" })).json()).toEqual({ ok: true, updated: 1 });
  });
});
