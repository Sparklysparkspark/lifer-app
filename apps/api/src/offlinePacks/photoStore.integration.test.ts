// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run photoStore
// The photo store end to end: built from a species' photos, served with byte ranges the way
// GitHub serves release files, and fetched by an install that doesn't have them.
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const appData = vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  const dir = `${process.env.TMPDIR ?? "/tmp"}/lifer-photo-store-test-${process.pid}`;
  process.env.APP_DATA_DIR = dir;
  return dir;
});

const url = process.env.TEST_DATABASE_URL;
const SPECIES = "ffffffff-0000-4000-8000-000000000620";
const REGION = "ffffffff-0000-4000-8000-0000000006a0";
const PHOTO_URL = "https://example.org/zzphoto-gallery.jpg";

describe.skipIf(!url)("photo store", () => {
  let db: pg.Pool;
  let work: string;
  let server: Server;
  let base: string;
  const bytes = { display: Buffer.from("display-bytes-" + "d".repeat(500)), thumb: Buffer.from("thumb-" + "t".repeat(90)), gallery: Buffer.from("gallery-" + "g".repeat(300)) };

  async function cleanup() {
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    work = mkdtempSync(path.join(os.tmpdir(), "lifer-photo-src-"));
    const files = { display: path.join(work, "d.webp"), thumb: path.join(work, "t.webp"), gallery: path.join(work, "g.webp") };
    writeFileSync(files.display, bytes.display);
    writeFileSync(files.thumb, bytes.thumb);
    writeFileSync(files.gallery, bytes.gallery);
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Zzphotoland')`, [REGION]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, reference_display_path, reference_thumb_path) VALUES ($1, 916100, 'Zzphotia store', 'aves', $2, $3)`,
      [SPECIES, files.display, files.thumb],
    );
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [REGION, SPECIES]);
    await db.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path) VALUES ($1, $2, 'x', 'cc-by', 0, $3)`,
      [SPECIES, PHOTO_URL, files.gallery],
    );
    // Serves the store with Range support, like GitHub's release downloads.
    server = createServer((req, res) => {
      const file = path.join(work, "store", decodeURIComponent(req.url!.slice(1)));
      if (!existsSync(file)) return void res.writeHead(404).end();
      const data = readFileSync(file);
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      if (!m) return void res.writeHead(200).end(data);
      res.writeHead(206, { "Content-Range": `bytes ${m[1]}-${m[2]}/${data.length}` }).end(data.subarray(Number(m[1]), Number(m[2]) + 1));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as { port: number };
    base = `http://127.0.0.1:${addr.port}/`;
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
    server?.close();
    rmSync(work, { recursive: true, force: true });
    rmSync(appData, { recursive: true, force: true });
  });

  it("builds the store, then fetches only what an install is missing", async () => {
    const { buildPhotoStore, readPhotoStoreIndex } = await import("data-pipeline/src/pipeline/photoStore.js");
    const built = await buildPhotoStore({ outDir: path.join(work, "store"), previous: null, log: () => {} });
    const stored = readPhotoStoreIndex(built.indexPath);
    expect(stored.species[SPECIES]?.d).toBeDefined();
    expect(stored.species[SPECIES]?.g?.[PHOTO_URL]?.d).toBeDefined();

    // An install without the files: paths unset, as a fresh one has.
    await db.query(`UPDATE species SET reference_display_path = NULL, reference_thumb_path = NULL WHERE id = $1`, [SPECIES]);
    await db.query(`UPDATE species_reference_photos SET display_path = NULL WHERE species_id = $1`, [SPECIES]);

    const { fetchPhotoStoreIndex, missingPhotos, downloadPhotos } = await import("./photoStore.js");
    const indexUrl = `${base}lifer-photo-store.json.gz`;
    const index = await fetchPhotoStoreIndex(indexUrl, { fresh: true });
    const small = await missingPhotos(db, index, [SPECIES], false);
    expect(small).toHaveLength(2); // display and thumb, no gallery
    const needs = await missingPhotos(db, index, [SPECIES], true);
    expect(needs).toHaveLength(3);

    const result = await downloadPhotos(db, indexUrl, index, needs);
    expect(result).toMatchObject({ saved: 3, failed: 0 });
    const row = (await db.query(`SELECT reference_display_path, reference_thumb_path FROM species WHERE id = $1`, [SPECIES])).rows[0];
    expect(readFileSync(row.reference_display_path)).toEqual(bytes.display);
    expect(readFileSync(row.reference_thumb_path)).toEqual(bytes.thumb);
    const g = (await db.query(`SELECT display_path FROM species_reference_photos WHERE species_id = $1`, [SPECIES])).rows[0];
    expect(readFileSync(g.display_path)).toEqual(bytes.gallery);
    expect(await missingPhotos(db, index, [SPECIES], true)).toHaveLength(0);

    // A second build on top of the first reuses every photo: nothing new to write or upload.
    const again = await buildPhotoStore({ outDir: path.join(work, "store2"), previous: stored, log: () => {} });
    expect(again.newShards).toHaveLength(0);
    expect(again.reused).toBe(3);
  });
});
