// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Save a video frame as a photo: full video size, the video's date plus the frame time, its
// species and a note of the source video in the file.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000181";
const SPECIES = "dddddddd-0000-4000-8000-000000000182";
const TOKEN = "lifer_test_video_frame_181";
let cookieName = "";

describe.skipIf(!url)("save a video frame as a photo", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let clips: string;
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-frame-"));
    clips = mkdtempSync(path.join(tmpdir(), "lifer-frame-clips-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { uploadRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'frame@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 913801, 'Rana framensis', 'Rana framensis', 'amphibia') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(clips, { recursive: true, force: true });
  });

  it("saves the frame at the video's size, dated from the video, and files it under the species", async () => {
    const clip = path.join(clips, "toad.mp4");
    execFileSync(
      ffmpeg,
      ["-y", "-f", "lavfi", "-i", "testsrc=duration=3:size=640x360:rate=10", "-pix_fmt", "yuv420p", clip],
      { stdio: "ignore" },
    );
    const body = new FormData();
    body.append("speciesId", SPECIES);
    body.append("file", new Blob([new Uint8Array(readFileSync(clip))], { type: "video/mp4" }), "toad.mp4");
    const res = new Response(body);
    const uploaded = await app.inject({
      method: "POST",
      url: "/api/uploads/video",
      payload: Buffer.from(await res.arrayBuffer()),
      headers: { "content-type": res.headers.get("content-type")! },
      cookies: { [cookieName]: TOKEN },
    });
    expect(uploaded.statusCode).toBe(201);
    const { captureId, photoId } = uploaded.json();
    await db.query(`UPDATE captures_all SET taken_at = '2024-05-01T10:00:00Z' WHERE id = $1`, [captureId]);

    const saved = await app.inject({
      method: "POST",
      url: `/api/photos/${photoId}/frame`,
      payload: { atSeconds: 2 },
      cookies: { [cookieName]: TOKEN },
    });
    expect(saved.statusCode).toBe(201);
    const frame = (
      await db.query(
        `SELECT c.taken_at, c.species_id, o.ref FROM captures c JOIN originals o ON o.capture_id = c.id AND o.kind = 'jpeg'
          WHERE c.id = $1`,
        [saved.json().captureId],
      )
    ).rows[0];
    expect(frame.species_id).toBe(SPECIES);
    expect(new Date(frame.taken_at).toISOString()).toBe("2024-05-01T10:00:02.000Z");
    const meta = await sharp(frame.ref).metadata();
    expect([meta.width, meta.height]).toEqual([640, 360]);
  }, 60_000);

  it("refuses a time past the end and a photo that isn't a video", async () => {
    const { rows } = await db.query(
      `SELECT p.id, p.kind FROM photos p JOIN captures c ON c.id = p.capture_id WHERE c.user_id = $1`,
      [USER],
    );
    const video = rows.find((r) => r.kind === "video").id;
    const past = await app.inject({
      method: "POST",
      url: `/api/photos/${video}/frame`,
      payload: { atSeconds: 600 },
      cookies: { [cookieName]: TOKEN },
    });
    expect(past.statusCode).toBe(400);
    const image = rows.find((r) => r.kind === "image").id;
    const wrong = await app.inject({
      method: "POST",
      url: `/api/photos/${image}/frame`,
      payload: { atSeconds: 0 },
      cookies: { [cookieName]: TOKEN },
    });
    expect(wrong.statusCode).toBe(404);
  });
});
