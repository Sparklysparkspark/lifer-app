// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run uploadModes
// Where imports put files and which rows they write: a species' photo, RAWs and video share one
// species folder whatever the naming style, link mode references a file in place (only inside the
// allowed folders), skipDuplicates hands back the existing photo, and an unlinked RAW is claimed
// by one capture only.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const USER = "dddddddd-0000-4000-8000-000000000136";
const SPECIES = "dddddddd-0000-4000-8000-00000000013a";
const TOKEN = "lifer_test_upload_modes_136";
let cookieName = "";

// A JPEG with a camera and capture time, so RAW pairing and EXIF fingerprints have something to
// go on. exiftool reads by content, so the same JPEG body stands in for a camera RAW.
async function shot(shade: number, taken: string): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam", Model: "Modes" }, IFD2: { DateTimeOriginal: taken } })
    .toBuffer();
}

async function form(
  fields: Record<string, string>,
  files: { field: string; name: string; bytes: Buffer; type: string }[] = [],
) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  for (const f of files) body.append(f.field, new Blob([new Uint8Array(f.bytes)], { type: f.type }), f.name);
  const res = new Response(body);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
    cookies: { [cookieName]: TOKEN },
  };
}

describe.skipIf(!url)("upload modes and filing", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let outsideDir: string;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  const post = async (route: string, body: Awaited<ReturnType<typeof form>>) =>
    app.inject({ method: "POST", url: `/api${route}`, ...body });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-upload-modes-"));
    outsideDir = mkdtempSync(path.join(tmpdir(), "lifer-upload-modes-outside-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    delete process.env.LIFER_LIBRARY_ROOTS;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { uploadRoutes } = await import("./routes.js");
    await cleanup();
    // Common and Latin group names, so an Other Taxa folder is "Insects - Insecta" only when the
    // naming styles and iNaturalist's group both reach the folder builder.
    await db.query(
      `INSERT INTO users (id, email, password_hash, species_naming_styles)
       VALUES ($1, 'upload-modes@test', 'x', ARRAY['common', 'latin'])`,
      [USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, inat_iconic_taxon)
       VALUES ($1, 913601, 'Testus modorum', 'Mode Test Beetle', 'insecta', 'Insecta') ON CONFLICT (id) DO NOTHING`,
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
  });

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
    rmSync(outsideDir, { recursive: true, force: true });
  });

  it("files an Other Taxa species' photo, RAWs and video under one taxon and species folder", async () => {
    const photo = await post(
      "/uploads",
      await form({ speciesId: SPECIES }, [
        { field: "file", name: "IMG_0400.jpg", bytes: await shot(40, "2024:06:01 09:00:00"), type: "image/jpeg" },
      ]),
    );
    expect(photo.statusCode, photo.body).toBe(201);

    // Its RAW, matched by name and time to the photo above.
    const matched = await post(
      "/uploads/raw",
      await form({}, [
        {
          field: "files",
          name: "IMG_0400.dng",
          bytes: await shot(41, "2024:06:01 09:00:00"),
          type: "image/x-adobe-dng",
        },
      ]),
    );
    expect(matched.statusCode, matched.body).toBe(201);
    expect(matched.json().results[0].linked).toBe(true);

    // A RAW on its own in the main import: a new capture.
    const rawOnly = await post(
      "/uploads",
      await form({ speciesId: SPECIES }, [
        {
          field: "file",
          name: "IMG_0401.dng",
          bytes: await shot(42, "2024:06:02 09:00:00"),
          type: "image/x-adobe-dng",
        },
      ]),
    );
    expect(rawOnly.statusCode, rawOnly.body).toBe(201);

    // A RAW filed straight into the species from its page, with no photo to pair with.
    const filed = await post(
      "/uploads/raw",
      await form({ speciesId: SPECIES, allowUnmatchedFallback: "1" }, [
        {
          field: "files",
          name: "IMG_0402.dng",
          bytes: await shot(43, "2024:06:03 09:00:00"),
          type: "image/x-adobe-dng",
        },
      ]),
    );
    expect(filed.statusCode, filed.body).toBe(201);
    expect(filed.json().results[0].filed).toBe(true);

    const ffmpeg = createRequire(import.meta.url)("ffmpeg-static") as string;
    const clip = path.join(outsideDir, "clip.mp4");
    execFileSync(
      ffmpeg,
      [
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=3:size=64x48:rate=10",
        "-pix_fmt",
        "yuv420p",
        "-c:v",
        "libx264",
        clip,
      ],
      { stdio: "ignore" },
    );
    const video = await post(
      "/uploads/video",
      await form({ speciesId: SPECIES }, [
        { field: "file", name: "CLIP_0400.mp4", bytes: readFileSync(clip), type: "video/mp4" },
      ]),
    );
    expect(video.statusCode, video.body).toBe(201);

    const originals = await db.query<{ kind: string; ref: string; user_id: string | null }>(
      `SELECT kind, ref, user_id FROM originals WHERE user_id = $1 OR capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`,
      [USER],
    );
    expect(originals.rows.map((r) => r.kind).sort()).toEqual(["jpeg", "raw", "raw", "raw", "video"]);
    // Every original records its owner, linked to a capture or not.
    expect(originals.rows.every((r) => r.user_id === USER)).toBe(true);
    const speciesFolders = new Set(originals.rows.map((r) => path.dirname(path.dirname(r.ref))));
    expect([...speciesFolders]).toHaveLength(1);
    const speciesFolder = [...speciesFolders][0];
    expect(path.dirname(speciesFolder)).toBe(path.join(dataDir, "Insects - Insecta"));
    expect(
      Object.fromEntries(originals.rows.map((r) => [path.basename(r.ref), path.basename(path.dirname(r.ref))])),
    ).toEqual({
      "IMG_0400.jpg": "Adjusted",
      "IMG_0400.dng": "RAW",
      "IMG_0401.dng": "RAW",
      "IMG_0402.dng": "RAW",
      "CLIP_0400.mp4": "Video",
    });
  }, 60_000);

  it("links a file in place inside the library folder, and refuses one outside it", async () => {
    const inside = path.join(dataDir, "linked", "IMG_0500.jpg");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(path.dirname(inside), { recursive: true });
    writeFileSync(inside, await shot(50, "2024:06:04 09:00:00"));
    const linked = await post("/uploads", await form({ speciesId: SPECIES, mode: "link", path: inside }));
    expect(linked.statusCode, linked.body).toBe(201);
    const row = await db.query<{ ref: string; managed: boolean; user_id: string }>(
      `SELECT ref, managed, user_id FROM originals WHERE capture_id = $1`,
      [linked.json().captureId],
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].managed).toBe(false);
    expect(row.rows[0].user_id).toBe(USER);
    // Referenced where it is: never moved or copied into the species folder.
    const { realpathSync } = await import("node:fs");
    expect(row.rows[0].ref).toBe(realpathSync(inside));
    expect(existsSync(inside)).toBe(true);

    const outside = path.join(outsideDir, "IMG_0501.jpg");
    writeFileSync(outside, await shot(51, "2024:06:04 10:00:00"));
    const refused = await post("/uploads", await form({ speciesId: SPECIES, mode: "link", path: outside }));
    expect(refused.statusCode).toBe(403);

    expect(
      (await post("/uploads", await form({ speciesId: SPECIES, mode: "link", path: "relative.jpg" }))).statusCode,
    ).toBe(400);
    // Bucket-backed originals aren't supported.
    const s3 = await post("/uploads", await form({ speciesId: SPECIES, mode: "s3", bucketKey: "a/b.jpg" }));
    expect(s3.statusCode).toBe(400);
    expect(s3.json().error).toBe("mode must be store or link");
  }, 60_000);

  it("hands back the photo you already have with skipDuplicates=1", async () => {
    const bytes = await shot(60, "2024:06:05 09:00:00");
    const file = [{ field: "file", name: "IMG_0600.jpg", bytes, type: "image/jpeg" }];
    const first = await post("/uploads", await form({ speciesId: SPECIES, skipDuplicates: "1" }, file));
    expect(first.statusCode, first.body).toBe(201);
    const again = await post("/uploads", await form({ speciesId: SPECIES, skipDuplicates: "1" }, file));
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toEqual({ captureId: first.json().captureId, photoId: first.json().photoId, duplicate: true });
    // Without it, the same file is imported again as its own photo.
    const copy = await post("/uploads", await form({ speciesId: SPECIES }, file));
    expect(copy.statusCode, copy.body).toBe(201);
    expect(copy.json().captureId).not.toBe(first.json().captureId);
  }, 60_000);

  it("never takes a RAW another capture claimed while this import was saving", async () => {
    const bytes = await shot(70, "2024:06:06 09:00:00");
    const probe = path.join(outsideDir, "probe.jpg");
    writeFileSync(probe, bytes);
    const { computeExifFingerprint, readExifTags } = await import("./exif.js");
    const fingerprint = await computeExifFingerprint(probe, await readExifTags(probe));
    expect(fingerprint.strict).not.toBeNull();

    // An unlinked RAW with the photo's EXIF fingerprint (and a different name, so only the
    // fingerprint match inside the import's transaction finds it), and another capture to claim it.
    const raw = await db.query<{ id: string }>(
      `INSERT INTO originals (capture_id, user_id, species_id, kind, ref_type, ref, managed, content_hash, file_size, exif_fingerprint, exif_fingerprint_loose)
       VALUES (NULL, $1, $2, 'raw', 'path', $3, false, 'race-raw', 1, $4, $5) RETURNING id`,
      [USER, SPECIES, path.join(outsideDir, "DSC_9999.dng"), fingerprint.strict, fingerprint.loose],
    );
    const rival = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, 'race-rival') RETURNING id`,
      [USER, SPECIES],
    );

    // Hold the RAW's row so the import's claim waits on it, then claim it for the rival first.
    const holder = await db.connect();
    try {
      await holder.query("BEGIN");
      await holder.query(`SELECT 1 FROM originals WHERE id = $1 FOR UPDATE`, [raw.rows[0].id]);
      const importing = post(
        "/uploads",
        await form({ speciesId: SPECIES }, [{ field: "file", name: "IMG_0700.jpg", bytes, type: "image/jpeg" }]),
      );
      const deadline = Date.now() + 20_000;
      for (;;) {
        const waiting = await db.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE originals SET capture_id%'`,
        );
        if (waiting.rows.length > 0) break;
        if (Date.now() > deadline) throw new Error("The import never reached the RAW claim");
        await new Promise((r) => setTimeout(r, 25));
      }
      await holder.query(`UPDATE originals SET capture_id = $1 WHERE id = $2`, [rival.rows[0].id, raw.rows[0].id]);
      await holder.query("COMMIT");

      const res = await importing;
      expect(res.statusCode, res.body).toBe(201);
      const owner = await db.query<{ capture_id: string }>(`SELECT capture_id FROM originals WHERE id = $1`, [
        raw.rows[0].id,
      ]);
      expect(owner.rows[0].capture_id).toBe(rival.rows[0].id);
      const imported = await db.query(`SELECT kind FROM originals WHERE capture_id = $1`, [res.json().captureId]);
      expect(imported.rows.map((r) => r.kind)).toEqual(["jpeg"]);
    } finally {
      await holder.query("ROLLBACK").catch(() => {});
      holder.release();
    }
  }, 60_000);
});
