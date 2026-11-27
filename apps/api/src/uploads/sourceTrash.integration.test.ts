// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run sourceTrash
// "Move photos into my library" and "Clear out the ones already in Lifer" on the desktop: an
// original goes to the Trash (a folder standing in for it here) only once the library holds the
// same bytes, a RAW and its JPG together, sidecars with them; anything else stays put.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LOCAL_EMAIL = "local@lifer.app";
const LAUNCH_TOKEN = "source-trash-test-launch-token";
const SHELL_TOKEN = "source-trash-test-shell-token";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000271a";

const fake = vi.hoisted(() => ({
  trash: "",
  fail: false,
  /** Captures the user had at the moment each file went to the Trash. */
  capturesWhenTrashed: [] as number[],
  /** Each call's file names, in order. */
  calls: [] as string[][],
  /** Names the Trash refuses (a locked file). */
  refuse: new Set<string>(),
  countCaptures: async () => 0,
}));
vi.mock("../lib/originalsWrite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/originalsWrite.js")>()),
  moveToSystemTrash: async (files: string[]) => {
    if (fake.fail) throw new Error("Trash refused");
    if (files.length === 0) return;
    fake.capturesWhenTrashed.push(await fake.countCaptures());
    fake.calls.push(files.map((f) => path.basename(f)));
    for (const f of files)
      if (!fake.refuse.has(path.basename(f))) renameSync(f, path.join(fake.trash, path.basename(f)));
    if (files.some((f) => fake.refuse.has(path.basename(f)))) throw new Error("Trash refused");
  },
}));

