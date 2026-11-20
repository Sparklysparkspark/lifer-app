// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Sound recordings: import of each accepted format with duration and a waveform image, filing in
// the species' Audio folder, a species with only recordings counting as heard (never collected),
// playback, and the species page counting recordings apart from photos.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
const USER = "dddddddd-0000-4000-8000-000000000171";
const SPECIES = "dddddddd-0000-4000-8000-000000000172";
const PHOTO_SPECIES = "dddddddd-0000-4000-8000-000000000173";
const TOKEN = "lifer_test_audio_uploads_171";
let cookieName = "";

async function form(fields: Record<string, string>, file?: { name: string; bytes: Buffer; type: string }) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  if (file) body.append("file", new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
  const res = new Response(body);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
    cookies: { [cookieName]: TOKEN },
  };
}

describe.skipIf(!url)("sound recordings", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let clips: string;
  const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;

  const clip = (name: string, extra: string[] = []) => {
    const out = path.join(clips, name);
    execFileSync(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", ...extra, out], {
      stdio: "ignore",
    });
    return out;
  };
  const upload = async (species: string, name: string, file: string, type: string) =>
    app.inject({
      method: "POST",
      url: "/api/uploads/audio",
      ...(await form({ speciesId: species }, { name, bytes: readFileSync(file), type })),
    });
  const get = (route: string) => app.inject({ method: "GET", url: `/api${route}`, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-audio-"));
    clips = mkdtempSync(path.join(tmpdir(), "lifer-audio-clips-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { uploadRoutes } = await import("./routes.js");
    const { photoRoutes } = await import("../photos/routes.js");
    const { speciesDetailRoutes } = await import("../species/detail.js");
    const { galleryRoutes } = await import("../gallery/routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'audio@test', 'x')`, [USER]);
    for (const [id, key, name] of [
      [SPECIES, 913701, "Strix audioensis"],
      [PHOTO_SPECIES, 913702, "Corvus audioensis"],
    ])
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $3, 'aves') ON CONFLICT (id) DO NOTHING`,
        [id, key, name],
      );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.register(photoRoutes, { prefix: "/api" });
    await app.register(speciesDetailRoutes, { prefix: "/api" });
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, PHOTO_SPECIES]]);
    await db.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(clips, { recursive: true, force: true });
  });

  it("imports WAV, FLAC, MP3 and M4A with a duration and a waveform, filed under Audio", async () => {
    const formats = [
      ["owl.wav", "audio/wav", []],
      ["owl.flac", "audio/flac", []],
      ["owl.mp3", "audio/mpeg", ["-c:a", "libmp3lame"]],
      ["owl.m4a", "audio/mp4", ["-c:a", "aac"]],
    ] as const;
    for (const [name, type, extra] of formats) {
      const res = await upload(SPECIES, name, clip(name, [...extra]), type);
      expect(res.statusCode, `${name}: ${res.body}`).toBe(201);
    }
    const rows = await db.query<{ kind: string; duration_seconds: string; display_path: string; ref: string }>(
      `SELECT p.kind, p.duration_seconds, p.display_path, o.ref
       FROM captures_all c JOIN photos p ON p.capture_id = c.id JOIN originals o ON o.capture_id = c.id
       WHERE c.user_id = $1 ORDER BY o.ref`,
      [USER],
    );
    expect(rows.rows).toHaveLength(4);
    for (const r of rows.rows) {
      expect(r.kind).toBe("audio");
      expect(Number(r.duration_seconds)).toBeGreaterThan(1.5);
      expect(existsSync(r.display_path)).toBe(true);
      expect((await sharp(r.display_path).metadata()).format).toBe("webp");
      expect(path.basename(path.dirname(r.ref))).toBe("Audio");
    }
  }, 60_000);

  it("marks a species with only recordings as heard, and never downgrades a photographed one", async () => {
    const state = async (id: string) =>
      (await db.query(`SELECT state FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, id])).rows[0]
        ?.state;
    expect(await state(SPECIES)).toBe("seen");
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      PHOTO_SPECIES,
    ]);
    expect((await upload(PHOTO_SPECIES, "crow.wav", clip("crow.wav"), "audio/wav")).statusCode).toBe(201);
    expect(await state(PHOTO_SPECIES)).toBe("collected");
  });

  it("counts recordings apart from photos on the species page and plays the original", async () => {
    const stats = await get(`/species/${SPECIES}/encounters`);
    expect(stats.statusCode, stats.body).toBe(200);
    expect(stats.json()).toMatchObject({ audioCount: 4, totalPhotos: 0, videoCount: 0 });
    const { rows } = await db.query<{ id: string }>(
      `SELECT p.id FROM photos p JOIN captures_all c ON c.id = p.capture_id JOIN originals o ON o.capture_id = c.id
       WHERE c.user_id = $1 AND o.ref LIKE '%.wav' AND c.species_id = $2`,
      [USER, SPECIES],
    );
    const played = await get(`/photos/${rows[0].id}/audio`);
    expect(played.statusCode).toBe(200);
    expect(played.headers["content-type"]).toBe("audio/wav");
  });

  it("derives heard from the recordings you can see: trashing the last one clears it, restoring brings it back", async () => {
    const { syncCollectedState } = await import("../lib/userSpecies.js");
    const state = async () =>
      (await db.query(`SELECT state FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES])).rows[0]
        ?.state;
    const ids = (
      await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE user_id = $1 AND species_id = $2`, [
        USER,
        SPECIES,
      ])
    ).rows.map((r) => r.id);
    const setTrashed = (list: string[], on: boolean) =>
      db.query(`UPDATE captures_all SET deleted_at = ${on ? "now()" : "NULL"} WHERE id = ANY($1::uuid[])`, [list]);
    await setTrashed(ids.slice(1), true);
    await syncCollectedState(db, USER, ids.slice(1));
    expect(await state()).toBe("seen");
    await setTrashed(ids.slice(0, 1), true);
    await syncCollectedState(db, USER, ids.slice(0, 1));
    expect(await state()).toBeNull();
    await setTrashed(ids, false);
    await syncCollectedState(db, USER, ids);
    expect(await state()).toBe("seen");
  });

  it("lists recordings as their own media type in the gallery", async () => {
    expect((await get("/gallery/has-video")).json()).toEqual({ hasVideo: false, hasAudio: true });
    const kinds = async (q: string) => [
      ...new Set((await get(`/gallery?${q}`)).json().items.map((i: { kind: string }) => i.kind)),
    ];
    expect(await kinds("onlyAudio=1")).toEqual(["audio"]);
    expect(await kinds("excludeVideo=1")).toEqual([]);
  });

  it("refuses other files and sends a recording nowhere but the audio route", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .png()
      .toBuffer();
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads/audio",
      ...(await form({ speciesId: SPECIES }, { name: "x.png", bytes: png, type: "image/png" })),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/WAV, FLAC, MP3 or M4A/);
  });
});
