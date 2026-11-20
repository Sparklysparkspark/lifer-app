// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Bulk target, seen and archive on Collection, and the reverse call that undoes each.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000701";
const SP = ["a", "b", "c"].map((c) => `eeeeeeee-0000-4000-8000-00000000070${c}`);
const TOKEN = "lifer_test_collection_bulk_701";

describe.skipIf(!url)("collection bulk route", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const bulk = async (action: string, speciesIds: string[]) =>
    (
      await app.inject({
        method: "POST",
        url: "/api/collection/bulk",
        payload: { action, speciesIds },
        cookies: { [cookieName]: TOKEN },
      })
    ).json();
  const rows = async () =>
    (await db.query(`SELECT species_id, state, is_target FROM user_species WHERE user_id = $1`, [USER])).rows;

  async function cleanup() {
    await db.query(`DELETE FROM user_archived_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { collectionBulkRoutes } = await import("./bulk.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'collection-bulk@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    for (const [i, id] of SP.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $3, 'aves')
         ON CONFLICT (id) DO NOTHING`,
        [id, 920701 + i, `Testus bulkus ${i}`],
      );
    }
    app = Fastify();
    await app.register(cookie);
    await app.register(collectionBulkRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("marks seen without touching collected, and undo reverses only what changed", async () => {
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [USER, SP[0]]);
    const done = await bulk("seen", SP);
    expect(done.changedIds.sort()).toEqual([SP[1], SP[2]].sort());
    expect((await rows()).find((r) => r.species_id === SP[0])!.state).toBe("collected");
    await bulk("unseen", done.changedIds);
    expect((await rows()).map((r) => r.species_id)).toEqual([SP[0]]);
  });

  it("adds and removes targets in one call", async () => {
    const done = await bulk("target", SP);
    expect(done.changedIds).toHaveLength(3);
    expect((await bulk("target", SP)).changedIds).toEqual([]);
    await bulk("untarget", done.changedIds);
    expect((await rows()).some((r) => r.is_target)).toBe(false);
  });

  it("archives only species not collected or seen, and unarchives", async () => {
    await bulk("seen", [SP[1]]);
    const done = await bulk("archive", SP);
    expect(done.changedIds).toEqual([SP[2]]);
    expect((await bulk("unarchive", done.changedIds)).changedIds).toEqual([SP[2]]);
  });

  it("refuses an empty list", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/collection/bulk",
      payload: { action: "seen", speciesIds: [] },
      cookies: { [cookieName]: TOKEN },
    });
    expect(res.statusCode).toBe(400);
  });
});
