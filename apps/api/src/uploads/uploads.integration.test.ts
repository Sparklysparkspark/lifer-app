// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run uploads
// Several photos of a species that isn't in the collection yet, uploaded at the same time: the
// batch that froze a self-hosted server. Every upload must finish and land in its own file.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000108";
const SPECIES = "dddddddd-0000-4000-8000-00000000000a";
const TOKEN = "lifer_test_upload_token_108";

async function jpeg(shade: number): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } })
    .jpeg()
    .toBuffer();
}

async function multipartBody(fields: Record<string, string>, file: { name: string; bytes: Buffer }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", new Blob([new Uint8Array(file.bytes)], { type: "image/jpeg" }), file.name);
  const res = new Response(form);
  return { payload: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type")! };
}

describe.skipIf(!url)("uploads", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-uploads-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { uploadRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'uploads@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910801, 'Testus pileatus', 'Test Woodpecker', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.write"],
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("../db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("files every photo of a batch for a new species, even with the same file name", async () => {
    const shots = await Promise.all([10, 60, 110, 160].map(jpeg));
    const responses = await Promise.all(
      shots.map(async (bytes) => {
        const { payload, contentType } = await multipartBody({ speciesId: SPECIES }, { name: "IMG_0001.jpg", bytes });
        return app.inject({
          method: "POST",
          url: "/api/uploads",
          headers: { "x-api-key": TOKEN, "content-type": contentType },
          payload,
        });
      }),
    );
    for (const res of responses) expect(res.statusCode, res.body).toBe(201);

    // A new library: the chosen folder is the library itself, no "Lifer Photos" level.
    const folder = path.join(dataDir, "Birds", "Test Woodpecker", "Adjusted");
    expect(readdirSync(folder).sort()).toEqual(["IMG_0001-2.jpg", "IMG_0001-3.jpg", "IMG_0001-4.jpg", "IMG_0001.jpg"]);

    const rows = await db.query(`SELECT count(*)::int AS n FROM captures WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES]);
    expect(rows.rows[0].n).toBe(4);
    const species = await db.query(`SELECT state, cover_photo_id FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES]);
    expect(species.rows[0].state).toBe("collected");
    expect(species.rows[0].cover_photo_id).not.toBeNull();
  }, 60_000);

  it("imports a checked photo from the server's kept copy, without sending the file again", async () => {
    const bytes = await jpeg(210);
    const check = await multipartBody({}, { name: "IMG_0200.jpg", bytes });
    const inspect = await app.inject({ method: "POST", url: "/api/uploads/inspect", headers: { "x-api-key": TOKEN, "content-type": check.contentType }, payload: check.payload });
    expect(inspect.statusCode, inspect.body).toBe(200);
    const stagedId = inspect.json().stagedId as string;
    expect(stagedId).toMatch(/^[0-9a-f]{64}$/);

    const form = new FormData();
    for (const [k, v] of Object.entries({ speciesId: SPECIES, stagedId, fileName: "IMG_0200.jpg", fileType: "image/jpeg" })) form.append(k, v);
    const res = new Response(form);
    const payload = Buffer.from(await res.arrayBuffer());
    const headers = { "x-api-key": TOKEN, "content-type": res.headers.get("content-type")! };
    const upload = await app.inject({ method: "POST", url: "/api/uploads", headers, payload });
    expect(upload.statusCode, upload.body).toBe(201);
    const folder = path.join(dataDir, "Birds", "Test Woodpecker", "Adjusted");
    expect(readdirSync(folder)).toContain("IMG_0200.jpg");
    // Used up: gone from staging, so a second import by the same id asks for the file.
    await new Promise((r) => setTimeout(r, 50));
    const again = await app.inject({ method: "POST", url: "/api/uploads", headers, payload });
    expect(again.statusCode).toBe(410);
  }, 60_000);
});
