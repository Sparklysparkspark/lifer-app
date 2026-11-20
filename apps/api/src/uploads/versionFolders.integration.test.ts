// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run versionFolders
// Version folders (Prints, B&W...), version labels, the badge counts and the Gallery's
// "every version as its own photo".
import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000001931";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000193a";
const TOKEN = "lifer_test_version_folders_1931";

describe.skipIf(!url)("version folders", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let cookieName: string;
  let exiftool: ExifTool;
  let grouping: typeof import("./versionGrouping.js");
  let fingerprintOf: (file: string) => Promise<{ strict: string | null }>;
  const ids: Record<string, string> = {};

  const call = (method: "GET" | "POST" | "PUT", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  // No sub-second: the strict suffix rule can't act, so only the folder rule links.
  const PRESS = { DateTimeOriginal: "2024:05:01 07:12:33", SerialNumber: "012345", Model: "Canon EOS R5" };

  async function importFile(key: string, rel: string, tags: Record<string, string>) {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const jpeg = `${file}.tmp.jpg`;
    await sharp({ create: { width: 60, height: 40, channels: 3, background: "#777" } })
      .jpeg()
      .toFile(jpeg);
    if (Object.keys(tags).length) await exiftool.write(jpeg, tags as never, { writeArgs: ["-overwrite_original"] });
    renameSync(jpeg, file);
    const fp = await fingerprintOf(file);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, exif_fingerprint, taken_at)
       VALUES ($1, $2, $3, $4, '2024-05-01T07:12:33Z') RETURNING id`,
      [USER, SPECIES, `version-folders-${key}`, fp.strict],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
       VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', 60, 40) RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, 'jpeg', 'path', $3, false, $4, 1000)`,
      [USER, c.rows[0].id, file, `version-folders-hash-${key}`],
    );
    ids[key] = c.rows[0].id;
  }

  const decision = async (key: string) =>
    (
      await db.query<{ group_capture_id: string; evidence: string; state: string }>(
        `SELECT group_capture_id, evidence, state FROM capture_versions WHERE capture_id = $1`,
        [ids[key]],
      )
    ).rows[0] ?? null;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-version-folders-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    exiftool = new ExifTool();
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("../captures/routes.js");
    const { galleryRoutes } = await import("../gallery/routes.js");
    grouping = await import("./versionGrouping.js");
    ({ computeExifFingerprint: fingerprintOf } = await import("./exif.js"));

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'version-folders@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 921931, 'Ardea testus', 'Test Heron', 'aves')`,
      [SPECIES],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      SPECIES,
    ]);

    // Same press and name, the copy in a B&W folder: linked.
    await importFile("heron", "Heron/IMG_7.jpg", PRESS);
    await importFile("heronBw", "Heron/B&W/IMG_7.jpg", PRESS);
    // A print with its metadata stripped: the name and folder only suggest.
    await importFile("egret", "Heron/IMG_8.jpg", { ...PRESS, DateTimeOriginal: "2024:05:02 08:00:00" });
    await importFile("egretPrint", "Heron/Prints/IMG_8_16x20.jpg", {});
    // A print folder file with no original of its name: never grouped on the folder alone.
    await importFile("stray", "Heron/Prints/DSC_9999.jpg", {});
    // The original in a sibling folder.
    await importFile("owl", "Owl/RAW/IMG_9.jpg", { ...PRESS, DateTimeOriginal: "2024:05:03 09:00:00" });
    await importFile("owlEdit", "Owl/Edits/IMG_9-Edit.jpg", {});
    // A folder name the user adds later.
    await importFile("lynx", "Lynx/IMG_3.jpg", { ...PRESS, DateTimeOriginal: "2024:05:04 10:00:00" });
    await importFile("lynxFinal", "Lynx/Finals/IMG_3.jpg", {});

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    await exiftool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links on folder, name and press; suggests on folder and name; never on the folder alone", async () => {
    expect(await grouping.runVersionGroupingPass()).toEqual({ linked: 1, suggested: 2 });
    expect(await decision("heronBw")).toEqual({
      group_capture_id: ids.heron,
      evidence: "version_folder",
      state: "linked",
    });
    expect(await decision("egretPrint")).toMatchObject({ group_capture_id: ids.egret, state: "suggested" });
    expect(await decision("owlEdit")).toMatchObject({ group_capture_id: ids.owl, evidence: "version_folder" });
    expect(await decision("stray")).toBeNull();
    expect(await decision("lynxFinal")).toBeNull();
    const roles = await db.query<{ ref: string; role: string }>(`SELECT ref, role FROM originals WHERE user_id = $1`, [
      USER,
    ]);
    expect(roles.rows.find((r) => r.ref.endsWith("B&W/IMG_7.jpg"))?.role).toBe("export");
  });

  it("is idempotent", async () => {
    const before = await db.query(`SELECT * FROM capture_versions WHERE user_id = $1 ORDER BY capture_id`, [USER]);
    await db.query(`UPDATE originals SET role = NULL WHERE user_id = $1`, [USER]);
    expect(await grouping.runVersionGroupingPass()).toEqual({ linked: 0, suggested: 0 });
    const after = await db.query(`SELECT * FROM capture_versions WHERE user_id = $1 ORDER BY capture_id`, [USER]);
    expect(after.rows).toEqual(before.rows);
  });

  it("looks again in one folder with the user's folder names", async () => {
    const saved = await call("PUT", "/api/captures/versions/folders", { names: [" Finals ", "finals", "Prints", ""] });
    expect(saved.json().names).toEqual(["Finals", "Prints"]);
    const start = await call("POST", "/api/captures/versions/scan", { folder: path.join(dir, "Lynx") + path.sep });
    expect(start.statusCode).toBe(202);
    await grouping.versionGroupingJob.settled();
    expect(grouping.versionGroupingJob.status.result).toEqual({ linked: 0, suggested: 1 });
    expect(await decision("lynxFinal")).toMatchObject({ group_capture_id: ids.lynx, state: "suggested" });
    // Only that folder was read, and a second look changes nothing.
    expect(grouping.versionGroupingJob.status.total).toBe(2);
    await call("POST", "/api/captures/versions/scan", { folder: path.join(dir, "Lynx") });
    await grouping.versionGroupingJob.settled();
    expect(grouping.versionGroupingJob.status.result).toEqual({ linked: 0, suggested: 0 });
    const reset = await call("PUT", "/api/captures/versions/folders", { names: null });
    expect(reset.json().names).toContain("B&W");
  });

  it("labels versions from their names and folders, and keeps a person's own name", async () => {
    let body = (await call("GET", `/api/captures/${ids.heronBw}/versions`)).json();
    expect(body.versions.map((v: { captureId: string; labelKind: string }) => [v.captureId, v.labelKind])).toEqual([
      [ids.heron, "original"],
      [ids.heronBw, "bw"],
    ]);
    expect(grouping.versionLabel("/a/Moose/IMG_1_8x10.jpg", "export")).toEqual({ kind: "print", size: "8x10" });
    expect(grouping.versionLabel("/a/Moose/IMG_1-Pano.jpg", "export").kind).toBe("pano");

    const named = await call("PUT", `/api/captures/${ids.heronBw}/versions/label`, { label: "  Gallery print " });
    expect(named.json()).toEqual({ label: "Gallery print" });
    body = (await call("GET", `/api/captures/${ids.heron}/versions`)).json();
    expect(body.versions[1]).toMatchObject({ label: "Gallery print", labelKind: "bw" });
    await call("PUT", `/api/captures/${ids.heronBw}/versions/label`, { label: null });
    body = (await call("GET", `/api/captures/${ids.heron}/versions`)).json();
    expect(body.versions[1].label).toBeNull();
  });

  it("counts each group's versions and sums up what was grouped", async () => {
    expect((await call("GET", "/api/captures/version-counts")).json()).toEqual({ counts: { [ids.heron]: 2 } });
    const summary = (await call("GET", "/api/captures/version-summary")).json();
    expect(summary).toMatchObject({ versions: 1, photos: 1 });
    const later = await call("GET", `/api/captures/version-summary?since=${encodeURIComponent(summary.latest)}`);
    expect(later.json()).toMatchObject({ versions: 0, photos: 0 });
    expect((await call("GET", "/api/captures/version-summary?since=nonsense")).statusCode).toBe(400);
  });

  it("lists every version as its own item only when asked", async () => {
    const plain = (await call("GET", "/api/gallery")).json();
    expect(plain.items.map((i: { captureId: string }) => i.captureId)).not.toContain(ids.heronBw);
    const all = (await call("GET", "/api/gallery?allVersions=1")).json();
    expect(all.total).toBe(plain.total + 1);
    const version = all.items.find((i: { captureId: string }) => i.captureId === ids.heronBw);
    expect(version.version).toEqual({ of: ids.heron, label: null, labelKind: "bw", labelSize: null });
    expect(all.items.find((i: { captureId: string }) => i.captureId === ids.heron).version).toBeUndefined();

    // Used as the photo, the B&W copy shows on the photo's card; the version card then holds
    // the original, and is named after it.
    await call("POST", `/api/captures/${ids.heron}/versions/show`, { captureId: ids.heronBw });
    const swapped = (await call("GET", "/api/gallery?allVersions=1")).json();
    expect(swapped.items.find((i: { captureId: string }) => i.captureId === ids.heronBw).version).toMatchObject({
      of: ids.heron,
      labelKind: "original",
    });
    await call("POST", `/api/captures/${ids.heron}/versions/show`, { captureId: ids.heron });
  });
});
