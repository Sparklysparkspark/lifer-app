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
import { applyGalleryEmbeddingsFile, ID_GALLERY } from "./galleryEmbeddingsAsset.js";

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

  it("can merge just the regions first, then the rest, recording the version only at the end", async () => {
    const file = seedFile([[SPECIES, "1", "Ardea herodias", "Aves", "\\N", "x"]]);
    const first = await applyCatalogSeedFile(pool, file, 42, noProgress, ["regions"]);
    expect(first).toEqual({ regions: 2 });
    const child = await pool.query(`SELECT parent_id FROM regions WHERE id = $1`, [CHILD]);
    expect(child.rows[0].parent_id).toBe(PARENT);
    expect((await pool.query(`SELECT 1 FROM species WHERE id = $1`, [SPECIES])).rowCount).toBe(0);
    expect(await getAppliedCatalogVersion(pool)).toBeNull();

    const full = await applyCatalogSeedFile(pool, file, 42, noProgress);
    expect(full.species).toBe(1);
    expect(full.regions).toBe(2);
    const regions = await pool.query(`SELECT count(*)::int AS n FROM regions WHERE id IN ($1, $2)`, [CHILD, PARENT]);
    expect(regions.rows[0].n).toBe(2);
    expect(await getAppliedCatalogVersion(pool)).toBe(42);
  });

  it("removes blocklisted photos and drops the cached file of a changed main photo", async () => {
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, reference_photo, reference_credit, reference_license, reference_display_path)
       VALUES ($1, 1, 'Aix galericulata', 'Aves', 'https://example.org/old-map.png', 'c', 'cc-by', '/local/old.webp')`,
      [SPECIES],
    );
    await pool.query(
      `INSERT INTO species_reference_photos (id, species_id, photo_url, credit, license) VALUES ($1, $2, 'https://example.org/map.png', 'c', 'cc-by')`,
      [LOCAL_PHOTO, SPECIES],
    );
    const dump = [
      "COPY public.species (id, gbif_key, scientific_name, taxon_class, reference_photo, reference_credit, reference_license) FROM stdin;",
      `${SPECIES}	1	Aix galericulata	Aves	https://example.org/new.jpg	Someone	cc-by`,
      "\\.",
      "",
      "COPY public.reference_photo_blocklist (photo_url, reason) FROM stdin;",
      "https://example.org/map.png\tmap",
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    try {
      const merged = await applyCatalogSeedFile(pool, file, null, noProgress);
      expect(merged.blockedPhotosRemoved).toBe(1);
      const sp = await pool.query(`SELECT reference_photo, reference_display_path FROM species WHERE id = $1`, [SPECIES]);
      expect(sp.rows[0]).toEqual({ reference_photo: "https://example.org/new.jpg", reference_display_path: null });
      expect((await pool.query(`SELECT 1 FROM species_reference_photos WHERE id = $1`, [LOCAL_PHOTO])).rowCount).toBe(0);
    } finally {
      await pool.query(`DELETE FROM reference_photo_blocklist WHERE photo_url = 'https://example.org/map.png'`);
    }
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

  it("matches an existing region by name+parent when the seed uses a different id for it, and remaps region_species to the local id", async () => {
    // Real bug, confirmed live: a region's canonical id can change upstream (this project has a
    // whole migration, 004_dedupe_regions.sql, for exactly this kind of cleanup). An install that
    // last synced before such a change has the existing row under the OLD id; the seed now
    // publishes it under a NEW id. Naive insert-by-id sees no id match and tries to insert a
    // second row, colliding on (name, parent_id) with the one that's already there.
    const OLD_GEORGIA = "77777777-7777-4777-8777-777777777701";
    const SEED_GEORGIA = "77777777-7777-4777-8777-777777777702";
    const OTHER_SPECIES = "77777777-7777-4777-8777-777777777703";
    await client_cleanup();
    async function client_cleanup() {
      await pool.query(`DELETE FROM region_species WHERE region_id = ANY($1)`, [[OLD_GEORGIA, SEED_GEORGIA]]);
      await pool.query(`DELETE FROM regions WHERE id = ANY($1)`, [[OLD_GEORGIA, SEED_GEORGIA]]);
      await pool.query(`DELETE FROM species WHERE id = $1`, [OTHER_SPECIES]);
    }
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 999, 'Testus otherus', 'Aves')`,
      [OTHER_SPECIES],
    );
    // The existing local row, under the OLD id, with real region_species data already attached.
    await pool.query(`INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Georgia', NULL)`, [OLD_GEORGIA]);
    await pool.query(`INSERT INTO region_species (region_id, species_id, local_tier) VALUES ($1, $2, 'common')`, [OLD_GEORGIA, OTHER_SPECIES]);

    const dump = [
      "COPY public.regions (id, name, parent_id) FROM stdin;",
      `${SEED_GEORGIA}\tGeorgia\t\\N`,
      "\\.",
      "",
      "COPY public.region_species (region_id, species_id, is_vagrant, is_invasive) FROM stdin;",
      `${SEED_GEORGIA}\t${OTHER_SPECIES}\tf\tf`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-region-remap-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));

    await expect(applyCatalogSeedFile(pool, file, null, noProgress)).resolves.toBeTruthy();

    // Still exactly one Georgia, under its original (old) id -- nothing new was inserted.
    const regions = await pool.query(`SELECT id FROM regions WHERE name = 'Georgia'`);
    expect(regions.rows).toEqual([{ id: OLD_GEORGIA }]);

    // The seed's region_species row (naming the NEW id) followed the remap onto the OLD, real id.
    const rs = await pool.query(`SELECT region_id FROM region_species WHERE species_id = $1`, [OTHER_SPECIES]);
    expect(rs.rows).toEqual([{ region_id: OLD_GEORGIA }]);

    await client_cleanup();
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

  it("applies the identification model's gallery asset into its own table only", async () => {
    await pool.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 1, 'Ardea herodias', 'Aves')`, [SPECIES]);
    await pool.query(
      `INSERT INTO species_reference_photos (id, species_id, photo_url, credit, license) VALUES ($1, $2, 'https://example.org/heron.jpg', 'c', 'cc-by')`,
      [LOCAL_PHOTO, SPECIES],
    );
    const bin = Buffer.concat([
      encodeGalleryEmbeddingsHeader({ dimension: 4, rowCount: 1, modelVersion: "bioclip-2-v1" }),
      encodeGalleryEmbeddingRecord({ speciesId: SPECIES, photoUrl: "https://example.org/heron.jpg", embedding: [0.25, 0.25, 0.25, 0.25] }, 4),
    ]);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-ge-test-")), "id-ge.bin.gz");
    writeFileSync(file, gzipSync(bin));

    const result = await applyGalleryEmbeddingsFile(pool, file, "1:bioclip-2-v1", { ...noProgress, signal: new AbortController().signal }, ID_GALLERY);
    expect(result).toEqual({ status: "applied", rows: 1, matched: 1 });
    const id = await pool.query(`SELECT reference_photo_id, model_version FROM id_model_gallery_embeddings WHERE species_id = $1`, [SPECIES]);
    expect(id.rows).toEqual([{ reference_photo_id: LOCAL_PHOTO, model_version: "bioclip-2-v1" }]);
    const clip = await pool.query(`SELECT 1 FROM species_reference_gallery_embeddings WHERE species_id = $1`, [SPECIES]);
    expect(clip.rowCount).toBe(0);
    const tag = await pool.query(`SELECT value FROM install_settings WHERE key = 'id_gallery_embeddings_version'`);
    expect(tag.rows[0]?.value).toBe("1:bioclip-2-v1");
    await pool.query(`DELETE FROM install_settings WHERE key = 'id_gallery_embeddings_version'`);
  });
});
