// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run suggestVideo
// A video checked for species by uploadId is read in place, so the import then uses the same id.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { tusUpload } from "../uploads/testImages.js";

// The model isn't what's tested here: only that frames were read from the uploaded file.
const frameCounts: number[] = [];
vi.mock("../species/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../species/embeddings.js")>()),
  suggestSpeciesForFrames: vi.fn(async (_pool: unknown, _user: string, frames: Buffer[]) => {
    frameCounts.push(frames.length);
    return [];
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000150";
const OTHER_USER = "dddddddd-0000-4000-8000-000000000151";
const SPECIES = "dddddddd-0000-4000-8000-00000000015c";
const SESSION = "lifer_test_suggest_video_session_150";
const OTHER_SESSION = "lifer_test_suggest_video_session_151";
const CLIENT = { "x-lifer-client": "1" };

async function form(fields: Record<string, string>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  const res = new Response(f);
  return { payload: Buffer.from(await res.arrayBuffer()), headers: { ...CLIENT, "content-type": res.headers.get("content-type")! } };
}

describe.skipIf(!url)("video species suggestions by uploadId", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName = "";

  async function cleanup() {
    for (const u of [USER, OTHER_USER]) {
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM sessions WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-suggest-video-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("../config.js"));
    const { uploadRoutes } = await import("../uploads/routes.js");
    const { speciesSuggestRoutes } = await import("./suggest.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'suggest-video@test', 'x'), ($2, 'suggest-video-other@test', 'x')`, [USER, OTHER_USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910806, 'Testus cinematicus', 'Video Test Tern', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day'), ($3, $4, now() + interval '1 day')`, [
      hashToken(SESSION),
      USER,
      hashToken(OTHER_SESSION),
      OTHER_USER,
    ]);
    app = Fastify({ bodyLimit: 1024 * 1024 });
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: Infinity } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.register(speciesSuggestRoutes, { prefix: "/api" });
    await app.ready();
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

  it("samples frames from a resumable upload without consuming it, then imports the same uploadId", async () => {
    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    const video = path.join(dataDir, "clip.mp4");
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=64x48:rate=10", "-pix_fmt", "yuv420p", "-c:v", "libx264", video], { stdio: "ignore" });
    const bytes = readFileSync(video);
    const cookies = { [cookieName]: SESSION };
    const { id } = await tusUpload(app, bytes, { headers: CLIENT, cookies, filename: "CLIP_0002.mp4", filetype: "video/mp4", chunkSize: 4096 });

    // Someone else's id reads as gone, and nothing at all is a 400.
    const theirs = await app.inject({ method: "POST", url: "/api/captures/suggest-species-from-video", ...(await form({ uploadId: id })), cookies: { [cookieName]: OTHER_SESSION } });
    expect(theirs.statusCode).toBe(410);
    const none = await app.inject({ method: "POST", url: "/api/captures/suggest-species-from-video", ...(await form({})), cookies });
    expect(none.statusCode).toBe(400);

    const suggest = await app.inject({ method: "POST", url: "/api/captures/suggest-species-from-video", ...(await form({ uploadId: id })), cookies });
    expect(suggest.statusCode, suggest.body).toBe(200);
    expect(suggest.json()).toMatchObject({ suggestions: [], stagedId: null, uploadId: id });
    expect(suggest.json().error).toBeUndefined();
    expect(frameCounts.at(-1)).toBeGreaterThan(0);

    const res = await app.inject({ method: "POST", url: "/api/uploads/video", ...(await form({ speciesId: SPECIES, uploadId: id })), cookies });
    expect(res.statusCode, res.body).toBe(201);
    const row = await db.query<{ ref: string; content_hash: string }>(`SELECT ref, content_hash FROM originals WHERE capture_id = $1 AND kind = 'video'`, [res.json().captureId]);
    expect(path.basename(row.rows[0].ref)).toBe("CLIP_0002.mp4");
    expect(row.rows[0].content_hash).toBe(createHash("sha256").update(bytes).digest("hex"));

    // Imported, so the upload is gone now.
    const after = await app.inject({ method: "POST", url: "/api/captures/suggest-species-from-video", ...(await form({ uploadId: id })), cookies });
    expect(after.statusCode).toBe(410);
  }, 60_000);
});
