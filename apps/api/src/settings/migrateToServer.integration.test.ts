// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run migrateToServer
// The migration sends each capture to the remote server as resumable uploads over real HTTP,
// shrinking its chunks when a proxy refuses big bodies, then imports them by uploadId.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000160";
const SPECIES = "dddddddd-0000-4000-8000-00000000016c";
const SESSION = "lifer_test_migrate_to_server_session_160";
// Stands in for a reverse proxy with a small body limit.
const PROXY_LIMIT = 300 * 1024;

describe.skipIf(!url)("migrating to a server over resumable uploads", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let baseUrl = "";
  let cookieName = "";
  const patches: Array<{ bytes: number; status: number }> = [];
  let heads = 0;
  // "413": answers too-big PATCHes with 413. "drop": closes the connection on them instead.
  let proxyMode: "413" | "drop" = "413";

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-migrate-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    delete process.env.MAX_UPLOAD_BYTES;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("../config.js"));
    const { uploadRoutes } = await import("../uploads/routes.js");
    const { isBlockedCrossSiteWrite } = await import("../lib/requestGuard.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'migrate@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910807, 'Testus migrans', 'Migrating Test Tern', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [hashToken(SESSION), USER]);

    app = Fastify({ bodyLimit: 1024 * 1024 });
    app.addHook("onRequest", async (request, reply) => {
      if (isBlockedCrossSiteWrite(request.method, request.headers, [request.headers.host, request.host])) {
        return reply.code(403).send({ error: "Cross-site request blocked" });
      }
      if (request.method === "HEAD") heads++;
      if (request.method === "PATCH") {
        const bytes = Number(request.headers["content-length"]);
        const status = bytes > PROXY_LIMIT ? 413 : 204;
        patches.push({ bytes, status });
        if (status === 413 && proxyMode === "drop") {
          request.raw.socket.destroy();
          return reply.hijack();
        }
        if (status === 413) return reply.code(413).header("connection", "close").send({ error: "Request Entity Too Large" });
      }
    });
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: Infinity } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.listen({ host: "127.0.0.1", port: 0 });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("../db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("uploads a photo and its RAW in chunks, halving them on 413, and imports both", async () => {
    // Noise barely compresses, so this JPEG is well over the proxy limit.
    const photo = await sharp({ create: { width: 1400, height: 1000, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    expect(photo.length).toBeGreaterThan(4 * PROXY_LIMIT);
    const raw = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const photoPath = path.join(dataDir, "IMG_5000.jpg");
    const rawPath = path.join(dataDir, "IMG_5000.dng");
    writeFileSync(photoPath, photo);
    writeFileSync(rawPath, raw);

    const { sendCaptureToServer } = await import("./migrateToServer.js");
    const { TUS_MIN_CHUNK_SIZE } = await import("../lib/tusClient.js");
    const chunkState = { size: 8 * 1024 * 1024 };
    const auth = { Cookie: `${cookieName}=${SESSION}`, "x-lifer-client": "1" };
    const ok = await sendCaptureToServer(baseUrl, auth, { speciesId: SPECIES, photoPath, rawPath }, { chunkState, tus: { retryDelaysMs: [0, 0, 0] } });
    expect(ok).toBe(true);

    // Halved from 8 MB on each refusal until 256 KB pieces get through.
    const refused = patches.filter((p) => p.status === 413).map((p) => p.bytes);
    expect(refused).toEqual([8, 4, 2, 1, 0.5].map((mb) => Math.min(mb * 1024 * 1024, photo.length)));
    expect(patches.filter((p) => p.status === 204).every((p) => p.bytes <= TUS_MIN_CHUNK_SIZE)).toBe(true);
    expect(chunkState.size).toBe(TUS_MIN_CHUNK_SIZE);
    // Each refusal was followed by asking the server where to resume from.
    expect(heads).toBe(refused.length);

    const rows = await db.query<{ kind: string; ref: string; content_hash: string }>(
      `SELECT o.kind, o.ref, o.content_hash FROM originals o JOIN captures c ON c.id = o.capture_id WHERE c.user_id = $1 ORDER BY o.kind`,
      [USER],
    );
    expect(rows.rows.map((r) => r.kind)).toEqual(["jpeg", "raw"]);
    const jpegRow = rows.rows.find((r) => r.kind === "jpeg")!;
    expect(jpegRow.content_hash).toBe(createHash("sha256").update(photo).digest("hex"));
    expect(path.basename(jpegRow.ref)).toBe("IMG_5000.jpg");
    expect(readFileSync(rows.rows.find((r) => r.kind === "raw")!.ref).equals(raw)).toBe(true);
  }, 60_000);

  it("halves the chunk size when the connection drops mid-PATCH too", async () => {
    proxyMode = "drop";
    patches.length = 0;
    const photo = await sharp({ create: { width: 900, height: 700, channels: 3, background: "#808080", noise: { type: "gaussian", mean: 128, sigma: 60 } } })
      .jpeg({ quality: 95 })
      .toBuffer();
    expect(photo.length).toBeGreaterThan(PROXY_LIMIT);
    const photoPath = path.join(dataDir, "IMG_5001.jpg");
    writeFileSync(photoPath, photo);
    const { sendCaptureToServer } = await import("./migrateToServer.js");
    const chunkState = { size: 1024 * 1024 };
    const auth = { Cookie: `${cookieName}=${SESSION}`, "x-lifer-client": "1" };
    expect(await sendCaptureToServer(baseUrl, auth, { speciesId: SPECIES, photoPath, rawPath: null }, { chunkState, tus: { retryDelaysMs: [0, 0, 0] } })).toBe(true);
    expect(chunkState.size).toBe(256 * 1024);
    const row = await db.query(`SELECT 1 FROM originals WHERE content_hash = $1`, [createHash("sha256").update(photo).digest("hex")]);
    expect(row.rowCount).toBe(1);
  }, 60_000);
});
