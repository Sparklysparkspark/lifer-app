// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Reads fixture catalogues built here with the tables and columns Lightroom Classic 12 and 13 share.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000921";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000922";

const SCHEMA = `
  CREATE TABLE AgLibraryRootFolder (id_local INTEGER PRIMARY KEY, absolutePath TEXT, name TEXT);
  CREATE TABLE AgLibraryFolder (id_local INTEGER PRIMARY KEY, pathFromRoot TEXT, rootFolder INTEGER);
  CREATE TABLE AgLibraryFile (id_local INTEGER PRIMARY KEY, baseName TEXT, extension TEXT, folder INTEGER);
  CREATE TABLE Adobe_images (id_local INTEGER PRIMARY KEY, rating REAL, pick REAL, colorLabels TEXT,
    captureTime TEXT, rootFile INTEGER, masterImage INTEGER);
  CREATE TABLE AgHarvestedExifMetadata (id_local INTEGER PRIMARY KEY, image INTEGER, gpsLatitude REAL, gpsLongitude REAL);
  CREATE TABLE AgLibraryIPTC (id_local INTEGER PRIMARY KEY, image INTEGER, caption TEXT);
  CREATE TABLE AgLibraryKeyword (id_local INTEGER PRIMARY KEY, name TEXT, parent INTEGER);
  CREATE TABLE AgLibraryKeywordImage (id_local INTEGER PRIMARY KEY, image INTEGER, tag INTEGER);
  CREATE TABLE AgLibraryCollection (id_local INTEGER PRIMARY KEY, name TEXT, parent INTEGER, creationId TEXT);
  CREATE TABLE AgLibraryCollectionContent (id_local INTEGER PRIMARY KEY, collection INTEGER, content TEXT, owningModule TEXT);
  CREATE TABLE AgLibraryCollectionImage (id_local INTEGER PRIMARY KEY, collection INTEGER, image INTEGER);
`;

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