describe.skipIf(!url)("moving imported originals to the Trash", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let src: string;
  let lib: string;
  let userId: string;
  let localUserExisted = false;
  let n = 0;

  const call = (u: string, payload: object) =>
    app.inject({ method: "POST", url: `/api${u}`, headers: { "x-lifer-launch-token": LAUNCH_TOKEN }, payload });

  /** A small, distinct JPEG in the source folder. */
  async function jpeg(name: string): Promise<string> {
    const file = path.join(src, name);
    mkdirSync(path.dirname(file), { recursive: true });
    n++;
    await sharp({ create: { width: 16, height: 12, channels: 3, background: { r: n * 7, g: 90, b: 40 } } })
      .jpeg()
      .toFile(file);
    return file;
  }

  async function importFile(file: string, fields: Record<string, string> = {}) {
    const form = new FormData();
    form.append("speciesId", SPECIES);
    form.append("mode", "store");
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    form.append("file", new Blob([new Uint8Array(readFileSync(file))], { type: "image/jpeg" }), path.basename(file));
    const res = new Response(form);
    return app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: Buffer.from(await res.arrayBuffer()),
      headers: { "content-type": res.headers.get("content-type")!, "x-lifer-launch-token": LAUNCH_TOKEN },
    });
  }

  const inTrash = (name: string) => existsSync(path.join(fake.trash, name));

  async function clearLibrary() {
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM capture_versions WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [userId]);
    await db.query(`DELETE FROM photos WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`, [userId]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [userId]);
  }

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-source-trash-")));
    src = path.join(dir, "Desktop");
    lib = path.join(dir, "lib");
    fake.trash = path.join(dir, "Trash");
    for (const d of [src, lib, fake.trash]) mkdirSync(d, { recursive: true });
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = lib;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH_TOKEN;
    process.env.LIFER_SHELL_TOKEN = SHELL_TOKEN;
    process.env.LIFER_ALLOW_UNTOKENED_DESKTOP = "0";
    db = new pg.Pool({ connectionString: url });
    fake.countCaptures = async () =>
      (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM captures WHERE user_id = $1`, [userId])).rows[0].n;
    localUserExisted = (await db.query(`SELECT 1 FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows.length > 0;
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 927101, 'Trashia movens', 'Moving Plover', 'aves')`,
      [SPECIES],
    );
    const { uploadRoutes } = await import("./routes.js");
    const { knownFilesRoutes } = await import("./knownFilesRoutes.js");
    app = Fastify();
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.register(knownFilesRoutes, { prefix: "/api" });
    await app.ready();
    await app.inject({ method: "GET", url: "/api/uploads/skipped", headers: { "x-lifer-launch-token": LAUNCH_TOKEN } });
    userId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows[0].id;
    // The user imported from this folder (Choose a folder), so its files may be moved.
    await db.query(`INSERT INTO import_source_folders (user_id, path, photo_count) VALUES ($1, $2, 0)`, [userId, src]);
  }, 60_000);

  beforeEach(async () => {
    fake.fail = false;
    fake.capturesWhenTrashed = [];
    fake.calls = [];
    fake.refuse.clear();
    await clearLibrary();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await clearLibrary();
      for (const t of ["import_skipped_files", "import_source_folders", "import_source_files"])
        await db.query(`DELETE FROM ${t} WHERE user_id = $1`, [userId]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      if (!localUserExisted) await db.query(`DELETE FROM users WHERE email = $1`, [LOCAL_EMAIL]);
      await db.end();
    }
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("moves the original to the Trash only after its capture is saved, with its sidecar", async () => {
    const file = await jpeg("a/IMG_1.jpg");
    writeFileSync(path.join(src, "a/IMG_1.jpg.xmp"), "<x/>");
    const res = await importFile(file, { moveSourcePath: file });
    expect(res.statusCode).toBe(201);
    expect(res.json().sourceMove).toEqual({ moved: true, reason: null, sidecars: 1 });
    expect(existsSync(file)).toBe(false);
    expect(inTrash("IMG_1.jpg") && inTrash("IMG_1.jpg.xmp")).toBe(true);
    // The photo first, its sidecar after, both once the capture is saved.
    expect(fake.calls).toEqual([["IMG_1.jpg"], ["IMG_1.jpg.xmp"]]);
    expect(fake.capturesWhenTrashed).toEqual([1, 1]);
  });

  it("leaves the original where it is when the Trash refuses, and the import still stands", async () => {
    const file = await jpeg("b/IMG_2.jpg");
    fake.fail = true;
    const res = await importFile(file, { moveSourcePath: file });
    expect(res.statusCode).toBe(201);
    expect(res.json().sourceMove).toEqual({ moved: false, reason: "trash_failed", sidecars: 0 });
    expect(existsSync(file)).toBe(true);
    expect(await fake.countCaptures()).toBe(1);
  });

  it("keeps a JPG whose RAW stays behind, and moves a RAW and JPG sent together", async () => {
    const jpg = await jpeg("c/IMG_3.jpg");
    writeFileSync(path.join(src, "c/IMG_3.CR3"), "raw bytes");
    const alone = await importFile(jpg, { moveSourcePath: jpg });
    expect(alone.json().sourceMove).toEqual({ moved: false, reason: "partner_stays", sidecars: 0 });
    expect(existsSync(jpg)).toBe(true);

    // Clearing the pair: both are in the library only once the RAW is too.
    const { insertOriginal } = await import("./captureRows.js");
    const { pool } = await import("@lifer/core/db.js");
    const { hashFile } = await import("@lifer/core/lib/verifiedCopy.js");
    const rawCopy = path.join(lib, "IMG_3.CR3");
    writeFileSync(rawCopy, "raw bytes");
    const captureId = alone.json().captureId;
    await insertOriginal(pool, {
      userId,
      captureId,
      kind: "raw",
      ref: rawCopy,
      managed: true,
      contentHash: await hashFile(rawCopy),
      fileSize: 9,
    });
    writeFileSync(path.join(src, "c/IMG_3.xmp"), "<x/>");
    const cleared = await call("/uploads/source-folders/clear", { paths: [jpg, path.join(src, "c/IMG_3.CR3")] });
    expect(cleared.json()).toMatchObject({ cleared: 2, sidecars: 1, kept: [] });
    expect(inTrash("IMG_3.jpg") && inTrash("IMG_3.CR3") && inTrash("IMG_3.xmp")).toBe(true);
  });

  it("never moves a file it didn't import: a refused import, or one outside the chosen folders", async () => {
    const file = await jpeg("d/IMG_4.jpg");
    const res = await importFile(file, { moveSourcePath: file, speciesId: "not-a-uuid" });
    expect(res.statusCode).toBe(400);
    expect(existsSync(file)).toBe(true);

    const outside = path.join(dir, "elsewhere.jpg");
    writeFileSync(outside, readFileSync(file));
    const moved = await importFile(outside, { moveSourcePath: outside });
    expect(moved.json().sourceMove).toEqual({ moved: false, reason: "not_in_source_folder", sidecars: 0 });
    expect(existsSync(outside)).toBe(true);
  });

  it("moves a file picked in the desktop's own dialog, and only when the shell vouches for it", async () => {
    // The maintainer's case: one JPG from a folder Lifer never scanned.
    const picked = path.join(dir, "Card", "6F9A9774.jpg");
    mkdirSync(path.dirname(picked), { recursive: true });
    writeFileSync(picked, readFileSync(await jpeg("k/seed.jpg")));
    writeFileSync(path.join(dir, "Card", "6F9A9774.jpg.xmp"), "<x/>");
    const report = (headers: Record<string, string>) =>
      app.inject({
        method: "POST",
        url: "/api/uploads/picked-files",
        headers: { "x-lifer-launch-token": LAUNCH_TOKEN, ...headers },
        payload: { paths: [picked] },
      });
    const read = () =>
      app.inject({
        method: "GET",
        url: `/api/uploads/source-folders/file?path=${encodeURIComponent(picked)}`,
        headers: { "x-lifer-launch-token": LAUNCH_TOKEN },
      });

    // A page holds the launch token but not the shell's secret: its claim isn't there.
    expect((await report({})).statusCode).toBe(404);
    expect((await report({ "x-lifer-shell-token": "guess" })).statusCode).toBe(404);
    expect((await read()).statusCode).toBe(403);
    const unvouched = await importFile(picked, { moveSourcePath: picked });
    expect(unvouched.json().sourceMove).toMatchObject({ moved: false, reason: "not_in_source_folder" });
    await clearLibrary();

    expect((await report({ "x-lifer-shell-token": SHELL_TOKEN })).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(200);
    const res = await importFile(picked, { moveSourcePath: picked });
    expect(res.json().sourceMove).toEqual({ moved: true, reason: null, sidecars: 1 });
    expect(inTrash("6F9A9774.jpg") && inTrash("6F9A9774.jpg.xmp")).toBe(true);
  });

  it("keeps a picked JPG whose RAW wasn't picked, and never a picked file inside the library", async () => {
    const shell = (paths: string[]) =>
      app.inject({
        method: "POST",
        url: "/api/uploads/picked-files",
        headers: { "x-lifer-launch-token": LAUNCH_TOKEN, "x-lifer-shell-token": SHELL_TOKEN },
        payload: { paths },
      });
    const jpg = path.join(dir, "Card2", "6F9A9775.jpg");
    mkdirSync(path.dirname(jpg), { recursive: true });
    writeFileSync(jpg, readFileSync(await jpeg("l/seed.jpg")));
    writeFileSync(path.join(dir, "Card2", "6F9A9775.CR3"), "raw bytes");
    await shell([jpg]);
    const res = await importFile(jpg, { moveSourcePath: jpg });
    expect(res.json().sourceMove).toEqual({ moved: false, reason: "partner_stays", sidecars: 0 });
    expect(existsSync(jpg)).toBe(true);

    const libraryCopy = (
      await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [res.json().captureId])
    ).rows[0].ref;
    const twin = path.join(lib, "twin-picked.jpg");
    writeFileSync(twin, readFileSync(libraryCopy));
    await shell([twin]);
    const out = await call("/uploads/source-folders/clear", { paths: [twin] });
    expect(out.json().kept).toEqual([{ path: twin, reason: "in_library" }]);
    expect(existsSync(twin)).toBe(true);
  });

  it("clears only files whose library copy is there with the same bytes", async () => {
    const kept = await jpeg("e/kept.jpg");
    const res = await importFile(kept);
    const libraryCopy = (
      await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [res.json().captureId])
    ).rows[0].ref;
    const dupe = path.join(src, "e/copy-of-kept.jpg");
    writeFileSync(dupe, readFileSync(kept));
    const skippedOnly = await jpeg("e/skipped.jpg");

    // The Import page lists it as already in Lifer, beside the photo it became.
    const scan = await call("/uploads/source-folders/scan", { path: src });
    const listed = scan.json().files.find((f: { name: string }) => f.name === "copy-of-kept.jpg");
    expect(listed).toMatchObject({
      status: "imported",
      match: { photoId: expect.any(String), speciesId: SPECIES, commonName: "Moving Plover" },
    });

    // Dry run: counted, nothing moved. The skipped file has nothing in the library.
    const dry = await call("/uploads/source-folders/clear", { paths: [dupe, skippedOnly], dryRun: true });
    expect(dry.json()).toMatchObject({ cleared: 1, trashed: [] });
    expect(existsSync(dupe)).toBe(true);
    expect(dry.json().kept).toEqual([{ path: skippedOnly, reason: "no_library_copy" }]);

    // The library copy damaged: nothing goes, even once the health check has re-baselined it (a
    // new mtime reads as an edit there), which used to vouch for it.
    const good = readFileSync(libraryCopy);
    writeFileSync(libraryCopy, "damaged");
    expect((await call("/uploads/source-folders/clear", { paths: [dupe] })).json().cleared).toBe(0);
    await db.query(`UPDATE originals SET verified_hash = $1 WHERE ref = $2`, [
      createHash("sha256").update("damaged").digest("hex"),
      libraryCopy,
    ]);
    expect((await call("/uploads/source-folders/clear", { paths: [dupe] })).json().cleared).toBe(0);
    // The library copy missing: nothing goes.
    rmSync(libraryCopy);
    expect((await call("/uploads/source-folders/clear", { paths: [dupe] })).json().cleared).toBe(0);
    expect(existsSync(dupe)).toBe(true);

    writeFileSync(libraryCopy, good);
    const done = await call("/uploads/source-folders/clear", { paths: [dupe, skippedOnly] });
    expect(done.json()).toMatchObject({ cleared: 1, trashed: [dupe] });
    expect(existsSync(dupe)).toBe(false);
    expect(existsSync(skippedOnly)).toBe(true);
  });

  it("never touches a file inside the library's own folder", async () => {
    await db.query(`INSERT INTO import_source_folders (user_id, path, photo_count) VALUES ($1, $2, 0)`, [userId, dir]);
    const file = await jpeg("f/IMG_5.jpg");
    const res = await importFile(file);
    const libraryCopy = (
      await db.query<{ ref: string }>(`SELECT ref FROM originals WHERE capture_id = $1`, [res.json().captureId])
    ).rows[0].ref;
    const twin = path.join(lib, "twin.jpg");
    writeFileSync(twin, readFileSync(libraryCopy));
    const out = await call("/uploads/source-folders/clear", { paths: [twin, libraryCopy] });
    expect(out.json()).toMatchObject({ cleared: 0, trashed: [] });
    expect(out.json().kept.map((k: { reason: string }) => k.reason)).toEqual(["in_library", "in_library"]);
    expect(existsSync(twin) && existsSync(libraryCopy)).toBe(true);
    await db.query(`DELETE FROM import_source_folders WHERE user_id = $1 AND path = $2`, [userId, dir]);
  });

  it("moves each sidecar convention with its photo and leaves other photos' sidecars", async () => {
    const file = await jpeg("g/IMG_6.jpg");
    for (const name of ["IMG_6.xmp", "IMG_6.JPG.XMP", "IMG_7.xmp", "IMG_7.jpg.xmp", "IMG_6.CR3.xmp", "notes.xmp"])
      writeFileSync(path.join(src, "g", name), "<x/>");
    writeFileSync(path.join(src, "g/IMG_7.jpg"), "another photo, not imported");
    const res = await importFile(file, { moveSourcePath: file });
    expect(res.json().sourceMove).toEqual({ moved: true, reason: null, sidecars: 2 });
    expect(inTrash("IMG_6.xmp") && inTrash("IMG_6.JPG.XMP")).toBe(true);
    for (const name of ["IMG_7.xmp", "IMG_7.jpg.xmp", "IMG_6.CR3.xmp", "notes.xmp", "IMG_7.jpg"])
      expect(existsSync(path.join(src, "g", name))).toBe(true);
  });

  it("a sidecar the Trash refuses (a locked file) stays, and the photo still moves", async () => {
    const file = await jpeg("h/IMG_8.jpg");
    writeFileSync(path.join(src, "h/IMG_8.xmp"), "<x/>");
    fake.refuse.add("IMG_8.xmp");
    const res = await importFile(file, { moveSourcePath: file });
    expect(res.json().sourceMove).toEqual({ moved: true, reason: null, sidecars: 0 });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(path.join(src, "h/IMG_8.xmp"))).toBe(true);
  });

  it("a photo the Trash refuses keeps its sidecar too", async () => {
    const file = await jpeg("i/IMG_9.jpg");
    writeFileSync(path.join(src, "i/IMG_9.jpg.xmp"), "<x/>");
    fake.refuse.add("IMG_9.jpg");
    const res = await importFile(file, { moveSourcePath: file });
    expect(res.json().sourceMove).toMatchObject({ moved: false, reason: "trash_failed" });
    expect(existsSync(path.join(src, "i/IMG_9.jpg.xmp"))).toBe(true);
    expect(fake.calls).toEqual([["IMG_9.jpg"]]);
  });

  it("clearing out files already in Lifer takes their sidecars and counts them", async () => {
    const kept = await jpeg("j/IMG_11.jpg");
    await importFile(kept);
    writeFileSync(path.join(src, "j/IMG_11.jpg.xmp"), "<x/>");
    writeFileSync(path.join(src, "j/IMG_11.xmp"), "<x/>");
    const dry = await call("/uploads/source-folders/clear", { paths: [kept], dryRun: true });
    expect(dry.json()).toMatchObject({ cleared: 1, sidecars: 2, trashed: [] });
    const done = await call("/uploads/source-folders/clear", { paths: [kept] });
    expect(done.json()).toMatchObject({ cleared: 1, sidecars: 2 });
    expect(inTrash("IMG_11.jpg.xmp") && inTrash("IMG_11.xmp")).toBe(true);
  });
});
