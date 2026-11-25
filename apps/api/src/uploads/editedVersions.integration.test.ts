// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run editedVersions
// An edited JPEG of a RAW already imported joins that photo as its shown version, on the import
// and in the grouping pass, only on strong evidence; a look-alike stays a photo of its own.
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { ExifTool } from "exiftool-vendored";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000002201";
const RAW_SPECIES = "eeeeeeee-0000-4000-8000-00000000220a";
const PICKED_SPECIES = "eeeeeeee-0000-4000-8000-00000000220b";
const TOKEN = "lifer_test_edited_versions_2201";

type Tags = Record<string, string>;
const PRESS: Tags = {
  DateTimeOriginal: "2026:11:11 07:12:33",
  SubSecTimeOriginal: "45",
  SerialNumber: "098765",
  Model: "Canon EOS R5",
};

describe.skipIf(!url)("edited versions of a RAW", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  let cookieName: string;
  let exiftool: ExifTool;
  let findTarget: typeof import("./versionGrouping.js").findEditedVersionTarget;
  let runPass: typeof import("./versionGrouping.js").runVersionGroupingPass;
  let readTags: typeof import("./exif.js").readExifTags;
  let fingerprintOf: typeof import("./exif.js").computeExifFingerprint;

  async function writeFile(rel: string, tags: Tags, shade = 120): Promise<string> {
    const file = path.join(dir, "files", rel);
    mkdirSync(path.dirname(file), { recursive: true });
    // Written as a JPEG, then named as the format it stands in for: only metadata is read.
    const jpeg = `${file}.tmp.jpg`;
    await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } })
      .jpeg()
      .toFile(jpeg);
    if (Object.keys(tags).length > 0) await exiftool.write(jpeg, tags as never, { writeArgs: ["-overwrite_original"] });
    renameSync(jpeg, file);
    return file;
  }

  /** A RAW imported on its own: a capture whose only original is the RAW (its preview as the photo). */
  async function rawCapture(rel: string, tags: Tags): Promise<{ id: string; photoId: string }> {
    const file = await writeFile(rel, tags);
    const fp = await fingerprintOf(file);
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, exif_fingerprint, taken_at, location_label)
       VALUES ($1, $2, $3, $4, '2026-11-11T07:12:33Z', 'Daintree') RETURNING id`,
      [USER, RAW_SPECIES, `edited-${rel}`, fp.strict],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
       VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp', 64, 48) RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, 'raw', 'path', $3, false, $4, 1000)`,
      [USER, c.rows[0].id, file, `edited-hash-${rel}`],
    );
    return { id: c.rows[0].id, photoId: p.rows[0].id };
  }

  async function upload(name: string, file: string) {
    const form = new FormData();
    form.append("speciesId", PICKED_SPECIES);
    form.append("file", new Blob([new Uint8Array(readFileSync(file))], { type: "image/jpeg" }), name);
    const res = new Response(form);
    return app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: Buffer.from(await res.arrayBuffer()),
      headers: { "content-type": res.headers.get("content-type")! },
      cookies: { [cookieName]: TOKEN },
    });
  }

  const call = (method: "GET" | "POST" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  const versionOf = async (captureId: string) =>
    (
      await db.query<{ group_capture_id: string; evidence: string; state: string; displayed: boolean }>(
        `SELECT group_capture_id, evidence, state, displayed FROM capture_versions WHERE capture_id = $1`,
        [captureId],
      )
    ).rows[0] ?? null;
  const shownPhoto = async (captureId: string) =>
    (await db.query(`SELECT current_photo_id FROM captures_all WHERE id = $1`, [captureId])).rows[0].current_photo_id;

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1::uuid[])`, [[RAW_SPECIES, PICKED_SPECIES]]);
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-edited-versions-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    exiftool = new ExifTool();
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    ({ findEditedVersionTarget: findTarget, runVersionGroupingPass: runPass } = await import("./versionGrouping.js"));
    ({ readExifTags: readTags, computeExifFingerprint: fingerprintOf } = await import("./exif.js"));
    const { uploadRoutes } = await import("./routes.js");
    const { captureRoutes } = await import("../captures/routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'edited@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 922201, 'Ceyx testus', 'Test Pygmy Kingfisher', 'aves'),
              ($2, 922202, 'Ceyx pickus', 'Picked Kingfisher', 'aves')`,
      [RAW_SPECIES, PICKED_SPECIES],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      RAW_SPECIES,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(uploadRoutes, { prefix: "/api" });
    await app.register(captureRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    await exiftool.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    rmSync(dir, { recursive: true, force: true });
  });

  it("matches on the press and the name, or a shared document, and nothing weaker", async () => {
    const raw = await rawCapture("match/6F9A6672.CR3", PRESS);
    const jpg = await writeFile("match/out/6F9A6672-Edit.jpg", PRESS);
    const tags = (await readTags(jpg)) as Record<string, unknown>;
    const strict = (await fingerprintOf(jpg)).strict;

    expect(await findTarget(USER, "6F9A6672.jpg", tags, strict)).toMatchObject({
      captureId: raw.id,
      speciesId: RAW_SPECIES,
      locationLabel: "Daintree",
      evidence: "time_serial_suffix",
    });
    expect(await findTarget(USER, "6F9A6672-Edit.jpg", tags, strict)).toMatchObject({ captureId: raw.id });
    // The same press under another name: another frame of the burst, never linked here.
    expect(await findTarget(USER, "6F9A6673.jpg", tags, strict)).toBeNull();
    // No sub-second or serial: the press isn't proven.
    const bare = { ...tags, SerialNumber: undefined };
    expect(await findTarget(USER, "6F9A6672.jpg", bare, strict)).toBeNull();

    // A shared XMP document links whatever the file is called.
    await db.query(`UPDATE originals SET document_id = 'aaaa1111bbbb2222' WHERE capture_id = $1`, [raw.id]);
    expect(
      await findTarget(USER, "renamed.jpg", { OriginalDocumentID: "xmp.did:AAAA1111-BBBB2222" }, null),
    ).toMatchObject({ captureId: raw.id, evidence: "document_id" });
    await db.query(`UPDATE originals SET document_id = NULL WHERE capture_id = $1`, [raw.id]);
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [raw.id]);
  });

  it("imports the edited JPEG as the RAW's shown version, under its species, and undoes", async () => {
    const raw = await rawCapture("import/IMG_0042.CR3", PRESS);
    const lightroom = { ...PRESS, Software: "Adobe Lightroom 10.0 (Macintosh)" };
    const res = await upload("IMG_0042.jpg", await writeFile("import/IMG_0042.jpg", lightroom));
    expect(res.statusCode).toBe(201);
    const { captureId, photoId } = res.json();

    expect(await versionOf(captureId)).toMatchObject({
      group_capture_id: raw.id,
      evidence: "time_serial_suffix",
      state: "linked",
      displayed: true,
    });
    // One photo on show, the edit, with the RAW's species and place rather than the one picked.
    const visible = await db.query(`SELECT id FROM captures WHERE user_id = $1`, [USER]);
    expect(visible.rows.map((r) => r.id)).toEqual([raw.id]);
    expect(await shownPhoto(raw.id)).toBe(photoId);
    const own = await db.query(`SELECT species_id, location_label FROM captures_all WHERE id = $1`, [captureId]);
    expect(own.rows[0]).toEqual({ species_id: RAW_SPECIES, location_label: "Daintree" });
    // Named at once, before any grouping pass: the RAW reads "RAW" and the edit "Export".
    const listed = (await call("GET", `/api/captures/${raw.id}/versions`)).json() as {
      versions: { captureId: string; labelKind: string }[];
    };
    expect(listed.versions.map((v) => [v.captureId, v.labelKind])).toEqual([
      [raw.id, "raw"],
      [captureId, "export"],
    ]);

    // Showing the RAW again is the usual version switch.
    await call("POST", `/api/captures/${raw.id}/versions/show`, { captureId: raw.id });
    expect(await shownPhoto(raw.id)).toBe(raw.photoId);
    await call("POST", `/api/captures/${raw.id}/versions/show`, { captureId });
    expect(await shownPhoto(raw.id)).toBe(photoId);

    // Undoing the import gives the RAW its own photo back.
    expect((await call("DELETE", `/api/captures/${captureId}`)).statusCode).toBe(200);
    expect(await shownPhoto(raw.id)).toBe(raw.photoId);
  });

  it("keeps a look-alike with nothing but the name and the picture as a photo of its own", async () => {
    await rawCapture("weak/IMG_0077.CR3", PRESS);
    // An export stripped of its camera details: the same picture and name, no proof.
    const res = await upload("IMG_0077.jpg", await writeFile("weak/IMG_0077.jpg", {}));
    expect(res.statusCode).toBe(201);
    expect(await versionOf(res.json().captureId)).toBeNull();
    const own = await db.query(`SELECT species_id FROM captures WHERE id = $1`, [res.json().captureId]);
    expect(own.rows[0].species_id).toBe(PICKED_SPECIES);
  });

  it("groups a pair imported before, showing the edit", async () => {
    const raw = await rawCapture("pass/IMG_0099.CR3", { ...PRESS, SubSecTimeOriginal: "99" });
    const jpgFile = await writeFile("pass/IMG_0099.jpg", { ...PRESS, SubSecTimeOriginal: "99" });
    const fp = await fingerprintOf(jpgFile);
    const jpg = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, exif_fingerprint, taken_at)
       VALUES ($1, $2, 'edited-pass-jpg', $3, '2026-11-11T07:12:33Z') RETURNING id`,
      [USER, RAW_SPECIES, fp.strict],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path, width, height)
       VALUES ($1, '/nowhere/d2.webp', '/nowhere/t2.webp', 64, 48) RETURNING id`,
      [jpg.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, jpg.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, 'jpeg', 'path', $3, false, 'edited-pass-jpg', 1000)`,
      [USER, jpg.rows[0].id, jpgFile],
    );

    // Scoped to this test's files, so it never groups another test's photos.
    await runPass({ userId: USER, folder: dir });
    expect(await versionOf(jpg.rows[0].id)).toMatchObject({
      group_capture_id: raw.id,
      state: "linked",
      displayed: true,
    });
    expect(await shownPhoto(raw.id)).toBe(p.rows[0].id);
  });
});
