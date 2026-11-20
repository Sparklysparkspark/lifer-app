// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A key with only imports.write may start uploads of new photos and nothing else.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000831";
const PLUGIN = "com.example.imports-scope";

describe.skipIf(!url)("imports.write on uploads", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let key: string;

  const call = (method: "POST" | "PUT", route: string) =>
    app.inject({ method, url: route, headers: { "x-api-key": key, "x-lifer-client": "1" } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'imports-scope@test', 'x')`, [USER]);
    const { issuePluginKey } = await import("../plugins/pairing.js");
    key = await issuePluginKey(USER, PLUGIN, "Importer", ["imports.write"]);
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db?.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("reaches the upload routes but not photo editing", async () => {
    expect((await call("POST", "/api/uploads/tus")).statusCode).not.toBe(401);
    expect((await call("POST", "/api/uploads/inspect")).statusCode).not.toBe(401);
    expect((await call("POST", "/api/imports/v1/folders")).statusCode).not.toBe(401);
    const edit = await app.inject({
      method: "PATCH",
      url: "/api/captures/00000000-0000-4000-8000-000000000000/tags",
      headers: { "x-api-key": key, "x-lifer-client": "1" },
      payload: { tags: [] },
    });
    expect(edit.statusCode).toBe(401);
  });
});
