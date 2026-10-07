// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run tusLimits
// With MAX_UPLOAD_BYTES set, a resumable upload over it is refused at creation, and uploads
// nobody used are cleared by the maintenance sweep.
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tusUpload } from "@lifer/core/uploads/testImages.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000122";
const KEY = "lifer_test_tus_limits_key_122";
const API = { "x-api-key": KEY };

describe.skipIf(!url)("resumable upload limits", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-tus-limits-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    process.env.MAX_UPLOAD_BYTES = "1000";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { uploadRoutes } = await import("./routes.js");
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'tus-limits@test', 'x')`, [USER]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 't', $2, $3)`, [USER, hashApiKey(KEY), ["photos.write"]]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart);
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    delete process.env.MAX_UPLOAD_BYTES;
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses an Upload-Length over MAX_UPLOAD_BYTES with 413", async () => {
    const res = await app.inject({ method: "POST", url: "/api/uploads/tus", headers: { ...API, "tus-resumable": "1.0.0", "upload-length": "1001" } });
    expect(res.statusCode).toBe(413);
    const options = await app.inject({ method: "OPTIONS", url: "/api/uploads/tus", headers: API });
    expect(options.headers["tus-max-size"]).toBe("1000");
    expect(String(options.headers["tus-extension"])).toContain("creation-with-upload");
  });

  it("answers an unknown upload id the tus way, and a signed-out caller with 401", async () => {
    const tus = { ...API, "tus-resumable": "1.0.0" };
    for (const method of ["HEAD", "DELETE", "PATCH"] as const) {
      const res = await app.inject({ method, url: "/api/uploads/tus/not-an-upload", headers: { ...tus, "upload-offset": "0" } });
      expect([method, res.statusCode, res.headers["tus-resumable"]]).toEqual([method, 404, "1.0.0"]);
    }
    const signedOut = await app.inject({ method: "HEAD", url: "/api/uploads/tus/not-an-upload", headers: { "tus-resumable": "1.0.0" } });
    expect(signedOut.statusCode).toBe(401);
  });

  it("sweeps uploads with no activity for two hours, finished or not", async () => {
    const done = await tusUpload(app, Buffer.alloc(500, 1), { headers: API, filename: "a.jpg", filetype: "image/jpeg" });
    const partial = await tusUpload(app, Buffer.alloc(900, 2), { headers: API, filename: "b.jpg", filetype: "image/jpeg", stopAt: 100, chunkSize: 100 });
    const fresh = await tusUpload(app, Buffer.alloc(900, 3), { headers: API, filename: "c.jpg", filetype: "image/jpeg", stopAt: 100, chunkSize: 100 });
    const files = path.join(dataDir, "app-data", "uploads", "tus", "files");
    const records = path.join(dataDir, "app-data", "uploads", "tus", "finished");
    const old = new Date(Date.now() - 3 * 60 * 60_000);
    for (const id of [done.id, partial.id]) {
      for (const p of [path.join(files, id), path.join(files, `${id}.json`), path.join(records, `${id}.json`)]) if (existsSync(p)) utimesSync(p, old, old);
    }
    const { sweepAbandonedUploads } = await import("../lib/maintenance.js");
    expect(await sweepAbandonedUploads()).toEqual({ resumable: 2 });
    expect(readdirSync(files).sort()).toEqual([fresh.id, `${fresh.id}.json`].sort());
    expect(readdirSync(records)).toEqual([]);
    // An expired upload answers 410 or 404, so the client starts over.
    const head = await app.inject({ method: "HEAD", url: done.url, headers: { ...API, "tus-resumable": "1.0.0" } });
    expect([404, 410]).toContain(head.statusCode);
  });
});
