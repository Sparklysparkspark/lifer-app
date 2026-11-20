// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Album export copies an album's files into a chosen folder without touching the originals or
// anything already in that folder.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000701";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000070a";
const TOKEN = "lifer_test_album_export_owner_701";

describe.skipIf(!url)("album export", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let srcDir: string;
  let cookieName: string;
  let albumId: string;
  let bigAlbumId: string;
  let job: typeof import("./export.js").albumExportJob;
  let originalsDir: string;
  // An admin-allowed folder outside the library, where a server may export to.
  let exportRoot: string;

  const call = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const freshDest = () => mkdtempSync(path.join(exportRoot, "export-"));
  const options = (destination: string, extra: object = {}) => ({
    destination,
    include: { raw: false, sidecars: false },
    structure: "flat",
    ...extra,
  });
  async function exportTo(body: object, album = albumId) {
    const res = await call("POST", `/api/albums/${album}/export`, body);
    expect(res.statusCode, res.body).toBe(200);
    await job.settled();
    return job.status;
  }

  async function addCapture(album: string, name: string, files: Array<{ kind: string; file: string }>) {
    const captureId = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [OWNER, SPECIES, `album-export-${album}-${name}`],
      )
    ).rows[0].id;
    const photoId = (
      await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [captureId],
      )
    ).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photoId, captureId]);
    for (const f of files) {
      await db.query(
        `INSERT INTO originals (capture_id, user_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, false, $5, 1)`,
        [captureId, OWNER, f.kind, f.file, `hash-${f.file}`],
      );
    }
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2)`, [album, captureId]);
  }

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-album-export-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    exportRoot = mkdtempSync(path.join(tmpdir(), "lifer-album-export-root-"));
    process.env.LIFER_LIBRARY_ROOTS = exportRoot;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    let ORIGINALS_DIR: string;
    ({ SESSION_COOKIE_NAME: cookieName, ORIGINALS_DIR } = await import("@lifer/core/config.js"));
    originalsDir = ORIGINALS_DIR;
    const { albumExportRoutes, albumExportJob } = await import("./export.js");
    job = albumExportJob;

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'album-export@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 920701, 'Testus exportus', 'Export Bird', 'aves')`,
      [SPECIES],
    );

    srcDir = path.join(dataDir, "source");
    mkdirSync(srcDir);
    writeFileSync(path.join(srcDir, "IMG_1.jpg"), "edited one");
    writeFileSync(path.join(srcDir, "IMG_1.CR3"), "raw one raw one");
    writeFileSync(path.join(srcDir, "IMG_1.xmp"), "<xmp/>");
    writeFileSync(path.join(srcDir, "IMG_2.jpg"), "edited two!");
    albumId = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Export') RETURNING id`, [OWNER])
    ).rows[0].id;
    await addCapture(albumId, "1", [
      { kind: "jpeg", file: path.join(srcDir, "IMG_1.jpg") },
      { kind: "raw", file: path.join(srcDir, "IMG_1.CR3") },
    ]);
    await addCapture(albumId, "2", [{ kind: "jpeg", file: path.join(srcDir, "IMG_2.jpg") }]);

    bigAlbumId = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Big') RETURNING id`, [OWNER])
    ).rows[0].id;
    for (let i = 0; i < 40; i++) {
      const file = path.join(srcDir, `BIG_${i}.jpg`);
      writeFileSync(file, `big ${i}`);
      await addCapture(bigAlbumId, `big-${i}`, [{ kind: "jpeg", file }]);
    }

    app = Fastify();
    await app.register(cookie);
    await app.register(albumExportRoutes, { prefix: "/api" });
    await app.ready();
  });

  beforeEach(async () => {
    await job?.settled();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
    if (exportRoot) rmSync(exportRoot, { recursive: true, force: true });
  });

  it("copies each photo's main file into one folder and leaves the originals alone", async () => {
    const dest = freshDest();
    const status = await exportTo(options(dest));
    expect(status.error).toBeNull();
    expect(readdirSync(dest).sort()).toEqual(["IMG_1.jpg", "IMG_2.jpg"]);
    expect(readFileSync(path.join(dest, "IMG_1.jpg"), "utf8")).toBe("edited one");
    expect(status).toMatchObject({ copied: 2, skipped: 0, missing: 0, processed: 2, total: 2, albumId });
    expect(status.downloadedBytes).toBe(status.totalBytes);
    expect(readdirSync(srcDir)).toContain("IMG_1.jpg");
  });

  it("skips files already exported to the same folder, so a rerun continues", async () => {
    const dest = freshDest();
    await exportTo(options(dest));
    const status = await exportTo(options(dest));
    expect(status).toMatchObject({ copied: 0, skipped: 2 });
    expect(readdirSync(dest).sort()).toEqual(["IMG_1.jpg", "IMG_2.jpg"]);
  });

  it("gives a different file of the same name a numeric suffix instead of overwriting it", async () => {
    const dest = freshDest();
    writeFileSync(path.join(dest, "IMG_1.jpg"), "someone else's photo");
    const status = await exportTo(options(dest));
    expect(status).toMatchObject({ copied: 2, skipped: 0 });
    expect(readFileSync(path.join(dest, "IMG_1.jpg"), "utf8")).toBe("someone else's photo");
    expect(readFileSync(path.join(dest, "IMG_1 (2).jpg"), "utf8")).toBe("edited one");
    // And a rerun finds its own copy under the suffix.
    expect(await exportTo(options(dest))).toMatchObject({ copied: 0, skipped: 2 });
  });

  it("adds RAW files and .xmp sidecars when asked, in a folder per species", async () => {
    const dest = freshDest();
    const status = await exportTo(options(dest, { include: { raw: true, sidecars: true }, structure: "bySpecies" }));
    expect(status.error).toBeNull();
    expect(readdirSync(dest)).toEqual(["Export Bird"]);
    expect(readdirSync(path.join(dest, "Export Bird")).sort()).toEqual([
      "IMG_1.CR3",
      "IMG_1.jpg",
      "IMG_1.xmp",
      "IMG_2.jpg",
    ]);
    expect(status).toMatchObject({ copied: 4, total: 4 });
  });

  it("copies a photo's sidecar without its RAW when only sidecars are asked for", async () => {
    const dest = freshDest();
    await exportTo(options(dest, { include: { raw: false, sidecars: true } }));
    expect(readdirSync(dest).sort()).toEqual(["IMG_1.jpg", "IMG_1.xmp", "IMG_2.jpg"]);
  });

  it("refuses a folder a server isn't allowed to write to, or one inside the library", async () => {
    const outside = mkdtempSync(path.join(tmpdir(), "lifer-album-export-outside-"));
    try {
      const res = await call("POST", `/api/albums/${albumId}/export`, options(outside));
      expect(res.statusCode).toBe(403);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    mkdirSync(originalsDir, { recursive: true });
    const inLibrary = await call("POST", `/api/albums/${albumId}/export`, options(originalsDir));
    expect(inLibrary.statusCode).toBe(400);
    const missing = await call("POST", `/api/albums/${albumId}/export`, options(path.join(exportRoot, "nope")));
    // A server can't tell a missing folder from a forbidden one without revealing which.
    expect(missing.statusCode).toBe(403);
    expect(existsSync(path.join(exportRoot, "nope"))).toBe(false);
  });

  it("stops between files when cancelled", async () => {
    const dest = freshDest();
    const res = await call("POST", `/api/albums/${bigAlbumId}/export`, options(dest));
    expect(res.statusCode).toBe(200);
    expect(job.cancel()).toBe(true);
    await job.settled();
    expect(job.status.cancelled).toBe(true);
    expect(job.status.copied).toBeLessThan(40);
    expect(readdirSync(dest).length).toBe(job.status.copied);
    expect((await call("POST", "/api/albums/export/cancel")).statusCode).toBe(409);
  });

  it("answers 404 for an album that isn't the user's", async () => {
    const res = await call("POST", `/api/albums/eeeeeeee-0000-4000-8000-0000000007ff/export`, options(freshDest()));
    expect(res.statusCode).toBe(404);
    expect((await call("GET", "/api/albums/export/status")).statusCode).toBe(200);
  });
});
