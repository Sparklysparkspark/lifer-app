// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Copyright and caption templates written into files, file name templates on import and
// Reorganize, and sensitive species' locations kept out of exports and share links.
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import { ExifTool } from "exiftool-vendored";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "dddddddd-0000-4000-8000-000000000171";
const SPECIES = "dddddddd-0000-4000-8000-00000000017a";
const RARE = "dddddddd-0000-4000-8000-00000000017b";
const COUNTRY = "dddddddd-0000-4000-8000-00000000017c";
const PROVINCE = "dddddddd-0000-4000-8000-00000000017d";
const TOKEN = "lifer_test_metadata_templates_171";
const KEYS = ["metadata_template", "file_name_template", "sensitive_species"].map((k) => `${k}:${USER}`);
let cookieName = "";

async function shot(shade: number, taken: string, model = "Templates"): Promise<Buffer> {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: { r: shade, g: 90, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Make: "TestCam", Model: model }, IFD2: { DateTimeOriginal: taken } })
    .toBuffer();
}

async function form(fields: Record<string, string>, files: { field: string; name: string; bytes: Buffer }[]) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  for (const f of files) body.append(f.field, new Blob([new Uint8Array(f.bytes)], { type: "image/jpeg" }), f.name);
  const res = new Response(body);
  return {
    payload: Buffer.from(await res.arrayBuffer()),
    headers: { "content-type": res.headers.get("content-type")! },
    cookies: { [cookieName]: TOKEN },
  };
}

