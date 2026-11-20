// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer npx vitest run captures/hidden
// Hiding a photo takes it out of the life list like the Trash does, and unhiding brings it back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000801";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000080a";
const TOKEN = "lifer_test_hide_captures_801";

describe.skipIf(!url)("hiding photos", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  const capture = { featured: "", other: "" };
  const photo = { featured: "", other: "" };

  const call = (route: string, payload?: unknown) =>
    app.inject({
      method: payload ? "POST" : "GET",
      url: route,
      payload: payload as object,
      cookies: { [cookieName]: TOKEN },
    });

  const speciesRow = async () =>
    (
      await db.query<{ cover_photo_id: string | null; state: string | null }>(
        `SELECT cover_photo_id, state FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [USER, SPECIES],
      )
    ).rows[0];

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-hide-captures-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'hide-captures@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 920801, 'Testus celatus', 'Hide Bird', 'aves')`,
      [SPECIES],
    );
    for (const key of ["featured", "other"] as const) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, `hide-captures-${key}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      capture[key] = c.rows[0].id;
      photo[key] = p.rows[0].id;
    }
    await db.query(
      // A featured photo the user picked themselves.
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, cover_chosen_photo_id, first_collected)
       VALUES ($1, $2, 'collected', $3, $3, CURRENT_DATE)`,
      [USER, SPECIES, photo.featured],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
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

  it("hides the featured photo, moving the species cover to another photo", async () => {
    const res = await call("/api/captures/hide", { captureIds: [capture.featured] });
    expect(res.json()).toStrictEqual({ hidden: 1, covers: [{ speciesId: SPECIES, photoId: photo.featured }] });
    expect(await speciesRow()).toEqual({ cover_photo_id: photo.other, state: "collected" });
    expect((await call("/api/captures/hidden-count")).json()).toStrictEqual({ count: 1 });
    // Already hidden: nothing to do.
    expect((await call("/api/captures/hide", { captureIds: [capture.featured] })).json()).toStrictEqual({
      hidden: 0,
      covers: [],
    });
  });

  it("stops counting the species as collected once every photo is hidden", async () => {
    // The featured photo moved here by itself, so an undo has nothing of the user's to put back.
    const res = await call("/api/captures/hide", { captureIds: [capture.other] });
    expect(res.json()).toStrictEqual({ hidden: 1, covers: [] });
    expect(await speciesRow()).toEqual({ cover_photo_id: null, state: null });
  });

  it("brings the species back on unhide", async () => {
    const res = await call("/api/captures/unhide", { captureIds: [capture.featured, capture.other] });
    expect(res.json()).toStrictEqual({ unhidden: 2 });
    expect((await speciesRow()).state).toBe("collected");
    expect((await call("/api/captures/hidden-count")).json()).toStrictEqual({ count: 0 });
  });

  it("rejects an empty list", async () => {
    expect((await call("/api/captures/hide", { captureIds: [] })).statusCode).toBe(400);
  });
});
