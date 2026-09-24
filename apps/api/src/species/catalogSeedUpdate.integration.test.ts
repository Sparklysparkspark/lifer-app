// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run catalogSeedUpdate.integration
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JobCancelledError } from "../lib/job.js";
import { encodeGalleryEmbeddingRecord, encodeGalleryEmbeddingsHeader } from "@lifer/shared/src/galleryEmbeddingsFormat.js";
import { applyCatalogSeedFile, getAppliedCatalogVersion } from "./catalogSeedUpdate.js";
import { applyGalleryEmbeddingsFile } from "./galleryEmbeddingsAsset.js";

const url = process.env.TEST_DATABASE_URL;
const SPECIES = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const SEED_PHOTO = "44444444-4444-4444-8444-444444444444";
const LOCAL_PHOTO = "55555555-5555-4555-8555-555555555555";

function seedFile(species: string[][]): string {
  const vec = `{${Array.from({ length: 4 }, (_, i) => (i + 1) / 10).join(",")}}`;
  const dump = [
    "--",
    "-- PostgreSQL database dump",
    "SET statement_timeout = 0;",
    // Unknown table: must be skipped.
    "COPY public.not_a_catalog_table (a, b) FROM stdin;",
    "x\ty",
    "\\.",
    "",
    // Extra column (from a newer schema): must be ignored.
    "COPY public.species (id, gbif_key, scientific_name, taxon_class, reference_display_path, future_column) FROM stdin;",
    ...species.map((r) => r.join("\t")),
    "\\.",
    "",
    // Child listed before its parent.
    "COPY public.regions (id, name, parent_id) FROM stdin;",
    `${CHILD}\tChild Province\t${PARENT}`,
    `${PARENT}\tParent Country\t\\N`,
    "\\.",
    "",
    "COPY public.species_reference_photos (id, species_id, photo_url, credit, license, display_path) FROM stdin;",
    `${SEED_PHOTO}\t${SPECIES}\thttps://example.org/heron.jpg\tSomeone\tcc-by\t\\N`,
    "\\.",
    "",
    "COPY public.species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version) FROM stdin;",
    `${SEED_PHOTO}\t${SPECIES}\t${vec}\ttest-model`,
    "\\.",
    "",
  ].join("\n");
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-"));
  const file = path.join(dir, "seed.sql.gz");
  writeFileSync(file, gzipSync(dump));
  return file;
}

const noProgress = { update: () => {}, throwIfCancelled: () => {} };

