// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The eBird import takes a multipart CSV, which its handler checks itself (there's no JSON body
// for a schema to describe): it still refuses a request without a file and imports a good one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000831";
const TOKEN = "lifer_test_imports_routes_831";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000083a";
const BOUNDARY = "----lifer-test-boundary";

function csvForm(csv: string): string {
  return [
    `--${BOUNDARY}`,
    'Content-Disposition: form-data; name="file"; filename="MyEBirdData.csv"',
    "Content-Type: text/csv",
    "",
    csv,
    `--${BOUNDARY}--`,
    "",
  ].join("\r\n");
}

describe.skipIf(!url)("eBird CSV import", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;

  const post = (payload: string, contentType: string) =>
    app.inject({
      method: "POST",
      url: "/api/imports/ebird-csv",
      payload,
      headers: { "content-type": contentType },
      cookies: { [cookieName]: TOKEN },
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-imports-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { importRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'imports-routes@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 920831, 'Importus testus', 'Import Bird', 'aves')`,
      [SPECIES],
    );
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
    await app.register(importRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a CSV without a Scientific Name column", async () => {
    const res = await post(csvForm("Common Name,Count\nImport Bird,1"), `multipart/form-data; boundary=${BOUNDARY}`);
    expect([res.statusCode, res.json()]).toEqual([400, { error: 'CSV must have a "Scientific Name" column' }]);
  });

  it("marks the matched species as seen", async () => {
    const csv = "Common Name,Scientific Name\nImport Bird,Importus testus\nNobody,Nonexistus nullus";
    const res = await post(csvForm(csv), `multipart/form-data; boundary=${BOUNDARY}`);
    expect([res.statusCode, res.json()]).toEqual([
      200,
      { totalRows: 2, uniqueSpecies: 2, matched: 1, alreadySeenOrCollected: 0, unmatched: 1 },
    ]);
    const row = await db.query(`SELECT state FROM user_species WHERE user_id = $1 AND species_id = $2`, [
      USER,
      SPECIES,
    ]);
    expect(row.rows).toEqual([{ state: "seen" }]);
  });
});
