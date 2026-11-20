// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run versionGrouping
// Edits and exports of one moment become one capture, only on evidence, and every link undoes.
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
const USER = "eeeeeeee-0000-4000-8000-000000001851";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000185a";
const TOKEN = "lifer_test_versions_1851";

describe.skipIf(!url)("photo versions", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let cookieName: string;
  let exiftool: ExifTool;
  let runPass: () => Promise<{ linked: number; suggested: number }>;
  let fingerprintOf: (file: string) => Promise<{ strict: string | null; loose: string | null }>;
  const ids: Record<string, string> = {};

  const call = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  type Tags = Record<string, string>;
  const PRESS: Tags = {
    DateTimeOriginal: "2024:05:01 07:12:33",
    SubSecTimeOriginal: "42",
    SerialNumber: "012345",
    Model: "Canon EOS R5",
  };

  async function writeFile(rel: string, size: number, tags: Tags): Promise<string> {
    const file = path.join(dir, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    // Written as a JPEG, then named as the format it stands in for: only metadata is read.
    const jpeg = `${file}.tmp.jpg`;
    await sharp({ create: { width: size, height: Math.round(size * 0.66), channels: 3, background: "#777" } })
      .jpeg()
      .toFile(jpeg);
    await exiftool.write(jpeg, tags as never, { writeArgs: ["-overwrite_original"] });
    renameSync(jpeg, file);
    return file;
  }

  /** One file imported as its own capture, as every import does before grouping. */
  async function importFile(key: string, rel: string, size: number, tags: Tags, kind: "jpeg" | "raw" = "jpeg") {
    const file = await writeFile(rel, size, tags);
    const fp = await fingerprintOf(file);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, exif_fingerprint, taken_at)
       VALUES ($1, $2, $3, $4, '2024-05-01T07:12:33Z') RETURNING id`,
      [USER, SPECIES, `versions-${key}`, fp.strict],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
       VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', $2, $3) RETURNING id`,
      [c.rows[0].id, size, Math.round(size * 0.66)],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, $3, 'path', $4, false, $5, 1000)`,
      [USER, c.rows[0].id, kind, file, `versions-hash-${key}`],
    );
    ids[key] = c.rows[0].id;
  }

  const visible = async () =>
    Number((await db.query(`SELECT count(*) FROM captures WHERE user_id = $1`, [USER])).rows[0].count);
  const groupOf = async (key: string) =>
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
    dir = mkdtempSync(path.join(tmpdir(), "lifer-versions-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    exiftool = new ExifTool();
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { captureRoutes } = await import("../captures/routes.js");
    ({ runVersionGroupingPass: runPass } = await import("./versionGrouping.js"));
    ({ computeExifFingerprint: fingerprintOf } = await import("./exif.js"));

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'versions@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 921851, 'Alces testus', 'Test Moose', 'mammalia')`,
      [SPECIES],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      SPECIES,
    ]);

    // Three exports of one press sharing a document, at three sizes.
    const moose = { ...PRESS, "XMP-xmpMM:OriginalDocumentID": "AAAA1111BBBB2222CCCC3333DDDD4444" };
    await importFile("moose", "Moose/_M8A6162.jpg", 120, { ...moose, "XMP-xmpMM:DocumentID": "xmp.did:01" });
    await importFile("moose2", "Moose/_M8A6162-2.jpg", 64, { ...moose, "XMP-xmpMM:DocumentID": "xmp.did:02" });
    await importFile("moose6", "Moose/_M8A6162-6.jpg", 200, { ...moose, "XMP-xmpMM:DocumentID": "xmp.did:06" });
    // Same press, its own document: never linked by the rules, only suggested.
    await importFile("other", "Moose/_M8A6162-9.jpg", 90, {
      ...PRESS,
      "XMP-xmpMM:OriginalDocumentID": "EEEE5555FFFF6666EEEE5555FFFF6666",
    });

    // A RAW, its denoised DNG and three exports.
    const fox = { ...PRESS, DateTimeOriginal: "2024:06:02 18:00:01" };
    const foxDoc = { "XMP-xmpMM:OriginalDocumentID": "9999888877776666", ...fox };
    await importFile("raw", "Fox/IMG_1.CR3", 100, fox, "raw");
    await importFile("dng", "Fox/IMG_1-Enhanced-NR.dng", 100, { ...foxDoc, "XMP-xmpMM:DocumentID": "xmp.did:d1" });
    for (const n of ["2", "3", "4"]) {
      await importFile(`fox${n}`, `Fox/IMG_1-${n}.jpg`, 80, { ...foxDoc, "XMP-xmpMM:DocumentID": `xmp.did:e${n}` });
    }

    // One stem in two folders, different presses.
    await importFile("a", "a/IMG_5.jpg", 50, { ...PRESS, DateTimeOriginal: "2023:01:01 10:00:00" });
    await importFile("b", "b/IMG_5.jpg", 50, { ...PRESS, DateTimeOriginal: "2023:02:01 10:00:00" });

    app = Fastify();
    await app.register(cookie);
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    await exiftool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("links only on evidence and counts the moment once", async () => {
    const before = await visible();
    expect(before).toBe(11);
    await runPass();

    // The camera file wins the group; the exports link on their shared document.
    const moose = await groupOf("moose2");
    expect(moose).toMatchObject({ evidence: "document_id", state: "linked" });
    expect(await groupOf("moose6")).toMatchObject({ group_capture_id: moose.group_capture_id });
    expect(await groupOf("other")).toMatchObject({ state: "suggested" });

    // The DNG links to the RAW on the press and its name; the exports follow its document.
    expect(await groupOf("dng")).toMatchObject({
      group_capture_id: ids.raw,
      evidence: "time_serial_suffix",
      state: "linked",
    });
    for (const n of ["2", "3", "4"]) expect(await groupOf(`fox${n}`)).toMatchObject({ group_capture_id: ids.raw });

    expect(await groupOf("a")).toBeNull();
    expect(await groupOf("b")).toBeNull();
    // 11 files: one moose, one suggested moose, one fox, two IMG_5.
    expect(await visible()).toBe(5);

    const roles = await db.query<{ ref: string; role: string }>(`SELECT ref, role FROM originals WHERE user_id = $1`, [
      USER,
    ]);
    const role = (name: string) => roles.rows.find((r) => r.ref.endsWith(name))?.role;
    expect(role("IMG_1.CR3")).toBe("original");
    expect(role("IMG_1-Enhanced-NR.dng")).toBe("edit");
    expect(role("IMG_1-2.jpg")).toBe("export");
  });

  it("shows the newest edit and lists every file, the shown one first", async () => {
    const res = await call("GET", `/api/captures/${ids.fox3}/versions`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.groupCaptureId).toBe(ids.raw);
    expect(body.files).toHaveLength(5);
    expect(body.files[0]).toMatchObject({ captureId: ids.dng, shown: true, role: "edit", format: "DNG" });
    // The group's capture now shows the DNG's photo row.
    const shown = await db.query(
      `SELECT capture_id FROM photos p JOIN captures c ON c.current_photo_id = p.id WHERE c.id = $1`,
      [ids.raw],
    );
    expect(shown.rows[0].capture_id).toBe(ids.raw);
  });

  it("uses an export as the photo and undoes it", async () => {
    const res = await call("POST", `/api/captures/${ids.raw}/versions/show`, { captureId: ids.fox2 });
    expect(res.json()).toEqual({ shownCaptureId: ids.dng });
    let files = (await call("GET", `/api/captures/${ids.raw}/versions`)).json().files;
    expect(files[0]).toMatchObject({ captureId: ids.fox2, shown: true, width: 80 });
    await call("POST", `/api/captures/${ids.raw}/versions/show`, { captureId: ids.dng });
    files = (await call("GET", `/api/captures/${ids.raw}/versions`)).json().files;
    expect(files[0]).toMatchObject({ captureId: ids.dng, shown: true });
  });

  it("splits a version out and links it back", async () => {
    const split = await call("POST", `/api/captures/${ids.moose6}/versions/split`);
    expect(split.json()).toEqual({ groupCaptureId: ids.moose });
    expect(await visible()).toBe(6);
    expect(await groupOf("moose6")).toMatchObject({ state: "dismissed" });

    // A rerun never re-links what a person split.
    await db.query(`UPDATE originals SET role = NULL WHERE capture_id = $1`, [ids.moose6]);
    await runPass();
    expect(await groupOf("moose6")).toMatchObject({ state: "dismissed" });

    const undo = await call("POST", `/api/captures/${ids.moose6}/versions/link`, { groupCaptureId: ids.moose });
    expect(undo.statusCode).toBe(200);
    expect(await groupOf("moose6")).toMatchObject({ state: "linked", evidence: "document_id" });
    expect(await visible()).toBe(5);
  });

  it("refuses nesting groups", async () => {
    const res = await call("POST", `/api/captures/${ids.raw}/versions/link`, { groupCaptureId: ids.a });
    expect(res.statusCode).toBe(409);
  });

  it("confirms suggested groups and undoes a confirmation", async () => {
    const list = (await call("GET", "/api/captures/version-suggestions")).json().suggestions;
    expect(list).toEqual([expect.objectContaining({ captureId: ids.other, groupCaptureId: ids.moose })]);
    const accept = await call("POST", "/api/captures/version-suggestions/accept", { captureIds: [ids.other] });
    expect(accept.json()).toEqual({ linked: [ids.other] });
    expect(await groupOf("other")).toMatchObject({ state: "linked", evidence: "suggested" });
    expect(await visible()).toBe(4);
    await call("POST", `/api/captures/${ids.other}/versions/split`);
    expect(await visible()).toBe(5);
  });

  it("is idempotent", async () => {
    const before = await db.query(`SELECT capture_id, state FROM capture_versions WHERE user_id = $1 ORDER BY 1`, [
      USER,
    ]);
    expect(await runPass()).toEqual({ linked: 0, suggested: 0 });
    const after = await db.query(`SELECT capture_id, state FROM capture_versions WHERE user_id = $1 ORDER BY 1`, [
      USER,
    ]);
    expect(after.rows).toEqual(before.rows);
  });
});
