// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Title, Headline, Caption and extra Keywords templates written into JPEG, DNG, HEIC and RAW
// sidecars, in XMP and IPTC together, by each field's rule, never over a value edited elsewhere.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { ExifTool } from "exiftool-vendored";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000271";
const OTHER_USER = "dddddddd-0000-4000-8000-000000000272";
const VULTURE = "dddddddd-0000-4000-8000-00000000027a";
const OSPREY = "dddddddd-0000-4000-8000-00000000027b";
const HERON = "dddddddd-0000-4000-8000-00000000027c";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "fields@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const FIELDS = {
  title: { template: "{names}", rule: "replace" },
  headline: { template: "{species}, {family}", rule: "replace" },
  caption: {
    template: "An image of a {species}[[ taken on {longdate}]][[ with a {focal} {aperture}]]",
    rule: "replace",
  },
  keywords: { template: "{family}, {order}, Wildlife", rule: "replace" },
  multiSpecies: "all",
};

describe.skipIf(!url)("metadata field templates", { timeout: 30_000 }, () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;
  const et = new ExifTool({ maxProcs: 1 });
  let sync: typeof import("../uploads/xmpSidecarSync.js").syncCaptureXmpSidecars;

  const call = (method: "GET" | "PUT" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: `/api${route}`, payload: payload as object });
  const xmp = async (file: string) => (await et.read(file, { readArgs: ["-XMP:all"] })) as Record<string, unknown>;
  const iptc = async (file: string) => (await et.read(file, { readArgs: ["-IPTC:all"] })) as Record<string, unknown>;

  async function capture(fingerprint: string, files: { kind: "jpeg" | "raw"; file: string }[], userId = USER) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, focal_length_mm, aperture)
       VALUES ($1, $2, $3, '2024-05-12T09:00:00Z', 600, 4) RETURNING id`,
      [userId, VULTURE, fingerprint],
    );
    for (const f of files)
      await db.query(
        `INSERT INTO originals (capture_id, user_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'path', $4, true, $5, 1)`,
        [c.rows[0].id, userId, f.kind, f.file, `${fingerprint}-${f.kind}`],
      );
    return c.rows[0].id;
  }

  async function cleanup() {
    for (const u of [USER, OTHER_USER]) {
      await db.query(
        `DELETE FROM capture_species WHERE capture_id IN (SELECT id FROM captures_all WHERE user_id = $1)`,
        [u],
      );
      await db.query(`DELETE FROM originals WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM install_settings WHERE key = $1`, [`metadata_template:${u}`]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[VULTURE, OSPREY, HERON]]);
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-fields-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dir;
    process.env.APP_DATA_DIR = path.join(dir, "app-data");
    db = new pg.Pool({ connectionString: url });
    ({ syncCaptureXmpSidecars: sync } = await import("../uploads/xmpSidecarSync.js"));
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'fields@test', 'x'), ($2, 'fields-other@test', 'x')`,
      [USER, OTHER_USER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family) VALUES
         ($1, 927101, 'Gyps testus', 'Test Griffon Vulture', 'aves', 'Accipitriformes', 'Accipitridae'),
         ($2, 927102, 'Pandion testus', 'Test Osprey', 'aves', 'Accipitriformes', 'Pandionidae'),
         ($3, 927103, 'Ardea testus', 'Test Heron', 'aves', 'Pelecaniformes', 'Ardeidae')`,
      [VULTURE, OSPREY, HERON],
    );
    const { metadataSettingsRoutes } = await import("./metadataRoutes.js");
    app = Fastify();
    await app.register(metadataSettingsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await et.end();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("defaults to today's behaviour and validates templates", async () => {
    const res = (await call("GET", "/settings/metadata-fields")).json();
    expect(res.fields).toEqual({
      title: { template: "{names}", rule: "replace" },
      headline: { template: "", rule: "replace" },
      caption: { template: "", rule: "replace" },
      keywords: { template: "", rule: "replace" },
      multiSpecies: "all",
    });
    expect(res.variables).toContain("genus");
    const bad = await call("PUT", "/settings/metadata-fields", {
      ...FIELDS,
      headline: { template: "{nope}", rule: "replace" },
    });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: "Unknown variable {nope}" }]);
    const saved = await call("PUT", "/settings/metadata-fields", FIELDS);
    expect(saved.json().fields).toEqual(FIELDS);
    // The credits screen edits the same caption and keeps the field templates.
    const credits = {
      creator: "Jane",
      copyright: "",
      credit: "",
      usageTerms: "",
      caption: FIELDS.caption.template,
      replaceExisting: false,
    };
    expect((await call("PUT", "/settings/metadata-template", credits)).statusCode).toBe(200);
    expect((await call("GET", "/settings/metadata-fields")).json().fields).toEqual(FIELDS);
  });

  it("writes every field into XMP and IPTC together in a JPEG and a DNG, and into a RAW's sidecar", async () => {
    const jpeg = path.join(dir, "IMG_1.jpg");
    const dng = path.join(dir, "IMG_2.dng");
    const raw = path.join(dir, "IMG_1.CR3");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(jpeg);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .tiff()
      .toFile(dng);
    writeFileSync(raw, "not really a raw");
    const id = await capture("fields-1", [
      { kind: "jpeg", file: jpeg },
      { kind: "raw", file: raw },
    ]);
    await db.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`, [id, OSPREY]);
    const dngId = await capture("fields-2", [{ kind: "jpeg", file: dng }]);
    await sync(USER, id);
    await sync(USER, dngId);

    const caption = "An image of a Test Griffon Vulture taken on 12 May 2024 with a 600mm f/4";
    for (const file of [jpeg, dng]) {
      const x = await xmp(file);
      const i = await iptc(file);
      expect(x.Title).toBe(file === jpeg ? "Test Griffon Vulture, Test Osprey" : "Test Griffon Vulture");
      expect(i.ObjectName).toBe(x.Title);
      expect([x.Headline, i.Headline]).toEqual([
        "Test Griffon Vulture, Accipitridae",
        "Test Griffon Vulture, Accipitridae",
      ]);
      expect([x.Description, i["Caption-Abstract"]]).toEqual([caption, caption]);
      expect(x.Subject).toEqual(
        expect.arrayContaining(["Test Griffon Vulture", "Accipitridae", "Accipitriformes", "Wildlife"]),
      );
      expect(i.Keywords).toEqual(x.Subject);
    }
    const side = await xmp(path.join(dir, "IMG_1.xmp"));
    expect([side.Title, side.Headline, side.Description]).toEqual([
      "Test Griffon Vulture, Test Osprey",
      "Test Griffon Vulture, Accipitridae",
      caption,
    ]);
    const recorded = await db.query(
      `SELECT w.slot, w.field FROM capture_written_metadata w JOIN originals o ON o.id = w.original_id
        WHERE o.capture_id = $1 ORDER BY 1, 2`,
      [id],
    );
    expect(recorded.rows.map((r) => `${r.slot}:${r.field}`)).toEqual([
      "file:caption",
      "file:headline",
      "file:keywords",
      "file:title",
      "stem:caption",
      "stem:headline",
      "stem:keywords",
      "stem:title",
    ]);

    // Main species only: the second species leaves the title, never the keywords.
    await call("PUT", "/settings/metadata-fields", { ...FIELDS, multiSpecies: "main" });
    await sync(USER, id);
    expect((await xmp(jpeg)).Title).toBe("Test Griffon Vulture");
    expect((await xmp(jpeg)).Subject).toEqual(expect.arrayContaining(["Test Osprey"]));
    await call("PUT", "/settings/metadata-fields", FIELDS);
  });

  it("writes into a HEIC", async (ctx) => {
    const heic = path.join(dir, "IMG_3.heic");
    try {
      await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
        .heif({ compression: "av1" })
        .toFile(heic);
    } catch {
      return ctx.skip();
    }
    await sync(USER, await capture("fields-3", [{ kind: "jpeg", file: heic }]));
    const x = await xmp(heic);
    expect([x.Title, x.Headline]).toEqual(["Test Griffon Vulture", "Test Griffon Vulture, Accipitridae"]);
    expect((await sharp(heic).metadata()).width).toBe(8);
  });

  it("keeps a title and keywords edited in another app, and counts them on a dry run", async () => {
    const jpeg = path.join(dir, "IMG_4.jpg");
    const raw = path.join(dir, "IMG_4.CR3");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(jpeg);
    writeFileSync(raw, "not really a raw");
    const id = await capture("fields-4", [
      { kind: "jpeg", file: jpeg },
      { kind: "raw", file: raw },
    ]);
    await sync(USER, id);
    await et.write(jpeg, { "XMP-dc:Title": "My own title", "IPTC:ObjectName": "My own title" } as never, [
      "-overwrite_original",
    ]);
    await et.write(jpeg, { "XMP-dc:Subject-": "Wildlife", "IPTC:Keywords-": "Wildlife" } as never, [
      "-overwrite_original",
    ]);
    await et.write(jpeg, { "XMP-dc:Subject+": "sunset", "IPTC:Keywords+": "sunset" } as never, ["-overwrite_original"]);
    await db.query(`UPDATE captures_all SET species_id = $2 WHERE id = $1`, [id, HERON]);

    const dry = await call("POST", "/settings/metadata-template/apply?dryRun=1");
    expect(dry.json()).toMatchObject({ dryRun: true, failed: 0 });
    expect(dry.json().updated).toBeGreaterThanOrEqual(1);
    expect(dry.json().edited).toBe(1);
    expect((await xmp(path.join(dir, "IMG_4.xmp"))).Title).toBe("Test Griffon Vulture");

    const applied = (await call("POST", "/settings/metadata-template/apply")).json();
    expect(applied).toMatchObject({ dryRun: false, failed: 0, edited: 1 });
    const file = await xmp(jpeg);
    expect(file.Title).toBe("My own title");
    expect((await iptc(jpeg)).ObjectName).toBe("My own title");
    // Lifer's own text follows the new species; the extra keywords someone edited stay as they are.
    expect(file.Headline).toBe("Test Heron, Ardeidae");
    expect(file.Subject).toEqual(expect.arrayContaining(["sunset", "Accipitridae", "Test Heron"]));
    expect(file.Subject).not.toContain("Wildlife");
    const side = await xmp(path.join(dir, "IMG_4.xmp"));
    expect(side.Title).toBe("Test Heron");
    expect(side.Subject).toEqual(expect.arrayContaining(["Ardeidae", "Pelecaniformes", "Wildlife"]));
    expect(side.Subject).not.toContain("Accipitridae");
    expect((await call("POST", "/settings/metadata-template/apply?dryRun=1")).json()).toMatchObject({
      updated: 0,
      edited: 1,
    });
  });

  it("treats files written before the record by their in-file markers", async () => {
    const jpeg = path.join(dir, "IMG_5.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(jpeg);
    const id = await capture("fields-5", [{ kind: "jpeg", file: jpeg }]);
    // As an older Lifer left it: a species-name title and a caption marked as Lifer's.
    await et.write(
      jpeg,
      {
        "XMP-dc:Title": "Test Heron (Ardea testus)",
        "XMP-dc:Description": "Old caption",
        "XMP-photoshop:CaptionWriter": "Lifer",
        "XMP-photoshop:Headline": "Typed headline",
      } as never,
      ["-overwrite_original"],
    );
    await sync(USER, id);
    let x = await xmp(jpeg);
    expect(x.Title).toBe("Test Griffon Vulture");
    expect(x.Description).toMatch(/^An image of a Test Griffon Vulture/);
    expect(x.Headline).toBe("Typed headline");

    // A title and caption typed by the user, no marker: kept.
    const other = path.join(dir, "IMG_6.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(other);
    await et.write(other, { "XMP-dc:Title": "Sunset over the lake", "XMP-dc:Description": "Mine" } as never, [
      "-overwrite_original",
    ]);
    await sync(USER, await capture("fields-6", [{ kind: "jpeg", file: other }]));
    x = await xmp(other);
    expect([x.Title, x.Description]).toEqual(["Sunset over the lake", "Mine"]);
  });

  it("appends after the file's own caption once, and writes nothing when off", async () => {
    const jpeg = path.join(dir, "IMG_7.jpg");
    await sharp({ create: { width: 8, height: 8, channels: 3, background: "#888" } })
      .jpeg()
      .toFile(jpeg);
    await et.write(jpeg, { "XMP-dc:Description": "Day one." } as never, ["-overwrite_original"]);
    const id = await capture("fields-7", [{ kind: "jpeg", file: jpeg }]);
    await call("PUT", "/settings/metadata-fields", {
      ...FIELDS,
      caption: { template: "{species}", rule: "append" },
      headline: { template: "{species}", rule: "off" },
    });
    await sync(USER, id);
    await sync(USER, id);
    const x = await xmp(jpeg);
    expect(x.Description).toBe("Day one. Test Griffon Vulture");
    expect(x.Headline).toBeUndefined();
    expect(x.CaptionWriter).toBeUndefined();
    await call("PUT", "/settings/metadata-fields", FIELDS);
  });

  it("previews every field for a photo, and only the user's own", async () => {
    const id = (await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE fingerprint = 'fields-1'`)).rows[0]
      .id;
    const res = (await call("GET", `/settings/metadata-preview?captureId=${id}`)).json();
    expect(res).toMatchObject({
      sample: false,
      captureId: id,
      fields: {
        title: "Test Griffon Vulture, Test Osprey",
        headline: "Test Griffon Vulture, Accipitridae",
        keywords: ["Accipitridae", "Accipitriformes", "Wildlife"],
        creator: "Jane",
      },
    });
    expect(res.values).toMatchObject({
      genus: "Gyps",
      focal: "600mm",
      aperture: "f/4",
      count: "2",
      longdate: "12 May 2024",
    });
    const main = (await call("GET", `/settings/metadata-preview?captureId=${id}&multiSpecies=main`)).json();
    expect(main.fields.title).toBe("Test Griffon Vulture");

    const jpeg = path.join(dir, "IMG_8.jpg");
    const theirs = await capture("fields-8", [{ kind: "jpeg", file: jpeg }], OTHER_USER);
    expect((await call("GET", `/settings/metadata-preview?captureId=${theirs}`)).statusCode).toBe(404);
    expect((await call("GET", "/settings/metadata-preview?captureId=nope")).statusCode).toBe(400);
    expect((await call("GET", "/settings/metadata-preview")).json().sample).toBe(false);
  });
});