describe.skipIf(!url)("readCatalog", () => {
  let db: pg.Pool;
  let dir: string;
  let readCatalog: typeof import("./catalog.js").readCatalog;
  let capture1: string;
  let capture2: string;

  function build(file: string, extra?: (lr: DatabaseSync) => void) {
    const lr = new DatabaseSync(file);
    lr.exec(SCHEMA);
    lr.exec(`
      INSERT INTO AgLibraryRootFolder VALUES (1, '/photos/', 'photos');
      INSERT INTO AgLibraryFolder VALUES (1, '2024/pond/', 1);
      INSERT INTO AgLibraryFile VALUES (1, 'IMG_0001', 'CR3', 1), (2, 'IMG_0002', 'CR3', 1), (3, 'IMG_0003', 'CR3', 1), (4, 'IMG_0004', 'CR3', 1);
      INSERT INTO Adobe_images VALUES
        (1, 5, 1, 'Red', '2024-05-01T10:20:30', 1, NULL),
        (2, 0, -1, '', '2024-05-01T10:21:00', 2, NULL),
        (3, NULL, 0, NULL, '2024-05-02T09:00:00', 3, NULL),
        (4, 3, 0, NULL, '2024-05-03T09:00:00', 1, 1);
      INSERT INTO AgHarvestedExifMetadata VALUES (1, 1, 49.1, -123.1);
      INSERT INTO AgLibraryIPTC VALUES (1, 1, 'Great blue heron at dawn');
      INSERT INTO AgLibraryKeyword VALUES (1, 'Birds', NULL), (2, 'Herons', 1), (3, 'Great Blue Heron', 2);
      INSERT INTO AgLibraryKeywordImage VALUES (1, 1, 3), (2, 2, 1);
      INSERT INTO AgLibraryCollection VALUES
        (1, 'Trips', NULL, 'com.adobe.ag.library.group'),
        (2, 'Pond', 1, 'com.adobe.ag.library.collection'),
        (3, 'Good ones', 1, 'com.adobe.ag.library.smart_collection'),
        (4, 'Any camera', NULL, 'com.adobe.ag.library.smart_collection');
      INSERT INTO AgLibraryCollectionContent VALUES
        (1, 3, 's = { combine = "intersect", rules = { { criteria = "rating", operation = ">=", value = 4 } } }', 'ag.library.smart_collection'),
        (2, 4, 's = { combine = "intersect", rules = { { criteria = "camera", operation = "any", value = "R5" } } }', 'ag.library.smart_collection');
      INSERT INTO AgLibraryCollectionImage VALUES (1, 2, 1), (2, 2, 2), (3, 2, 3);
    `);
    extra?.(lr);
    lr.close();
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    dir = mkdtempSync(path.join(tmpdir(), "lifer-lrcat-test-"));
    db = new pg.Pool({ connectionString: url });
    ({ readCatalog } = await import("./catalog.js"));
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'lrcat@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915921, 'Lrcatia alba', 'Cat Heron', 'aves')`,
      [SPECIES],
    );
    const insert = async (fp: string, ref: string, takenAt: string, rating: number | null) => {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [USER, SPECIES, fp, takenAt, rating],
      );
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, 'raw', 'path', $3, false, $3, 1)`,
        [USER, c.rows[0].id, ref],
      );
      return c.rows[0].id;
    };
    // Same path as Lightroom's (different letter case), and the same file moved to another folder.
    capture1 = await insert("lr-1", "/Photos/2024/pond/img_0001.cr3", "2024-05-01T10:20:30Z", 2);
    capture2 = await insert("lr-2", "/elsewhere/IMG_0002.CR3", "2024-05-01T10:21:00Z", null);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("reads photos, matches them by path and by name, and maps collections", async () => {
    const file = path.join(dir, "a.lrcat");
    build(file);
    const set = await readCatalog(file, USER);
    expect(set.total).toBe(3); // the virtual copy is left out
    const [p1, p2, p3] = set.photos;
    expect(p1).toMatchObject({
      captureId: capture1,
      rating: 5,
      flag: "pick",
      label: "Red",
      caption: "Great blue heron at dawn",
      lat: 49.1,
      lon: -123.1,
      keywords: ["Great Blue Heron"],
      keywordPaths: ["Birds > Herons > Great Blue Heron"],
      current: { rating: 2 },
    });
    expect(p2).toMatchObject({ captureId: capture2, rating: null, flag: "reject", keywords: ["Birds"] });
    expect(p3).toMatchObject({ captureId: null, current: null, rating: null, flag: null });
    expect(set.notInLifer).toEqual([path.normalize("/photos/2024/pond/IMG_0003.CR3")]);
    expect(set.albums).toEqual([
      { name: "Pond", path: ["Trips"], captureIds: [capture1, capture2], missing: 1, rules: null },
      {
        name: "Good ones",
        path: ["Trips"],
        captureIds: [],
        missing: 0,
        rules: { version: 2, query: { ratingMin: "4" } },
      },
    ]);
    expect(set.unmapped).toEqual([
      { kind: "smartCollection", name: "Any camera", reason: expect.stringMatching(/camera/) },
    ]);
  });

  it("never changes the catalogue, even one Lightroom has open", async () => {
    const file = path.join(dir, "locked.lrcat");
    build(file);
    writeFileSync(`${file}-lock`, "");
    const before = { hash: sha(file), mtime: statSync(file).mtimeMs };
    await readCatalog(file, USER);
    expect({ hash: sha(file), mtime: statSync(file).mtimeMs }).toEqual(before);
  });

  it("reads a 100,000-photo catalogue well inside a minute", async () => {
    const file = path.join(dir, "big.lrcat");
    build(file, (lr) => {
      lr.exec("BEGIN");
      const file = lr.prepare("INSERT INTO AgLibraryFile VALUES (?, ?, 'CR3', 1)");
      const image = lr.prepare("INSERT INTO Adobe_images VALUES (?, 3, 0, NULL, '2024-06-01T10:00:00', ?, NULL)");
      for (let i = 10; i < 100_010; i++) {
        file.run(i, `BIG_${i}`);
        image.run(i, i);
      }
      lr.exec("COMMIT");
    });
    const started = Date.now();
    const set = await readCatalog(file, USER);
    expect(set.total).toBe(100_003);
    expect(Date.now() - started).toBeLessThan(60_000);
  }, 120_000);
});