describe.skipIf(!url)("applyCatalogSeedFile (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  beforeEach(async () => {
    await pool.query(`DELETE FROM species_reference_gallery_embeddings WHERE species_id = $1`, [SPECIES]);
    await pool.query(`DELETE FROM species_reference_photos WHERE species_id = $1`, [SPECIES]);
    await pool.query(`DELETE FROM regions WHERE id IN ($1, $2)`, [CHILD, PARENT]);
    await pool.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await pool.query(`DELETE FROM install_settings WHERE key = 'catalog_seed_version'`);
  });

  it("merges, keeps local paths and ids, remaps legacy gallery embeddings, records the version", async () => {
    // This install already has the species with a downloaded local photo path, and the same
    // gallery photo under its own local id.
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, reference_display_path) VALUES ($1, 1, 'Old name', 'Aves', '/local/heron.webp')`,
      [SPECIES],
    );
    await pool.query(
      `INSERT INTO species_reference_photos (id, species_id, photo_url, credit, license, display_path) VALUES ($1, $2, 'https://example.org/heron.jpg', 'old', 'cc-by', '/local/p.webp')`,
      [LOCAL_PHOTO, SPECIES],
    );

    const file = seedFile([[SPECIES, "1", "Ardea herodias", "Aves", "\\N", "ignored"]]);
    const merged = await applyCatalogSeedFile(pool, file, 42, noProgress);
    expect(merged.species).toBe(1);

    const sp = await pool.query(`SELECT scientific_name, reference_display_path FROM species WHERE id = $1`, [SPECIES]);
    expect(sp.rows[0]).toEqual({ scientific_name: "Ardea herodias", reference_display_path: "/local/heron.webp" });

    const child = await pool.query(`SELECT parent_id FROM regions WHERE id = $1`, [CHILD]);
    expect(child.rows[0].parent_id).toBe(PARENT);

    const photo = await pool.query(`SELECT id, credit, display_path FROM species_reference_photos WHERE species_id = $1`, [SPECIES]);
    expect(photo.rows).toEqual([{ id: LOCAL_PHOTO, credit: "Someone", display_path: "/local/p.webp" }]);

    const ge = await pool.query(`SELECT reference_photo_id FROM species_reference_gallery_embeddings WHERE species_id = $1`, [SPECIES]);
    expect(ge.rows).toEqual([{ reference_photo_id: LOCAL_PHOTO }]);

    expect(await getAppliedCatalogVersion(pool)).toBe(42);
  });

  it("rolls everything back when cancelled mid-apply", async () => {
    const file = seedFile([[SPECIES, "1", "Ardea herodias", "Aves", "\\N", "x"]]);
    let calls = 0;
    const cancelling = {
      update: (p: { phase?: string | null }) => {
        if (p.phase === "merging") calls++;
      },
      throwIfCancelled: () => {
        if (calls > 0) throw new JobCancelledError();
      },
    };
    await expect(applyCatalogSeedFile(pool, file, 43, cancelling)).rejects.toBeInstanceOf(JobCancelledError);
    const sp = await pool.query(`SELECT 1 FROM species WHERE id = $1`, [SPECIES]);
    expect(sp.rowCount).toBe(0);
    expect(await getAppliedCatalogVersion(pool)).toBeNull();
  });

  it("inserts two new same-named regions under different parents without a unique-constraint error", async () => {
    // Regression test for a real bug: forcing parent_id NULL during insert (the old approach)
    // transiently collided with regions' UNIQUE(name, parent_id) constraint whenever two
    // brand-new regions shared a name, even though their real final parents differed.
    const CONTINENT = "66666666-6666-4666-8666-666666666601";
    const COUNTRY_A = "66666666-6666-4666-8666-666666666602";
    const COUNTRY_B = "66666666-6666-4666-8666-666666666603";
    const PROV_A = "66666666-6666-4666-8666-666666666604";
    const PROV_B = "66666666-6666-4666-8666-666666666605";
    await pool.query(`DELETE FROM regions WHERE id = ANY($1)`, [[CONTINENT, COUNTRY_A, COUNTRY_B, PROV_A, PROV_B]]);

    const dump = [
      "COPY public.regions (id, name, parent_id) FROM stdin;",
      `${CONTINENT}	Continentia	\\N`,
      `${COUNTRY_A}	Country A	${CONTINENT}`,
      `${COUNTRY_B}	Country B	${CONTINENT}`,
      `${PROV_A}	Central	${COUNTRY_A}`,
      `${PROV_B}	Central	${COUNTRY_B}`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-regions-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));

    const merged = await applyCatalogSeedFile(pool, file, null, noProgress);
    expect(merged.regions).toBe(5);
    const rows = await pool.query(`SELECT name, parent_id FROM regions WHERE id = ANY($1) ORDER BY id`, [
      [CONTINENT, COUNTRY_A, COUNTRY_B, PROV_A, PROV_B],
    ]);
    expect(rows.rows).toEqual([
      { name: "Continentia", parent_id: null },
      { name: "Country A", parent_id: CONTINENT },
      { name: "Country B", parent_id: CONTINENT },
      { name: "Central", parent_id: COUNTRY_A },
      { name: "Central", parent_id: COUNTRY_B },
    ]);

    // Re-applying the same seed (an update, not a fresh install) must also stay clean.
    await expect(applyCatalogSeedFile(pool, file, null, noProgress)).resolves.toBeTruthy();
  });

  it("rolls back on bad data without leaving partial rows", async () => {
    const file = seedFile([
      [SPECIES, "1", "Ardea herodias", "Aves", "\\N", "x"],
      ["not-a-uuid", "2", "Bad", "Aves", "\\N", "x"],
    ]);
    await expect(applyCatalogSeedFile(pool, file, 44, noProgress)).rejects.toThrow();
    const sp = await pool.query(`SELECT 1 FROM species WHERE id = $1`, [SPECIES]);
    expect(sp.rowCount).toBe(0);
  });

  it("applies the binary gallery embeddings asset onto local photo ids", async () => {
    await pool.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 1, 'Ardea herodias', 'Aves')`, [SPECIES]);
    await pool.query(
      `INSERT INTO species_reference_photos (id, species_id, photo_url, credit, license) VALUES ($1, $2, 'https://example.org/heron.jpg', 'c', 'cc-by')`,
      [LOCAL_PHOTO, SPECIES],
    );
    const records = [
      { speciesId: SPECIES, photoUrl: "https://example.org/heron.jpg", embedding: [0.5, 0.5, 0.5, 0.5] },
      { speciesId: SPECIES, photoUrl: "https://example.org/not-on-this-install.jpg", embedding: [1, 0, 0, 0] },
    ];
    const bin = Buffer.concat([
      encodeGalleryEmbeddingsHeader({ dimension: 4, rowCount: 2, modelVersion: "test-model" }),
      ...records.map((r) => encodeGalleryEmbeddingRecord(r, 4)),
    ]);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-ge-test-")), "ge.bin.gz");
    writeFileSync(file, gzipSync(bin));

    const result = await applyGalleryEmbeddingsFile(pool, file, "1:test-model", { ...noProgress, signal: new AbortController().signal });
    expect(result).toEqual({ status: "applied", rows: 2, matched: 1 });
    const ge = await pool.query(
      `SELECT reference_photo_id, embedding, model_version FROM species_reference_gallery_embeddings WHERE species_id = $1`,
      [SPECIES],
    );
    expect(ge.rows).toEqual([{ reference_photo_id: LOCAL_PHOTO, embedding: [0.5, 0.5, 0.5, 0.5], model_version: "test-model" }]);
  });
});
