// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run archive
// Archiving species one by one and in bulk, and the input each route refuses.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000601";
const SPECIES_A = "eeeeeeee-0000-4000-8000-00000000060a";
const SPECIES_B = "eeeeeeee-0000-4000-8000-00000000060b";
const NO_SUCH_SPECIES = "eeeeeeee-0000-4000-8000-0000000006ff";
const TOKEN = "lifer_test_archive_routes_601";

describe.skipIf(!url)("archive routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const call = (method: "GET" | "POST" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const archived = async () =>
    (
      await db.query(`SELECT species_id FROM user_archived_species WHERE user_id = $1 ORDER BY species_id`, [USER])
    ).rows.map((r) => r.species_id);

  async function cleanup() {
    await db.query(`DELETE FROM user_archived_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { archiveRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'archive-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 920601, 'Testus archivus', 'Archive Bird', 'aves'), ($2, 920602, 'Testus bulkus', 'Bulk Bird', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES_A, SPECIES_B],
    );

    app = Fastify();
    await app.register(cookie);
    await app.register(archiveRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B]]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("archives and unarchives one species, answering 404 for a malformed or unknown id", async () => {
    expect((await call("POST", `/api/species/${SPECIES_A}/archive`)).json()).toEqual({ ok: true });
    expect(await archived()).toEqual([SPECIES_A]);
    for (const id of ["nope", NO_SUCH_SPECIES]) {
      const res = await call("POST", `/api/species/${id}/archive`);
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Species not found" }]);
    }
    const bad = await call("DELETE", "/api/species/nope/archive");
    expect([bad.statusCode, bad.json()]).toEqual([404, { error: "Species not found" }]);
    expect((await call("DELETE", `/api/species/${SPECIES_A}/archive`)).json()).toEqual({ ok: true });
    expect(await archived()).toEqual([]);
  });

  it("archives in bulk, refusing a missing, empty, malformed or padded id list", async () => {
    for (const body of [
      {},
      { speciesIds: [] },
      { speciesIds: SPECIES_A },
      { speciesIds: ["nope"] },
      { speciesIds: [SPECIES_A], all: true },
    ]) {
      for (const method of ["POST", "DELETE"] as const) {
        const res = await call(method, "/api/archive/bulk", body);
        expect([method, body, res.statusCode, res.json().code]).toEqual([method, body, 400, "invalid_request"]);
      }
    }
    expect(await archived()).toEqual([]);

    const res = await call("POST", "/api/archive/bulk", { speciesIds: [SPECIES_A, SPECIES_B] });
    expect(res.json()).toEqual({ ok: true, archived: 2 });
    expect((await call("GET", "/api/archive")).json().items).toHaveLength(2);
    expect((await call("DELETE", "/api/archive/bulk", { speciesIds: [SPECIES_B] })).json()).toEqual({
      ok: true,
      unarchived: 1,
    });
    expect(await archived()).toEqual([SPECIES_A]);
  });
});