describe.skipIf(!url)("metadata and file name templates", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let exportRoot: string;
  const et = new ExifTool({ maxProcs: 1 });
  let sync: typeof import("../uploads/xmpSidecarSync.js").syncCaptureXmpSidecars;

  const call = (method: "GET" | "PUT" | "POST" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: `/api${route}`, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const tags = async (file: string) => (await et.read(file)) as Record<string, unknown>;
  const refs = async (captureId: string) =>
    (
      await db.query<{ kind: string; ref: string }>(
        `SELECT kind, ref FROM originals WHERE capture_id = $1 ORDER BY kind`,
        [captureId],
      )
    ).rows;

  async function upload(name: string, taken: string, species = SPECIES, raw?: string) {
    const res = await app.inject({
      method: "POST",
      url: "/api/uploads",
      ...(await form({ speciesId: species, regionId: PROVINCE, locationLabel: "Pigeon Lake" }, [
        { field: "file", name, bytes: await shot(name.length * 9, taken) },
        ...(raw ? [{ field: "rawFile", name: raw, bytes: await shot(name.length * 9 + 1, taken) }] : []),
      ])),
    });
    expect(res.statusCode, res.body).toBe(201);
    const captureId = (
      await db.query<{ id: string }>(`SELECT id FROM captures WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [
        USER,
      ])
    ).rows[0].id;
    // The import writes in the background; this write queues behind it.
    await sync(USER, captureId);
    return captureId;
  }

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sessions WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM install_settings WHERE key = ANY($1)`, [KEYS]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-templates-"));
    exportRoot = mkdtempSync(path.join(tmpdir(), "lifer-templates-export-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    process.env.LIFER_LIBRARY_ROOTS = exportRoot;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    ({ syncCaptureXmpSidecars: sync } = await import("../uploads/xmpSidecarSync.js"));
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'templates@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 917101, 'Pandion testus', 'Test Osprey', 'aves'),
         ($2, 917102, 'Strix rarissima', 'Rare Test Owl', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES, RARE],
    );
    await db.query(
      `INSERT INTO species_traits (species_id, iucn_status, source_attribution) VALUES ($1, 'EN', 'test')
       ON CONFLICT (species_id) DO UPDATE SET iucn_status = 'EN'`,
      [RARE],
    );
    await db.query(
      `INSERT INTO regions (id, name, ebird_region_code) VALUES ($1, 'Testland', 'QZ') ON CONFLICT (id) DO NOTHING`,
      [COUNTRY],
    );
    await db.query(
      `INSERT INTO regions (id, name, ebird_region_code, parent_id) VALUES ($1, 'Test Province', 'QZ-TP', $2)
       ON CONFLICT (id) DO NOTHING`,
      [PROVINCE, COUNTRY],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    const { uploadRoutes } = await import("../uploads/routes.js");
    const { settingsRoutes } = await import("./routes.js");
    const { metadataSettingsRoutes } = await import("./metadataRoutes.js");
    const { albumExportRoutes } = await import("../albums/export.js");
    const { albumShareRoutes } = await import("../shares/routes.js");
    app = Fastify();
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    for (const routes of [uploadRoutes, settingsRoutes, metadataSettingsRoutes, albumExportRoutes, albumShareRoutes])
      await app.register(routes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await et.end();
    if (db) {
      await cleanup();
      await db.query(`DELETE FROM species_traits WHERE species_id = $1`, [RARE]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, RARE]]);
      await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, COUNTRY]]);
      await db.end();
    }
    const { closeExiftool } = await import("../uploads/exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it("starts with nothing written and files keeping their names, and refuses unknown variables", async () => {
    const res = await call("GET", "/settings/metadata");
    expect(res.json()).toEqual({
      template: { creator: "", copyright: "", credit: "", usageTerms: "", caption: "", replaceExisting: false },
      fileNameTemplate: "{original}",
      sensitiveSpecies: { enabled: true },
    });
    const bad = await call("PUT", "/settings/file-name-template", { template: "{species}_{nope}" });
    expect([bad.statusCode, bad.json()]).toEqual([400, { error: "Unknown variable {nope}" }]);
    expect((await call("PUT", "/settings/file-name-template", { template: "photo" })).statusCode).toBe(400);
    const badCaption = await call("PUT", "/settings/metadata-template", {
      creator: "",
      copyright: "",
      credit: "",
      usageTerms: "",
      caption: "{seq}",
      replaceExisting: false,
    });
    expect(badCaption.statusCode).toBe(400);
    const sample = (await call("GET", "/settings/template-example?fileName=%7Bdate%7D_%7Bspecies%7D_%7Bseq%7D")).json();
    expect(sample).toMatchObject({ sample: true, fileName: "2026-05-03_Osprey_0012.jpg" });
  });

  it("keeps the camera's name by default", async () => {
    const captureId = await upload("IMG_0100.jpg", "2026:05:01 08:00:00");
    expect(path.basename((await refs(captureId))[0].ref)).toBe("IMG_0100.jpg");
  });

  it("writes the copyright and caption on import, and the caption follows the place", async () => {
    await call("PUT", "/settings/metadata-template", {
      creator: "Jane Doe",
      copyright: "© {year} Jane Doe",
      credit: "",
      usageTerms: "",
      caption: "{species} ({scientific}), {place}, {region}, {date}",
      replaceExisting: false,
    });
    const captureId = await upload("IMG_0101.jpg", "2026:05:02 08:00:00");
    const file = (await refs(captureId))[0].ref;
    let t = await tags(file);
    expect(t.Creator).toBe("Jane Doe");
    expect(t.Rights).toBe("© 2026 Jane Doe");
    expect(t.CopyrightNotice).toBe("© 2026 Jane Doe");
    expect(t.Description).toBe("Test Osprey (Pandion testus), Pigeon Lake, Test Province, 2026-05-02");
    expect(t.Credit).toBeUndefined();

    await db.query(`UPDATE captures_all SET location_label = NULL WHERE id = $1`, [captureId]);
    await sync(USER, captureId);
    t = await tags(file);
    expect(t.Description).toBe("Test Osprey (Pandion testus), Test Province, 2026-05-02");
  });

  it("never replaces the file's own creator unless asked", async () => {
    const captureId = (
      await db.query<{ id: string }>(`SELECT capture_id AS id FROM originals WHERE ref LIKE '%IMG_0101%'`)
    ).rows[0].id;
    const file = (await refs(captureId))[0].ref;
    await et.write(file, { Creator: ["Someone Else"] } as never, ["-overwrite_original"]);
    await sync(USER, captureId);
    expect((await tags(file)).Creator).toBe("Someone Else");

    // The apply job finds only files whose values differ, so a second run changes nothing.
    const template = (await call("GET", "/settings/metadata")).json().template;
    await call("PUT", "/settings/metadata-template", { ...template, replaceExisting: true });
    const first = (await call("POST", "/settings/metadata-template/apply")).json();
    expect(first.updated).toBeGreaterThanOrEqual(1);
    expect((await tags(file)).Creator).toBe("Jane Doe");
    const again = (await call("POST", "/settings/metadata-template/apply")).json();
    expect(again).toMatchObject({ updated: 0, failed: 0 });
  });

  it("names imports by template, gives a RAW its photo's name, and numbers per day", async () => {
    expect((await call("PUT", "/settings/file-name-template", { template: "{date}_{species}_{seq}" })).json()).toEqual({
      fileNameTemplate: "{date}_{species}_{seq}",
    });
    const first = await upload("IMG_0200.jpg", "2026:05:03 08:00:00", SPECIES, "IMG_0200.CR3");
    const files = await refs(first);
    expect(files.map((f) => path.basename(f.ref)).sort()).toEqual([
      "2026-05-03_Test Osprey_0001.cr3",
      "2026-05-03_Test Osprey_0001.jpg",
    ]);
    const second = await upload("IMG_0201.jpg", "2026:05:03 09:00:00");
    expect(path.basename((await refs(second))[0].ref)).toBe("2026-05-03_Test Osprey_0002.jpg");
    // The camera's name stays in the file, for {original}.
    expect((await tags((await refs(second))[0].ref)).PreservedFileName).toBe("IMG_0201.jpg");
  });

  it("pairs a RAW imported later with its renamed JPEG by the JPEG's camera name", async () => {
    const jpeg = await upload("IMG_0250.jpg", "2026:05:05 08:00:00");
    expect(path.basename((await refs(jpeg))[0].ref)).toBe("2026-05-05_Test Osprey_0001.jpg");
    // Another camera model, so the EXIF fingerprint can't pair them: only the name can.
    const raw = await app.inject({
      method: "POST",
      url: "/api/uploads/raw",
      ...(await form({}, [
        { field: "files", name: "IMG_0250.CR3", bytes: await shot(60, "2026:05:05 08:00:00", "Other") },
      ])),
    });
    expect(raw.statusCode, raw.body).toBe(201);
    expect(raw.json().results[0].linked).toBe(true);
    expect((await refs(jpeg)).map((f) => path.basename(f.ref)).sort()).toEqual([
      "2026-05-05_Test Osprey_0001.cr3",
      "2026-05-05_Test Osprey_0001.jpg",
    ]);
  });

  it("renames existing photos on Reorganize, never overwriting, and leaves named ones alone", async () => {
    await call("PUT", "/settings/file-name-template", { template: "{species}_{original}" });
    const kept = (
      await db.query<{ capture_id: string; ref: string }>(
        `SELECT capture_id, ref FROM originals WHERE ref LIKE '%IMG_0100.jpg'`,
      )
    ).rows[0];
    // Something already sits where the rename would go.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path.join(path.dirname(kept.ref), "Test Osprey_IMG_0100.jpg"), "not ours");

    const res = await call("POST", "/settings/reorganize-originals");
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().failed).toBe(0);
    const renamed = (await refs(kept.capture_id))[0].ref;
    expect(path.basename(renamed)).toBe("Test Osprey_IMG_0100-2.jpg");
    expect(existsSync(renamed)).toBe(true);
    expect(existsSync(kept.ref)).toBe(false);

    // A RAW and its photo keep one name: {original} is the camera's name, not the earlier rename.
    const pair = await db.query<{ ref: string }>(
      `SELECT ref FROM originals WHERE capture_id = (SELECT capture_id FROM originals WHERE ref LIKE '%IMG_0200.cr3') ORDER BY kind`,
    );
    expect(pair.rows.map((r) => path.basename(r.ref)).sort()).toEqual([
      "Test Osprey_IMG_0200.cr3",
      "Test Osprey_IMG_0200.jpg",
    ]);

    const again = (await call("POST", "/settings/reorganize-originals")).json();
    expect(again.moved).toBe(0);
    await call("PUT", "/settings/file-name-template", { template: "{original}" });
  });

  it("treats an eBird regional species as sensitive only where eBird lists it", async () => {
    const { sensitiveCapturesAmong } = await import("./metadataSettings.js");
    const GOLDENEYE = "dddddddd-0000-4000-8000-00000000018a";
    const [uk, england, canada, ontario] = [1, 2, 3, 4].map((n) => `dddddddd-0000-4000-8000-00000000019${n}`);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 917103, 'Bucephala clangula', 'Test Goldeneye', 'aves')`,
      [GOLDENEYE],
    );
    await db.query(
      `INSERT INTO regions (id, name, ebird_region_code, parent_id) VALUES
         ($1, 'United Kingdom', 'GB', NULL), ($2, 'England', 'GB-ENG', $1),
         ($3, 'Canada', 'CA', NULL), ($4, 'Ontario', 'CA-ON', $3)`,
      [uk, england, canada, ontario],
    );
    try {
      const at = (region_id: string | null, n: number) => ({ capture_id: `c${n}`, species_id: GOLDENEYE, region_id });
      const photos = [at(england, 1), at(ontario, 2), at(canada, 3), at(uk, 4), at(null, 5)];
      expect([...(await sensitiveCapturesAmong(USER, photos))].sort()).toEqual(["c1", "c4", "c5"]);
      // Marking it ordinary beats the list; marking it sensitive again restores the list.
      await call("DELETE", `/settings/sensitive-species/${GOLDENEYE}`);
      expect((await sensitiveCapturesAmong(USER, photos)).size).toBe(0);
      const listed = (await call("GET", "/settings/sensitive-species/list")).json().species;
      expect(listed.find((x: { id: string }) => x.id === GOLDENEYE)).toMatchObject({
        removed: true,
        areas: ["England-GB"],
      });
      await call("PUT", `/settings/sensitive-species/${GOLDENEYE}`);
      expect([...(await sensitiveCapturesAmong(USER, photos))].sort()).toEqual(["c1", "c4", "c5"]);
    } finally {
      await call("DELETE", `/settings/sensitive-species/${GOLDENEYE}`);
      await db.query(`DELETE FROM install_settings WHERE key = ANY($1)`, [
        KEYS.filter((k) => k.startsWith("sensitive")),
      ]);
      await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[england, ontario, uk, canada]]);
      await db.query(`DELETE FROM species WHERE id = $1`, [GOLDENEYE]);
    }
  });

  it("keeps sensitive species' locations out of exports only when asked, and out of share links", async () => {
    const rare = await upload("IMG_0300.jpg", "2026:05:04 08:00:00", RARE);
    const plain = await upload("IMG_0301.jpg", "2026:05:04 09:00:00");
    const rareFile = (await refs(rare))[0].ref;
    await et.write(
      rareFile,
      { GPSLatitude: 53.1, GPSLongitude: -114.2, GPSLatitudeRef: "N", GPSLongitudeRef: "W" } as never,
      ["-overwrite_original"],
    );
    const album = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Owls') RETURNING id`, [USER])
    ).rows[0].id;
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2), ($1, $3)`, [album, rare, plain]);

    const exportTo = async (hide?: boolean) => {
      const dest = mkdtempSync(path.join(exportRoot, "out-"));
      const res = await call("POST", `/albums/${album}/export`, {
        destination: dest,
        include: { raw: false, sidecars: false },
        structure: "flat",
        ...(hide === undefined ? {} : { hideSensitiveLocations: hide }),
      });
      expect(res.statusCode, res.body).toBe(200);
      const { albumExportJob } = await import("../albums/export.js");
      await albumExportJob.settled();
      expect(albumExportJob.status.error).toBeNull();
      return dest;
    };
    // Off by default: an export is often for the user's own use.
    let dest = await exportTo();
    expect((await tags(path.join(dest, "IMG_0300.jpg"))).GPSLatitude).toBeDefined();

    dest = await exportTo(true);
    expect(readdirSync(dest).sort()).toEqual(["IMG_0300.jpg", "IMG_0301.jpg"]);
    const stripped = await tags(path.join(dest, "IMG_0300.jpg"));
    expect(stripped.GPSLatitude).toBeUndefined();
    expect(stripped.Location).toBeUndefined();
    expect(stripped.State).toBe("Test Province");
    expect(stripped.Description).toBe("Rare Test Owl (Strix rarissima), Test Province, 2026-05-04");
    expect((await tags(path.join(dest, "IMG_0301.jpg"))).Location).toBe("Pigeon Lake");
    // The library's own file is untouched.
    expect((await tags(rareFile)).GPSLatitude).toBeDefined();

    // A link shows no location at all until its owner turns locations on.
    const share = (await call("POST", `/albums/${album}/shares`, { showMetadata: true })).json();
    expect(share.showExactLocations).toBe(false);
    const page = async () =>
      new Map(
        (await app.inject({ method: "GET", url: `/api/share/${share.token}` }))
          .json()
          .items.map((i: { captureId: string }) => [i.captureId, i]),
      );
    expect([...(await page()).values()].every((i) => !("location" in (i as object)))).toBe(true);

    expect((await call("PUT", `/shares/${share.id}/exact-locations`, { enabled: true })).statusCode).toBe(200);
    expect((await call("GET", `/albums/${album}/shares`)).json().shares[0].showExactLocations).toBe(true);
    let items = await page();
    expect(items.get(rare)).toMatchObject({ location: { place: null, region: "Test Province", country: "Testland" } });
    expect(items.get(plain)).toMatchObject({ location: { place: "Pigeon Lake", region: "Test Province" } });
    expect(JSON.stringify([...items.values()])).not.toMatch(/"lat"|"lon"|53\.1/);

    // The user's own list decides: off for this species, then off altogether.
    expect((await call("GET", "/settings/sensitive-species/list")).json().species).toEqual([
      expect.objectContaining({ id: RARE, reason: "iucn", iucnStatus: "EN" }),
    ]);
    await call("DELETE", `/settings/sensitive-species/${RARE}`);
    expect((await call("GET", "/settings/sensitive-species/list")).json().species).toEqual([
      expect.objectContaining({ id: RARE, removed: true }),
    ]);
    items = await page();
    expect(items.get(rare)).toMatchObject({ location: { place: "Pigeon Lake" } });
    await call("PUT", `/settings/sensitive-species/${RARE}`);
    expect((await page()).get(rare)).toMatchObject({ location: { place: null } });
    expect((await call("GET", "/settings/sensitive-species/list")).json().species).toEqual([
      expect.objectContaining({ id: RARE, reason: "iucn", removed: false }),
    ]);
    await call("PUT", "/settings/sensitive-species", { enabled: false });
    expect((await page()).get(rare)).toMatchObject({ location: { place: "Pigeon Lake" } });
    await call("PUT", "/settings/sensitive-species", { enabled: true });

    // A link can be made with locations on from the start.
    const located = (await call("POST", `/albums/${album}/shares`, { showExactLocations: true })).json();
    expect(located.showExactLocations).toBe(true);
    const visit = (await app.inject({ method: "GET", url: `/api/share/${located.token}` })).json();
    expect(visit.items.every((i: { location?: unknown }) => i.location != null)).toBe(true);
    expect(
      (await call("PUT", `/shares/eeeeeeee-0000-4000-8000-0000000001ff/exact-locations`, { enabled: true })).statusCode,
    ).toBe(404);
  });
});
