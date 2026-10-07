// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run catalogSeedUpdate.integration
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { JobCancelledError } from "../lib/job.js";
import {
  encodeGalleryEmbeddingRecord,
  encodeGalleryEmbeddingsHeader,
} from "@lifer/shared/src/galleryEmbeddingsFormat.js";
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

    const photo = await pool.query(
      `SELECT id, credit, display_path FROM species_reference_photos WHERE species_id = $1`,
      [SPECIES],
    );
    expect(photo.rows).toEqual([{ id: LOCAL_PHOTO, credit: "Someone", display_path: "/local/p.webp" }]);

    const ge = await pool.query(
      `SELECT reference_photo_id FROM species_reference_gallery_embeddings WHERE species_id = $1`,
      [SPECIES],
    );
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
      const sp = await pool.query(`SELECT reference_photo, reference_display_path FROM species WHERE id = $1`, [
        SPECIES,
      ]);
      expect(sp.rows[0]).toEqual({ reference_photo: "https://example.org/new.jpg", reference_display_path: null });
      expect((await pool.query(`SELECT 1 FROM species_reference_photos WHERE id = $1`, [LOCAL_PHOTO])).rowCount).toBe(
        0,
      );
    } finally {
      await pool.query(`DELETE FROM reference_photo_blocklist WHERE photo_url = 'https://example.org/map.png'`);
    }
  });

  it("keeps a photo the install fetched itself while the seed withholds it, and the install's own fetch stamp", async () => {
    const fetchedAt = "2026-09-01T00:00:00.000Z";
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, reference_photo, reference_credit, reference_license,
                            reference_display_path, reference_thumb_path, photo_withheld, photo_checked_at)
       VALUES ($1, 1, 'Aix galericulata', 'Aves', 'https://example.org/own.jpg', '(c) Someone', 'all-rights-reserved',
               '/local/own.webp', '/local/own-thumb.webp', true, $2)`,
      [SPECIES, fetchedAt],
    );
    const seed = (row: string) => {
      const dump = [
        "COPY public.species (id, gbif_key, scientific_name, taxon_class, reference_photo, reference_credit, reference_license, photo_withheld, photo_checked_at) FROM stdin;",
        row,
        "\\.",
        "",
      ].join("\n");
      const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-")), "seed.sql.gz");
      writeFileSync(file, gzipSync(dump));
      return file;
    };
    const read = async () =>
      (
        await pool.query(
          `SELECT scientific_name, reference_photo, reference_credit, reference_license, reference_display_path, photo_withheld, photo_checked_at
             FROM species WHERE id = $1`,
          [SPECIES],
        )
      ).rows[0];

    await applyCatalogSeedFile(
      pool,
      seed(`${SPECIES}\t1\tAix galericulata renamed\tAves\t\\N\t\\N\t\\N\tt\t\\N`),
      null,
      noProgress,
    );
    expect(await read()).toEqual({
      scientific_name: "Aix galericulata renamed",
      reference_photo: "https://example.org/own.jpg",
      reference_credit: "(c) Someone",
      reference_license: "all-rights-reserved",
      reference_display_path: "/local/own.webp",
      photo_withheld: true,
      photo_checked_at: new Date(fetchedAt),
    });

    // Once the catalog has a photo it may publish, that one wins as usual.
    await applyCatalogSeedFile(
      pool,
      seed(
        `${SPECIES}\t1\tAix galericulata\tAves\thttps://example.org/open.jpg\tOpen Photographer\tcc-by\tf\t2026-01-01 00:00:00+00`,
      ),
      null,
      noProgress,
    );
    expect(await read()).toEqual({
      scientific_name: "Aix galericulata",
      reference_photo: "https://example.org/open.jpg",
      reference_credit: "Open Photographer",
      reference_license: "cc-by",
      reference_display_path: null,
      photo_withheld: false,
      photo_checked_at: new Date(fetchedAt),
    });
  });

  it("applies a seed's species merges: the install's old entry and its collected state move to the survivor", async () => {
    const OLD = "66666666-6666-4666-8666-666666666666";
    const USER = "77777777-7777-4777-8777-777777777777";
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await pool.query(`DELETE FROM species WHERE id = $1`, [OLD]);
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'seedmerge@test', 'x')`, [USER]);
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 2, 'Oceanodroma melania', 'aves')`,
      [OLD],
    );
    await pool.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [USER, OLD]);
    const dump = [
      "COPY public.species (id, gbif_key, scientific_name, taxon_class) FROM stdin;",
      `${SPECIES}	1	Hydrobates melania	aves`,
      "\\.",
      "",
      "COPY public.species_merges (old_species_id, new_species_id, old_scientific_name, merged_at) FROM stdin;",
      `${OLD}	${SPECIES}	Oceanodroma melania	2026-09-27 00:00:00+00`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    try {
      const merged = await applyCatalogSeedFile(pool, file, null, noProgress);
      expect(merged.speciesMerged).toBe(1);
      expect((await pool.query(`SELECT 1 FROM species WHERE id = $1`, [OLD])).rowCount).toBe(0);
      const us = await pool.query(`SELECT species_id, state FROM user_species WHERE user_id = $1`, [USER]);
      expect(us.rows).toEqual([{ species_id: SPECIES, state: "collected" }]);
      const syn = await pool.query(
        `SELECT species_id FROM species_synonyms WHERE synonym_name = 'Oceanodroma melania'`,
      );
      expect(syn.rows).toEqual([{ species_id: SPECIES }]);
    } finally {
      await pool.query(`DELETE FROM species_merges WHERE old_species_id = $1`, [OLD]);
      await pool.query(`DELETE FROM species_synonyms WHERE synonym_name = 'Oceanodroma melania'`);
      await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    }
  });

  it("takes a synonym the seed renamed in place, keeping its id", async () => {
    const SYN = "88888888-8888-4888-8888-888888888888";
    await pool.query(
      `DELETE FROM species_synonyms WHERE id = $1 OR synonym_name IN ('Zzold synonym', 'Zznew synonym')`,
      [SYN],
    );
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 1, 'Hydrobates melania', 'aves') ON CONFLICT DO NOTHING`,
      [SPECIES],
    );
    await pool.query(`INSERT INTO species_synonyms (id, species_id, synonym_name) VALUES ($1, $2, 'Zzold synonym')`, [
      SYN,
      SPECIES,
    ]);
    const dump = [
      "COPY public.species (id, gbif_key, scientific_name, taxon_class) FROM stdin;",
      `${SPECIES}	1	Hydrobates melania	aves`,
      "\\.",
      "",
      "COPY public.species_synonyms (id, species_id, synonym_name) FROM stdin;",
      `${SYN}	${SPECIES}	Zznew synonym`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    try {
      await applyCatalogSeedFile(pool, file, null, noProgress);
      const rows = await pool.query(`SELECT synonym_name FROM species_synonyms WHERE id = $1`, [SYN]);
      expect(rows.rows).toEqual([{ synonym_name: "Zznew synonym" }]);
    } finally {
      await pool.query(`DELETE FROM species_synonyms WHERE id = $1`, [SYN]);
    }
  });

  it("rewrites a pre-129 seed's IUCN labels to codes instead of failing the CHECK and rolling back", async () => {
    const OTHER = "88888888-8888-4888-8888-888888888802";
    await pool.query(`DELETE FROM species WHERE id = $1`, [OTHER]);
    // An old seed: labels in species_traits, no iucn_source, and the dropped species.iucn_status.
    const dump = [
      "COPY public.species (id, gbif_key, scientific_name, taxon_class, iucn_status) FROM stdin;",
      `${SPECIES}\t1\tZzseed alpha\taves\t\\N`,
      `${OTHER}\t2\tZzseed beta\taves\tVulnerable`,
      "\\.",
      "",
      "COPY public.species_traits (species_id, iucn_status, source_attribution) FROM stdin;",
      `${SPECIES}\textinct_in_wild\tWikidata`,
      `${OTHER}\tleast concern\tWikidata`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    try {
      const merged = await applyCatalogSeedFile(pool, file, null, noProgress);
      expect(merged.species_traits).toBe(2);
      const rows = await pool.query(
        `SELECT species_id, iucn_status, iucn_source FROM species_traits WHERE species_id IN ($1, $2) ORDER BY iucn_status`,
        [SPECIES, OTHER],
      );
      expect(rows.rows).toEqual([
        { species_id: SPECIES, iucn_status: "EW", iucn_source: "wikidata" },
        { species_id: OTHER, iucn_status: "LC", iucn_source: "wikidata" },
      ]);
    } finally {
      await pool.query(`DELETE FROM species WHERE id = $1`, [OTHER]);
    }
  });

  it("takes a current seed's IUCN codes, Not Evaluated stamp and note as they are", async () => {
    const dump = [
      "COPY public.species (id, gbif_key, scientific_name, taxon_class) FROM stdin;",
      `${SPECIES}\t1\tZzseed gamma\tnudibranchs`,
      "\\.",
      "",
      "COPY public.species_traits (species_id, iucn_status, iucn_source, iucn_note, iucn_checked_at, source_attribution) FROM stdin;",
      `${SPECIES}\tNE\tiucn_red_list\tA note.\t2026-10-01 00:00:00+00\tGBIF`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-seed-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    await applyCatalogSeedFile(pool, file, null, noProgress);
    const rows = await pool.query(
      `SELECT iucn_status, iucn_source, iucn_note, iucn_checked_at IS NOT NULL AS checked FROM species_traits WHERE species_id = $1`,
      [SPECIES],
    );
    expect(rows.rows).toEqual([
      { iucn_status: "NE", iucn_source: "iucn_red_list", iucn_note: "A note.", checked: true },
    ]);
  });

  it("removes checklist rows the seed no longer lists, keeping users' own additions and regions the seed doesn't cover", async () => {
    const LISTED = "88888888-8888-4888-8888-888888888801";
    const DROPPED = "88888888-8888-4888-8888-888888888802";
    const OTHER_TAXA = "88888888-8888-4888-8888-888888888803";
    const REGION_IN_SEED = "88888888-8888-4888-8888-888888888811";
    const REGION_NOT_IN_SEED = "88888888-8888-4888-8888-888888888812";
    const IMPORTER = "88888888-8888-4888-8888-888888888821";
    const cleanup = async () => {
      await pool.query(`DELETE FROM users WHERE id = $1`, [IMPORTER]);
      await pool.query(`DELETE FROM regions WHERE id = ANY($1)`, [[REGION_IN_SEED, REGION_NOT_IN_SEED]]);
      await pool.query(`DELETE FROM species WHERE id = ANY($1)`, [[LISTED, DROPPED, OTHER_TAXA]]);
    };
    await cleanup();
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, is_other_taxa) VALUES
         ($1, 8801, 'Prunea listed', 'aves', false), ($2, 8802, 'Prunea dropped', 'aves', false), ($3, 8803, 'Prunea mine', 'insecta', true)`,
      [LISTED, DROPPED, OTHER_TAXA],
    );
    await pool.query(`INSERT INTO regions (id, name) VALUES ($1, 'Pruneland'), ($2, 'Untouchedland')`, [
      REGION_IN_SEED,
      REGION_NOT_IN_SEED,
    ]);
    await pool.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $3), ($1, $4), ($2, $4)`, [
      REGION_IN_SEED,
      REGION_NOT_IN_SEED,
      LISTED,
      DROPPED,
    ]);
    // A hand import is the importing user's own addition, which a catalog update never prunes.
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'prune-importer@test', 'x')`, [
      IMPORTER,
    ]);
    await pool.query(`INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      IMPORTER,
      REGION_IN_SEED,
      OTHER_TAXA,
    ]);
    await pool.query(
      `INSERT INTO region_species_hotspots (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km) VALUES ($1, $2, 1, 1, 3, 1)`,
      [REGION_IN_SEED, DROPPED],
    );
    const dump = [
      "COPY public.region_species (region_id, species_id, is_vagrant, is_invasive) FROM stdin;",
      `${REGION_IN_SEED}	${LISTED}	f	f`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-prune-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    try {
      const merged = await applyCatalogSeedFile(pool, file, null, noProgress);
      expect(merged.region_speciesRemoved).toBe(1);
      const rows = await pool.query(
        `SELECT region_id, species_id FROM region_species WHERE region_id = ANY($1) ORDER BY region_id, species_id`,
        [[REGION_IN_SEED, REGION_NOT_IN_SEED]],
      );
      expect(rows.rows).toEqual([
        { region_id: REGION_IN_SEED, species_id: LISTED },
        { region_id: REGION_NOT_IN_SEED, species_id: DROPPED },
      ]);
      const added = await pool.query(`SELECT region_id FROM region_species_user_added WHERE user_id = $1`, [IMPORTER]);
      expect(added.rows).toEqual([{ region_id: REGION_IN_SEED }]);
      expect(
        (await pool.query(`SELECT 1 FROM region_species_hotspots WHERE species_id = $1`, [DROPPED])).rowCount,
      ).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it("drops sea zones the seed no longer has, even when a new zone reuses a dropped one's name", async () => {
    const OLD_SAME_NAME = "99999999-9999-4999-8999-999999999901";
    const OLD_GONE = "99999999-9999-4999-8999-999999999902";
    const NEW_ZONE = "99999999-9999-4999-8999-999999999903";
    const FISH = "99999999-9999-4999-8999-999999999911";
    const LOCAL_REGION = "99999999-9999-4999-8999-999999999921";
    const ZONE_USER = "99999999-9999-4999-8999-999999999931";
    const cleanup = async () => {
      await pool.query(`DELETE FROM users WHERE id = $1`, [ZONE_USER]);
      await pool.query(`DELETE FROM regions WHERE id = $1`, [LOCAL_REGION]);
      await pool.query(`DELETE FROM sea_zones WHERE id = ANY($1)`, [[OLD_SAME_NAME, OLD_GONE, NEW_ZONE]]);
      await pool.query(`DELETE FROM species WHERE id = $1`, [FISH]);
    };
    await cleanup();
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 9911, 'Zonea piscis', 'actinopterygii')`,
      [FISH],
    );
    await pool.query(
      `INSERT INTO sea_zones (id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat) VALUES
         ($1, 'Test North Sea', 'POLYGON((0 0,1 0,1 1,0 0))', 0, 0, 1, 1), ($2, 'Test Ecoregion', 'POLYGON((0 0,1 0,1 1,0 0))', 0, 0, 1, 1)`,
      [OLD_SAME_NAME, OLD_GONE],
    );
    await pool.query(
      `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $3, 4), ($2, $3, 4)`,
      [OLD_SAME_NAME, OLD_GONE, FISH],
    );
    // A user's own additions: the one on the zone that comes back under its name moves to the new
    // id, the one on the zone that's gone for good goes with it.
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'zone-additions@test', 'x')`, [
      ZONE_USER,
    ]);
    await pool.query(
      `INSERT INTO sea_zone_species_user_added (user_id, sea_zone_id, species_id, added_at)
       VALUES ($1, $2, $4, '2026-01-02T03:04:05Z'), ($1, $3, $4, now())`,
      [ZONE_USER, OLD_SAME_NAME, OLD_GONE, FISH],
    );
    // A region the seed doesn't carry (drilled down locally), still pointing at a dropped zone.
    await pool.query(`INSERT INTO regions (id, name, nearby_sea_zone_ids) VALUES ($1, 'Local Coast', $2)`, [
      LOCAL_REGION,
      [OLD_GONE],
    ]);
    const dump = [
      "COPY public.sea_zones (id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat, occurrence_computed_at) FROM stdin;",
      `${NEW_ZONE}\tTest North Sea\tPOLYGON((0 0,2 0,2 2,0 0))\t0\t0\t2\t2\t\\N`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-zone-prune-test-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    try {
      // Otherwise the unique name would roll the whole update back.
      const merged = await applyCatalogSeedFile(pool, file, null, noProgress);
      expect(merged.sea_zonesRemoved).toBeGreaterThanOrEqual(2);
      const zones = await pool.query(`SELECT id, name FROM sea_zones WHERE id = ANY($1)`, [
        [OLD_SAME_NAME, OLD_GONE, NEW_ZONE],
      ]);
      expect(zones.rows).toEqual([{ id: NEW_ZONE, name: "Test North Sea" }]);
      expect((await pool.query(`SELECT 1 FROM sea_zone_species WHERE species_id = $1`, [FISH])).rowCount).toBe(0);
      expect(merged.seaZoneAdditionsMoved).toBe(1);
      const kept = await pool.query(
        `SELECT sea_zone_id, species_id, added_at FROM sea_zone_species_user_added WHERE user_id = $1`,
        [ZONE_USER],
      );
      expect(kept.rows).toEqual([
        { sea_zone_id: NEW_ZONE, species_id: FISH, added_at: new Date("2026-01-02T03:04:05Z") },
      ]);
      const region = await pool.query(`SELECT nearby_sea_zone_ids FROM regions WHERE id = $1`, [LOCAL_REGION]);
      expect(region.rows[0].nearby_sea_zone_ids).toBeNull();
    } finally {
      await cleanup();
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
    // Two new regions sharing a name under different parents must not collide on
    // UNIQUE(name, parent_id).
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
    // A region whose id changed upstream must be matched by name and parent, not inserted again.
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
    await pool.query(`INSERT INTO region_species (region_id, species_id, local_tier) VALUES ($1, $2, 'common')`, [
      OLD_GEORGIA,
      OTHER_SPECIES,
    ]);

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

    // Still exactly one Georgia, under its original id.
    const regions = await pool.query(`SELECT id FROM regions WHERE name = 'Georgia'`);
    expect(regions.rows).toEqual([{ id: OLD_GEORGIA }]);

    // The seed's region_species row followed the remap onto the local id.
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
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 1, 'Ardea herodias', 'Aves')`,
      [SPECIES],
    );
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

    const result = await applyGalleryEmbeddingsFile(pool, file, "1:test-model", {
      ...noProgress,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ status: "applied", rows: 2, matched: 1 });
    const ge = await pool.query(
      `SELECT reference_photo_id, embedding, model_version FROM species_reference_gallery_embeddings WHERE species_id = $1`,
      [SPECIES],
    );
    expect(ge.rows).toEqual([
      { reference_photo_id: LOCAL_PHOTO, embedding: [0.5, 0.5, 0.5, 0.5], model_version: "test-model" },
    ]);
  });

  it("applies the identification model's gallery asset into its own table only", async () => {
    await pool.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 1, 'Ardea herodias', 'Aves')`,
      [SPECIES],
    );
    await pool.query(
      `INSERT INTO species_reference_photos (id, species_id, photo_url, credit, license) VALUES ($1, $2, 'https://example.org/heron.jpg', 'c', 'cc-by')`,
      [LOCAL_PHOTO, SPECIES],
    );
    const bin = Buffer.concat([
      encodeGalleryEmbeddingsHeader({ dimension: 4, rowCount: 1, modelVersion: "bioclip-2-v1" }),
      encodeGalleryEmbeddingRecord(
        { speciesId: SPECIES, photoUrl: "https://example.org/heron.jpg", embedding: [0.25, 0.25, 0.25, 0.25] },
        4,
      ),
    ]);
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-ge-test-")), "id-ge.bin.gz");
    writeFileSync(file, gzipSync(bin));

    const result = await applyGalleryEmbeddingsFile(
      pool,
      file,
      "1:bioclip-2-v1",
      { ...noProgress, signal: new AbortController().signal },
      ID_GALLERY,
    );
    expect(result).toEqual({ status: "applied", rows: 1, matched: 1 });
    const id = await pool.query(
      `SELECT reference_photo_id, model_version FROM id_model_gallery_embeddings WHERE species_id = $1`,
      [SPECIES],
    );
    expect(id.rows).toEqual([{ reference_photo_id: LOCAL_PHOTO, model_version: "bioclip-2-v1" }]);
    const clip = await pool.query(`SELECT 1 FROM species_reference_gallery_embeddings WHERE species_id = $1`, [
      SPECIES,
    ]);
    expect(clip.rowCount).toBe(0);
    const tag = await pool.query(`SELECT value FROM install_settings WHERE key = 'id_gallery_embeddings_version'`);
    expect(tag.rows[0]?.value).toBe("1:bioclip-2-v1");
    await pool.query(`DELETE FROM install_settings WHERE key = 'id_gallery_embeddings_version'`);
  });
});
