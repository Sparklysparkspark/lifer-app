// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// What a connected app with only imports.write can do: look up species ids by scientific name,
// upload a RAW with its XMP sidecar, and verify the stored bytes by sha256.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import pg from "pg";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setTiffPhotometric } from "@lifer/core/uploads/testImages.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000841";
const READER = "eeeeeeee-0000-4000-8000-000000000842";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000084a";
const OTHER_SPECIES = "eeeeeeee-0000-4000-8000-00000000084b";
const PLUGIN = "com.example.imports-api";

const XMP = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:xmpDM="http://ns.adobe.com/xmp/1.0/DynamicMedia/"
 xmlns:dc="http://purl.org/dc/elements/1.1/" xmp:Rating="4" xmp:Label="Red" xmpDM:pick="1">
<dc:subject><rdf:Bag><rdf:li>Testus importensis</rdf:li></rdf:Bag></dc:subject>
</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;

describe.skipIf(!url)("imports API for connected apps", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let key: string;
  let readKey: string;

  const headers = (k: string) => ({ "x-api-key": k, "x-lifer-client": "1" });

  async function upload(fields: Record<string, string>, files: { field: string; name: string; bytes: Buffer }[]) {
    const form = new FormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    for (const f of files) form.append(f.field, new Blob([new Uint8Array(f.bytes)]), f.name);
    const res = new Response(form);
    return app.inject({
      method: "POST",
      url: "/api/uploads",
      payload: Buffer.from(await res.arrayBuffer()),
      headers: { ...headers(key), "content-type": res.headers.get("content-type")! },
    });
  }

  async function cleanup() {
    for (const u of [USER, READER]) {
      await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM originals WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [u]);
      await db.query(`DELETE FROM users WHERE id = $1`, [u]);
    }
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, OTHER_SPECIES]]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-imports-api-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'imports-api@test', 'x'), ($2, 'imports-api-r@test', 'x')`,
      [USER, READER],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910841, 'Testus importensis', 'Import Test Warbler', 'aves'),
              ($2, 910842, 'Testus ambiguus', 'Ambiguous Warbler', 'aves')`,
      [SPECIES, OTHER_SPECIES],
    );
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Oldus importensis')`, [
      SPECIES,
    ]);
    const { issuePluginKey } = await import("../plugins/pairing.js");
    key = await issuePluginKey(USER, PLUGIN, "Importer", ["imports.write"]);
    readKey = await issuePluginKey(READER, `${PLUGIN}.read`, "Reader", ["userdata.read"]);
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db?.end();
    const { closeExiftool } = await import("./exif.js");
    await closeExiftool();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("looks up exact and synonym names, and nothing else", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/imports/v1/species-lookup",
      headers: headers(key),
      payload: { scientificNames: ["testus IMPORTENSIS", "Oldus importensis", "Nothing here"] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({
      matches: [
        { name: "testus IMPORTENSIS", speciesId: SPECIES, scientificName: "Testus importensis", match: "exact" },
        { name: "Oldus importensis", speciesId: SPECIES, scientificName: "Testus importensis", match: "synonym" },
      ],
      unmatched: ["Nothing here"],
    });
  });

  it("refuses the lookup to a key without imports.write and bad bodies", async () => {
    const call = (k: string, payload: object) =>
      app.inject({ method: "POST", url: "/api/imports/v1/species-lookup", headers: headers(k), payload });
    expect((await call(readKey, { scientificNames: ["x"] })).statusCode).toBe(401);
    expect((await call(key, { scientificNames: [] })).statusCode).toBe(400);
  });

  it("returns the stored file's sha256 and applies a sidecar sent with a RAW", async () => {
    const img = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 20, g: 90, b: 40 } } });
    const exif = { IFD0: { Make: "TestCam" }, IFD2: { DateTimeOriginal: "2024:05:01 10:00:00" } };
    // A sensor-data TIFF (Color Filter Array) counts as a RAW.
    const rawBytes = setTiffPhotometric(await img.tiff().withExif(exif).toBuffer(), 32803);
    const res = await upload({ speciesId: SPECIES, cullMarks: "hide" }, [
      { field: "file", name: "IMG_0841.dng", bytes: rawBytes },
      { field: "xmpFile", name: "IMG_0841.xmp", bytes: Buffer.from(XMP) },
    ]);
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().sha256).toBe(createHash("sha256").update(rawBytes).digest("hex"));
    const row = await db.query(`SELECT quality_rating, cull_verdict, cull_label FROM captures_all WHERE id = $1`, [
      res.json().captureId,
    ]);
    expect(row.rows[0]).toEqual({ quality_rating: 4, cull_verdict: "pick", cull_label: "red" });
  });

  it("returns the sha256 of a photo and of the RAW sent with it", async () => {
    const jpeg = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 90, b: 40 } } })
      .jpeg()
      .withExif({ IFD2: { DateTimeOriginal: "2024:05:02 10:00:00" } })
      .toBuffer();
    const rawBytes = setTiffPhotometric(
      await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 121, g: 90, b: 40 } } })
        .tiff()
        .withExif({ IFD2: { DateTimeOriginal: "2024:05:02 10:00:00" } })
        .toBuffer(),
      32803,
    );
    const res = await upload({ speciesId: SPECIES }, [
      { field: "file", name: "IMG_0842.jpg", bytes: jpeg },
      { field: "rawFile", name: "IMG_0842.dng", bytes: rawBytes },
      { field: "xmpFile", name: "IMG_0842.xmp", bytes: Buffer.from(XMP) },
    ]);
    expect(res.statusCode, res.body).toBe(201);
    const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(res.json().sha256).toBe(sha(jpeg));
    expect(res.json().rawSha256).toBe(sha(rawBytes));
    const row = await db.query(`SELECT quality_rating, cull_label FROM captures_all WHERE id = $1`, [
      res.json().captureId,
    ]);
    expect(row.rows[0]).toEqual({ quality_rating: 4, cull_label: "red" });
  });
});
