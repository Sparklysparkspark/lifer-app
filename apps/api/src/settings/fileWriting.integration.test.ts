// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Settings > Metadata > Where keywords go: sidecar names, sidecars instead of in-file writes,
// linked folder sidecars with their dry run, "Update existing photos", and Apple Photos staying
// hidden off a Mac desktop app. Files are generated in temp folders and read back with exiftool.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { ExifTool } from "exiftool-vendored";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000291";
const SPECIES = "dddddddd-0000-4000-8000-00000000029a";
const TOKEN = "lifer_test_file_writing_291";
let cookieName = "";

describe.skipIf(!url)("file writing settings", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let root: string;
  let lib: string;
  let linked: string;
  const et = new ExifTool({ maxProcs: 1 });
  const call = (method: "GET" | "PUT" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: `/api${route}`, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const tags = async (file: string) => (await et.read(file)) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]);

  async function jpeg(file: string) {
    await sharp({ create: { width: 16, height: 16, channels: 3, background: "#345" } })
      .jpeg()
      .toFile(file);
  }

  async function capture(files: Array<{ kind: "raw" | "jpeg"; ref: string; managed: boolean }>): Promise<string> {
    const id = (
      await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, `file-writing-${files[0].ref}`],
      )
    ).rows[0].id;
    for (const f of files)
      await db.query(
        `INSERT INTO originals (capture_id, user_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, $5, $6, 1)`,
        [id, USER, f.kind, f.ref, f.managed, `hash-${f.ref}`],
      );
    return id;
  }

  async function cleanup() {
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM install_settings WHERE key LIKE $1`, [`%:${USER}`]);
  }

  let managedRaw: string;
  let managedJpeg: string;
  let linkedJpeg: string;
  let linkedRaw: string;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), "lifer-file-writing-"));
    lib = path.join(root, "library");
    linked = path.join(root, "linked");
    mkdirSync(lib);
    mkdirSync(linked);
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = path.join(root, "data");
    process.env.APP_DATA_DIR = path.join(root, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'file-writing@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 929101, 'Haliaeetus testus', 'Test Eagle', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);

    managedRaw = path.join(lib, "IMG_0001.CR3");
    managedJpeg = path.join(lib, "IMG_0001.JPG");
    writeFileSync(managedRaw, "raw bytes");
    await jpeg(managedJpeg);
    await capture([
      { kind: "raw", ref: managedRaw, managed: true },
      { kind: "jpeg", ref: managedJpeg, managed: true },
    ]);
    linkedJpeg = path.join(linked, "DSC_0001.JPG");
    await jpeg(linkedJpeg);
    await capture([{ kind: "jpeg", ref: linkedJpeg, managed: false }]);
    // A RAW whose IMG.xmp sidecar Lightroom made: never Lifer's to change.
    linkedRaw = path.join(linked, "DSC_0002.ARW");
    writeFileSync(linkedRaw, "raw bytes");
    await et.write(path.join(linked, "DSC_0002.xmp"), {
      "XMP-dc:Subject": ["Mine"],
      "XMP-xmp:CreatorTool": "Adobe Photoshop Lightroom Classic",
    } as never);
    await capture([{ kind: "raw", ref: linkedRaw, managed: false }]);
    // On a drive that isn't plugged in.
    await capture([{ kind: "jpeg", ref: path.join(root, "unplugged", "DSC_0003.JPG"), managed: false }]);

    const { fileWriteRoutes } = await import("./fileWriteRoutes.js");
    const { applePhotosRoutes } = await import("../integrations/applePhotos/routes.js");
    app = Fastify();
    await app.register(cookie);
    for (const routes of [fileWriteRoutes, applePhotosRoutes]) await app.register(routes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await et.end();
    if (db) {
      await cleanup();
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(root, { recursive: true, force: true });
  });

  it("starts as Lifer always wrote, saves changes, and refuses an unknown sidecar name", async () => {
    expect((await call("GET", "/settings/file-writing")).json()).toEqual({
      sidecarNames: "stem",
      insideFiles: true,
      linkedFolders: false,
    });
    expect((await call("PUT", "/settings/file-writing", { sidecarNames: "digikam" })).statusCode).toBe(400);
    const saved = await call("PUT", "/settings/file-writing", { sidecarNames: "both" });
    expect(saved.json()).toEqual({ sidecarNames: "both", insideFiles: true, linkedFolders: false });
  });

  it("counts what linked folders would get without writing anything", async () => {
    const res = await call("GET", "/settings/file-writing/linked-preview");
    // DSC_0001.JPG gets DSC_0001.JPG.xmp; DSC_0002.ARW gets DSC_0002.ARW.xmp ("both") while
    // Lightroom's DSC_0002.xmp is left alone; DSC_0003 is on an unplugged drive.
    expect(res.json()).toEqual({ files: 3, create: 2, update: 0, skip: 1, unavailable: 1 });
    expect(existsSync(`${linkedJpeg}.xmp`)).toBe(false);
  });

  it("brings existing photos in line: both RAW names, and linked sidecars only once opted in", async () => {
    const lightroomBefore = readFileSync(path.join(linked, "DSC_0002.xmp"), "utf8");
    const linkedBefore = readFileSync(linkedJpeg);
    let res = await call("POST", "/settings/file-writing/apply");
    expect(res.statusCode, res.body).toBe(200);
    expect(list((await tags(path.join(lib, "IMG_0001.xmp"))).Subject)).toContain("Test Eagle");
    expect(list((await tags(`${managedRaw}.xmp`)).Subject)).toContain("Test Eagle");
    expect(list((await tags(managedJpeg)).Keywords)).toContain("Test Eagle");
    expect(existsSync(`${linkedJpeg}.xmp`)).toBe(false);

    await call("PUT", "/settings/file-writing", { linkedFolders: true });
    res = await call("POST", "/settings/file-writing/apply");
    expect(res.json()).toMatchObject({ failed: 0 });
    const ours = await tags(`${linkedJpeg}.xmp`);
    expect(ours.CreatorTool).toBe("Lifer");
    expect(list(ours.Subject)).toContain("Test Eagle");
    expect(readFileSync(linkedJpeg).equals(linkedBefore)).toBe(true);
    expect(readFileSync(path.join(linked, "DSC_0002.xmp"), "utf8")).toBe(lightroomBefore);
    expect(list((await tags(`${linkedRaw}.xmp`)).Subject)).toContain("Test Eagle");
    expect(existsSync(path.join(root, "unplugged"))).toBe(false);
    expect((await call("GET", "/settings/file-writing/linked-preview")).json()).toMatchObject({
      create: 0,
      update: 2,
      skip: 1,
    });
  });

  it("writes a sidecar instead of changing a JPEG when in-file writes are off", async () => {
    await call("PUT", "/settings/file-writing", { insideFiles: false, linkedFolders: false });
    await db.query(`UPDATE captures SET tags = ARRAY['perched'] WHERE user_id = $1`, [USER]);
    const before = readFileSync(managedJpeg);
    await call("POST", "/settings/file-writing/apply");
    expect(readFileSync(managedJpeg).equals(before)).toBe(true);
    expect(list((await tags(`${managedJpeg}.xmp`)).Subject)).toContain("perched");
  });

  it("keeps Send keywords to Apple Photos hidden outside the Mac desktop app", async () => {
    expect((await call("GET", "/apple-photos/status")).json()).toEqual({ available: false });
    const res = await call("POST", "/apple-photos/send", { mode: "check", captureIds: [] });
    expect(res.statusCode).toBe(404);
  });
});
