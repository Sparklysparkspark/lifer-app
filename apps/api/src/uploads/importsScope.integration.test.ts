// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// A key with only imports.write may start uploads of new photos and nothing else, except adding a
// species to a photo it uploaded itself.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000831";
const PLUGIN = "com.example.imports-scope";
const PRIMARY = "eeeeeeee-0000-4000-8000-0000000008a1";
const EXTRA = "eeeeeeee-0000-4000-8000-0000000008a2";

describe.skipIf(!url)("imports.write on uploads", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let key: string;
  let dataDir: string;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  const call = (method: "POST" | "PUT", route: string) =>
    app.inject({ method, url: route, headers: { "x-api-key": key, "x-lifer-client": "1" } });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-imports-scope-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    for (const [id, gbif, name] of [
      [PRIMARY, 910871, "Testus importscopus"],
      [EXTRA, 910872, "Testus importextrus"],
    ])
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'aves') ON CONFLICT (id) DO NOTHING`,
        [id, gbif, name],
      );
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'imports-scope@test', 'x')`, [USER]);
    const { issuePluginKey } = await import("../plugins/pairing.js");
    key = await issuePluginKey(USER, PLUGIN, "Importer", ["imports.write"]);
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(multipart);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) await cleanup();
    await db?.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[PRIMARY, EXTRA]]);
    await db?.end();
    rmSync(dataDir, { recursive: true, force: true });
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

  it("adds a species to a photo the key uploaded, and only that one", async () => {
    const bytes = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 9, g: 90, b: 40 } } })
      .jpeg()
      .toBuffer();
    const form = new FormData();
    form.append("speciesId", PRIMARY);
    form.append("file", new Blob([new Uint8Array(bytes)], { type: "image/jpeg" }), "IMG_0001.jpg");
    const body = new Response(form);
    const upload = await app.inject({
      method: "POST",
      url: "/api/uploads",
      headers: { "x-api-key": key, "content-type": body.headers.get("content-type")! },
      payload: Buffer.from(await body.arrayBuffer()),
    });
    expect(upload.statusCode, upload.body).toBe(201);
    const { captureId } = upload.json() as { captureId: string };
    const add = (id: string) =>
      app.inject({
        method: "POST",
        url: `/api/captures/${id}/species`,
        headers: { "x-api-key": key, "x-lifer-client": "1" },
        payload: { speciesId: EXTRA },
      });
    expect((await add(captureId)).statusCode).toBe(201);
    const other = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, 'imports-scope-other') RETURNING id`,
      [USER, PRIMARY],
    );
    const refused = await add(other.rows[0].id);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: "not_imported_by_key" });
  });
});
