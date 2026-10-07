// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run apply.integration
// applyPack: a pack replaces its region's checklist for its taxon, and reports species it skipped.
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import * as tar from "tar";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  // vi.hoisted runs before the imports above are initialized, so it has to require.
  /* eslint-disable @typescript-eslint/no-require-imports */
  process.env.APP_DATA_DIR = require("node:fs").mkdtempSync(
    require("node:path").join(require("node:os").tmpdir(), "lifer-pack-data-"),
  );
  /* eslint-enable @typescript-eslint/no-require-imports */
});

const url = process.env.TEST_DATABASE_URL;
const COUNTRY = "Zzpackland";
const PROVINCE = "Zzpack North";
const KEPT = "99999999-9999-4999-8999-999999999901";
const DROPPED = "99999999-9999-4999-8999-999999999902";
const MAMMAL = "99999999-9999-4999-8999-999999999903";
const MINE = "99999999-9999-4999-8999-999999999904";
const NEW_IN_PACK = "99999999-9999-4999-8999-999999999905";
const ALL = [KEPT, DROPPED, MAMMAL, MINE, NEW_IN_PACK];
// Imported MINE by hand, which makes it this user's own checklist addition.
const IMPORTER = "99999999-9999-4999-8999-999999999931";

async function packFile(manifest: object, files: Record<string, string> = {}): Promise<string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-src-"));
  writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-pack-out-")), "test.pack.tar.gz");
  await tar.create({ gzip: true, file, cwd: dir }, ["manifest.json", ...Object.keys(files)]);
  return file;
}

const species = (scientificName: string) => ({
  scientificName,
  habitatDescription: null,
  referenceCredit: null,
  referenceLicense: null,
  displayFile: null,
  thumbFile: null,
  localFrequency: 10,
});

describe.skipIf(!url)("applyPack checklist replacement", () => {
  const db = new pg.Pool({ connectionString: url });
  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [IMPORTER]);
    await db.query(`DELETE FROM regions WHERE name IN ($1, $2)`, [COUNTRY, PROVINCE]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.end();
  });

  let countryId: string;
  beforeEach(async () => {
    await db.query(`DELETE FROM regions WHERE name IN ($1, $2)`, [COUNTRY, PROVINCE]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, is_other_taxa) VALUES
         ($1, 9901, 'Zzpacka kept', 'aves', false), ($2, 9902, 'Zzpacka dropped', 'aves', false),
         ($3, 9903, 'Zzpacka mammal', 'mammalia', false), ($4, 9904, 'Zzpacka mine', 'aves', true),
         ($5, 9905, 'Zzpacka newcomer', 'aves', false)`,
      ALL,
    );
    countryId = (
      await db.query<{ id: string }>(`INSERT INTO regions (name, external_codes) VALUES ($1, '{ZZP}') RETURNING id`, [
        COUNTRY,
      ])
    ).rows[0].id;
    const provinceId = (
      await db.query<{ id: string }>(`INSERT INTO regions (name, parent_id) VALUES ($1, $2) RETURNING id`, [
        PROVINCE,
        countryId,
      ])
    ).rows[0].id;
    for (const region of [countryId, provinceId]) {
      await db.query(`INSERT INTO region_species (region_id, species_id) SELECT $1, unnest($2::uuid[])`, [
        region,
        [KEPT, DROPPED, MAMMAL],
      ]);
    }
    await db.query(`DELETE FROM users WHERE id = $1`, [IMPORTER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-importer@test', 'x')`, [IMPORTER]);
    await db.query(
      `INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $4), ($1, $3, $4)`,
      [IMPORTER, countryId, provinceId, MINE],
    );
  });

  // A pack never touches the user's own additions, so the hand import stays on both checklists.
  const expectImportKept = async () =>
    expect(
      Number(
        (await db.query(`SELECT count(*) FROM region_species_user_added WHERE species_id = $1`, [MINE])).rows[0].count,
      ),
    ).toBe(2);

  async function apply(manifest: object, files?: Record<string, string>) {
    const { applyPack } = await import("./apply.js");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await applyPack(client, await packFile(manifest, files));
      await client.query("COMMIT");
      return result;
    } finally {
      client.release();
    }
  }

  const checklist = async (name: string) =>
    (
      await db.query<{ scientific_name: string }>(
        `SELECT s.scientific_name FROM region_species rs JOIN regions r ON r.id = rs.region_id JOIN species s ON s.id = rs.species_id
         WHERE r.name = $1 ORDER BY 1`,
        [name],
      )
    ).rows.map((r) => r.scientific_name);

  it("a bird pack replaces the region's birds and leaves its mammals and the user's Other Taxa", async () => {
    const birds = [species("Zzpacka kept"), species("Zzpacka newcomer"), species("Zzpacka unknown")];
    const result = await apply({
      type: "region",
      region: COUNTRY,
      taxon: "aves",
      species: birds,
      children: [
        {
          name: PROVINCE,
          ebirdRegionCode: null,
          boundaryGeoJson: null,
          externalCodes: [],
          species: birds,
          isOverseasTerritory: false,
        },
      ],
    });
    const expected = ["Zzpacka kept", "Zzpacka mammal", "Zzpacka newcomer"];
    expect(await checklist(COUNTRY)).toEqual(expected);
    expect(await checklist(PROVINCE)).toEqual(expected);
    await expectImportKept();
    // Counted once per checklist it was missing from, named once.
    expect(result.skipped).toBe(2);
    expect(result.skippedNames).toEqual(["Zzpacka unknown"]);
  });

  it("an all-taxa pack replaces every class", async () => {
    await apply({ type: "region", region: COUNTRY, taxon: null, species: [species("Zzpacka kept")] });
    expect(await checklist(COUNTRY)).toEqual(["Zzpacka kept"]);
    await expectImportKept();
  });

  it("a pack from before the taxon field only adds", async () => {
    await apply({ type: "region", region: COUNTRY, species: [species("Zzpacka newcomer")] });
    expect(await checklist(COUNTRY)).toEqual([
      "Zzpacka dropped",
      "Zzpacka kept",
      "Zzpacka mammal",
      "Zzpacka newcomer",
    ]);
  });

  it("skips a gallery photo whose sortOrder isn't a number, so its file can't land outside the gallery folder", async () => {
    const gallery = [
      {
        photoUrl: "https://example.org/zzpack-escape.jpg",
        credit: "x",
        license: "cc-by",
        sortOrder: "/../../zzpack-escape",
        focalX: null,
        focalY: null,
        displayFile: "g.webp",
        thumbFile: null,
      },
    ];
    await apply(
      { type: "region", region: COUNTRY, species: [{ ...species("Zzpacka kept"), gallery }] },
      { "g.webp": "photo" },
    );
    expect(existsSync(path.join(process.env.APP_DATA_DIR!, "zzpack-escape.webp"))).toBe(false);
    const rows = await db.query(`SELECT 1 FROM species_reference_photos WHERE species_id = $1`, [KEPT]);
    expect(rows.rowCount).toBe(0);
  });
});

// Enrichment, gallery photos, embeddings, hotspots, sea zones and bundled provinces.
const NEW = "eeeeeeee-0000-4000-8000-000000000601";
const DONE = "eeeeeeee-0000-4000-8000-000000000602";
const STALE = "eeeeeeee-0000-4000-8000-000000000603";
const DROP = "eeeeeeee-0000-4000-8000-000000000604";
const ENRICH_ALL = [NEW, DONE, STALE, DROP];
const ENRICH_COUNTRY = "Zzenrichland";
const OTHER_COUNTRY = "Zzenrich Elsewhere";
const ISLE = "Zzenrich Isle";
const MAINLAND = "Zzenrich Mainland";
const SEA = "Zzenrich Sea";
const BLOCKED_URL = "https://example.org/zzenrich-map.jpg";

describe.skipIf(!url)("applyPack enrichment and extras", () => {
  const db = new pg.Pool({ connectionString: url });
  const appData = process.env.APP_DATA_DIR!;
  const existingFiles = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-existing-"));
  const doneDisplay = path.join(existingFiles, "done-display.webp");
  const doneThumb = path.join(existingFiles, "done-thumb.webp");
  let countryId: string;
  let otherCountryId: string;
  let seaId: string;

  async function cleanup() {
    await db.query(`DELETE FROM regions WHERE name IN ($1, $2, $3, $4)`, [
      ISLE,
      MAINLAND,
      ENRICH_COUNTRY,
      OTHER_COUNTRY,
    ]);
    await db.query(`DELETE FROM sea_zones WHERE name = $1`, [SEA]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ENRICH_ALL]);
    await db.query(`DELETE FROM reference_photo_blocklist WHERE photo_url = $1`, [BLOCKED_URL]);
  }

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  beforeEach(async () => {
    await cleanup();
    writeFileSync(doneDisplay, "done display");
    writeFileSync(doneThumb, "done thumb");
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, enriched_at, habitat_description, reference_credit,
         reference_license, reference_display_path, reference_thumb_path, gallery_backfilled_at) VALUES
         ($1, 920601, 'Zzenrich novus', 'aves', NULL, NULL, NULL, NULL, NULL, NULL, NULL),
         ($2, 920602, 'Zzenrich doneus', 'aves', now(), 'Old habitat', 'Old credit', 'cc0', $5, $6, '2020-01-01T00:00:00Z'),
         ($3, 920603, 'Zzenrich staleus', 'aves', now(), NULL, 'Kept credit', 'cc-by', '/nowhere/zzenrich-missing.webp', NULL, NULL),
         ($4, 920604, 'Zzenrich dropus', 'aves', now(), NULL, NULL, NULL, NULL, NULL, NULL)`,
      [NEW, DONE, STALE, DROP, doneDisplay, doneThumb],
    );
    countryId = (
      await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [ENRICH_COUNTRY])
    ).rows[0].id;
    otherCountryId = (
      await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [OTHER_COUNTRY])
    ).rows[0].id;
    seaId = (
      await db.query<{ id: string }>(
        `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat) VALUES ($1, 'POINT(0 0)', 0, 0, 1, 1) RETURNING id`,
        [SEA],
      )
    ).rows[0].id;
    await db.query(`INSERT INTO reference_photo_blocklist (photo_url, reason) VALUES ($1, 'a map')`, [BLOCKED_URL]);
  });

  async function apply(manifest: object, files?: Record<string, string>) {
    const { applyPack } = await import("./apply.js");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const result = await applyPack(client, await packFile(manifest, files));
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  const speciesRow = async (id: string) =>
    (
      await db.query(
        `SELECT habitat_description, reference_credit, reference_license, reference_display_path, reference_thumb_path,
                enriched_at IS NOT NULL AS enriched, gallery_backfilled_at
         FROM species WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const read = (p: string | null) => (p && existsSync(p) ? readFileSync(p, "utf8") : null);

  it("enriches a species that needs it, keeps what an earlier enrich set, and records checklist details", async () => {
    const result = await apply(
      {
        type: "region",
        region: ENRICH_COUNTRY,
        species: [
          {
            ...species("Zzenrich novus"),
            habitatDescription: "Wetlands",
            referenceCredit: "Ann (iNaturalist)",
            referenceLicense: "cc-by",
            displayFile: "d1.webp",
            thumbFile: "t1.webp",
            localFrequency: 0.25,
            seasonality: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
            localTier: "rare",
            isVagrant: true,
            weeklyFrequency: [5, 2],
            tierReason: "few records",
            tierExplain: { records: 3 },
          },
          {
            ...species("Zzenrich doneus"),
            referenceCredit: "New credit",
            habitatDescription: "New",
            displayFile: "d2.webp",
            thumbFile: "t2.webp",
          },
          {
            ...species("Zzenrich staleus"),
            referenceCredit: "New credit",
            referenceLicense: "cc-by-sa",
            habitatDescription: "Forest",
            displayFile: "d3.webp",
          },
          // Enriched without image files, and the pack has none either: nothing to fill in.
          { ...species("Zzenrich dropus"), habitatDescription: "Ignored" },
        ],
      },
      {
        "d1.webp": "display 1",
        "t1.webp": "thumb 1",
        "d2.webp": "display 2",
        "t2.webp": "thumb 2",
        "d3.webp": "display 3",
      },
    );

    expect(result.speciesCount).toBe(4);
    expect(result.touched).toEqual([
      { speciesId: NEW, providedEnrichment: true },
      { speciesId: DONE, providedEnrichment: false },
      { speciesId: STALE, providedEnrichment: true },
      { speciesId: DROP, providedEnrichment: false },
    ]);
    expect((await speciesRow(DROP)).habitat_description).toBeNull();

    const fresh = await speciesRow(NEW);
    expect(fresh).toMatchObject({
      habitat_description: "Wetlands",
      reference_credit: "Ann (iNaturalist)",
      reference_license: "cc-by",
      reference_display_path: path.join(appData, "reference-display", `${NEW}.webp`),
      reference_thumb_path: path.join(appData, "reference-thumb", `${NEW}.webp`),
      enriched: true,
    });
    expect(read(fresh.reference_display_path)).toBe("display 1");
    expect(read(fresh.reference_thumb_path)).toBe("thumb 1");

    // Already enriched with its files in place: nothing about it changes.
    expect(await speciesRow(DONE)).toMatchObject({
      habitat_description: "Old habitat",
      reference_credit: "Old credit",
      reference_license: "cc0",
      reference_display_path: doneDisplay,
      reference_thumb_path: doneThumb,
    });
    expect(read(doneDisplay)).toBe("done display");

    // Its display file went missing, so the pack's file replaces it and a missing description is
    // filled in. The credit and license come with the pack's photo, not the one it replaced.
    const stale = await speciesRow(STALE);
    expect(stale).toMatchObject({
      habitat_description: "Forest",
      reference_credit: "New credit",
      reference_license: "cc-by-sa",
      reference_display_path: path.join(appData, "reference-display", `${STALE}.webp`),
      reference_thumb_path: null,
    });
    expect(read(stale.reference_display_path)).toBe("display 3");

    // Every matched species is marked as having had its gallery looked up, keeping an earlier date.
    expect((await speciesRow(NEW)).gallery_backfilled_at).not.toBeNull();
    expect((await speciesRow(DONE)).gallery_backfilled_at.toISOString()).toBe("2020-01-01T00:00:00.000Z");

    const rows = await db.query(
      `SELECT species_id, local_frequency::float AS local_frequency, seasonality, local_tier, is_vagrant,
              weekly_frequency, tier_reason, tier_explain
       FROM region_species WHERE region_id = $1 ORDER BY species_id`,
      [countryId],
    );
    expect(rows.rows).toEqual([
      {
        species_id: NEW,
        local_frequency: 0.25,
        seasonality: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        local_tier: "rare",
        is_vagrant: true,
        weekly_frequency: [5, 2],
        tier_reason: "few records",
        tier_explain: { records: 3 },
      },
      {
        species_id: DONE,
        local_frequency: 10,
        seasonality: null,
        local_tier: null,
        is_vagrant: false,
        weekly_frequency: null,
        tier_reason: null,
        tier_explain: null,
      },
      {
        species_id: STALE,
        local_frequency: 10,
        seasonality: null,
        local_tier: null,
        is_vagrant: false,
        weekly_frequency: null,
        tier_reason: null,
        tier_explain: null,
      },
      {
        species_id: DROP,
        local_frequency: 10,
        seasonality: null,
        local_tier: null,
        is_vagrant: false,
        weekly_frequency: null,
        tier_reason: null,
        tier_explain: null,
      },
    ]);
    const region = await db.query(`SELECT occurrence_computed_at FROM regions WHERE id = $1`, [countryId]);
    expect(region.rows[0].occurrence_computed_at).not.toBeNull();
  });

  it("re-enriches a species whose thumbnail is missing even though its display photo is in place", async () => {
    await db.query(`UPDATE species SET reference_thumb_path = '/nowhere/zzenrich-thumb.webp' WHERE id = $1`, [DONE]);
    const result = await apply(
      { type: "region", region: ENRICH_COUNTRY, species: [{ ...species("Zzenrich doneus"), thumbFile: "t.webp" }] },
      { "t.webp": "new thumb" },
    );
    expect(result.touched).toEqual([{ speciesId: DONE, providedEnrichment: true }]);
    const row = await speciesRow(DONE);
    expect(row.reference_thumb_path).toBe(path.join(appData, "reference-thumb", `${DONE}.webp`));
    expect(read(row.reference_thumb_path)).toBe("new thumb");
    expect(row.reference_display_path).toBe(doneDisplay);
  });

  it("updates checklist details when the region's pack is applied again", async () => {
    await apply({
      type: "region",
      region: ENRICH_COUNTRY,
      species: [{ ...species("Zzenrich novus"), localTier: "rare", isVagrant: true, tierExplain: { a: 1 } }],
    });
    await apply({
      type: "region",
      region: ENRICH_COUNTRY,
      species: [{ ...species("Zzenrich novus"), localFrequency: 50, localTier: "common", seasonality: [3] }],
    });
    const rows = await db.query(
      `SELECT local_frequency::float AS f, local_tier, is_vagrant, seasonality, tier_explain FROM region_species WHERE region_id = $1`,
      [countryId],
    );
    expect(rows.rows).toEqual([
      { f: 50, local_tier: "common", is_vagrant: false, seasonality: [3], tier_explain: null },
    ]);
  });

  it("installs gallery photos with their credit, skips blocklisted ones and files outside the pack, and keeps embeddings", async () => {
    await db.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order, display_path, thumb_path) VALUES
         ($1, 'https://example.org/zzenrich-kept.jpg', 'Original credit', 'cc0', 0, $2, NULL),
         ($1, 'https://example.org/zzenrich-lost.jpg', 'Lost credit', 'cc0', 1, '/nowhere/zzenrich-lost.webp', NULL),
         ($1, 'https://example.org/zzenrich-thumbless.jpg', 'Thumb credit', 'cc0', 2, $2, '/nowhere/zzenrich-thumb.webp')`,
      [DONE, doneDisplay],
    );
    await db.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, '{9,9}', 'older')`,
      [DONE],
    );
    const photo = (photoUrl: string, sortOrder: number, extra: object = {}) => ({
      photoUrl,
      credit: `Credit ${sortOrder}`,
      license: "cc-by-nc",
      sortOrder,
      focalX: 0.25,
      focalY: 0.75,
      displayFile: null,
      thumbFile: null,
      ...extra,
    });
    await apply(
      {
        type: "region",
        region: ENRICH_COUNTRY,
        species: [
          {
            ...species("Zzenrich novus"),
            embedding: [1, 2],
            embeddingModelVersion: "m1",
            gallery: [
              photo("https://example.org/zzenrich-0.jpg", 0, {
                displayFile: "g0d.webp",
                thumbFile: "g0t.webp",
                embedding: [0.5, 0.25],
                embeddingModelVersion: "m1",
              }),
              photo(BLOCKED_URL, 1, { displayFile: "g0d.webp" }),
              // No model version: a vector that can't be matched to a model is not stored.
              photo("https://example.org/zzenrich-2.jpg", 2, {
                displayFile: "../../zzenrich-outside.webp",
                embedding: [0.1, 0.1],
              }),
            ],
          },
          {
            ...species("Zzenrich doneus"),
            embedding: [1, 1],
            embeddingModelVersion: "m1",
            gallery: [
              photo("https://example.org/zzenrich-kept.jpg", 0, {
                displayFile: "g0d.webp",
                embedding: [0.75, 0.75],
                embeddingModelVersion: "m1",
              }),
              photo("https://example.org/zzenrich-lost.jpg", 1, { displayFile: "g1d.webp" }),
              photo("https://example.org/zzenrich-thumbless.jpg", 2, { thumbFile: "g2t.webp" }),
            ],
          },
          { ...species("Zzenrich staleus"), embedding: [3, 3] },
        ],
      },
      {
        "g0d.webp": "gallery display 0",
        "g0t.webp": "gallery thumb 0",
        "g1d.webp": "gallery display 1",
        "g2t.webp": "gallery thumb 2",
      },
    );

    const gallery = await db.query(
      `SELECT species_id, photo_url, credit, license, sort_order, focal_x::float AS focal_x, focal_y::float AS focal_y, display_path, thumb_path
       FROM species_reference_photos WHERE species_id = ANY($1) ORDER BY species_id, sort_order`,
      [[NEW, DONE]],
    );
    const galleryDir = path.join(appData, "reference-gallery-display");
    expect(gallery.rows).toEqual([
      {
        species_id: NEW,
        photo_url: "https://example.org/zzenrich-0.jpg",
        credit: "Credit 0",
        license: "cc-by-nc",
        sort_order: 0,
        focal_x: 0.25,
        focal_y: 0.75,
        display_path: path.join(galleryDir, `${NEW}-0.webp`),
        thumb_path: path.join(appData, "reference-gallery-thumb", `${NEW}-0.webp`),
      },
      {
        species_id: NEW,
        photo_url: "https://example.org/zzenrich-2.jpg",
        credit: "Credit 2",
        license: "cc-by-nc",
        sort_order: 2,
        focal_x: 0.25,
        focal_y: 0.75,
        display_path: null,
        thumb_path: null,
      },
      // An installed photo with its file in place is left exactly as it was.
      {
        species_id: DONE,
        photo_url: "https://example.org/zzenrich-kept.jpg",
        credit: "Original credit",
        license: "cc0",
        sort_order: 0,
        focal_x: null,
        focal_y: null,
        display_path: doneDisplay,
        thumb_path: null,
      },
      // One whose file went missing gets the pack's file back, keeping its credit.
      {
        species_id: DONE,
        photo_url: "https://example.org/zzenrich-lost.jpg",
        credit: "Lost credit",
        license: "cc0",
        sort_order: 1,
        focal_x: null,
        focal_y: null,
        display_path: path.join(galleryDir, `${DONE}-1.webp`),
        thumb_path: null,
      },
      // And one whose thumbnail went missing gets the pack's thumbnail.
      {
        species_id: DONE,
        photo_url: "https://example.org/zzenrich-thumbless.jpg",
        credit: "Thumb credit",
        license: "cc0",
        sort_order: 2,
        focal_x: null,
        focal_y: null,
        display_path: doneDisplay,
        thumb_path: path.join(appData, "reference-gallery-thumb", `${DONE}-2.webp`),
      },
    ]);
    expect(read(path.join(appData, "reference-gallery-thumb", `${DONE}-2.webp`))).toBe("gallery thumb 2");
    expect(read(path.join(galleryDir, `${NEW}-0.webp`))).toBe("gallery display 0");
    expect(read(path.join(appData, "reference-gallery-thumb", `${NEW}-0.webp`))).toBe("gallery thumb 0");
    expect(read(path.join(galleryDir, `${DONE}-1.webp`))).toBe("gallery display 1");
    expect(read(doneDisplay)).toBe("done display");
    expect(existsSync(path.join(appData, "zzenrich-outside.webp"))).toBe(false);

    const galleryEmbeddings = await db.query(
      `SELECT p.photo_url, e.species_id, e.embedding::float8[] AS embedding, e.model_version
       FROM species_reference_gallery_embeddings e JOIN species_reference_photos p ON p.id = e.reference_photo_id
       WHERE e.species_id = ANY($1) ORDER BY p.photo_url`,
      [[NEW, DONE]],
    );
    expect(galleryEmbeddings.rows).toEqual([
      { photo_url: "https://example.org/zzenrich-0.jpg", species_id: NEW, embedding: [0.5, 0.25], model_version: "m1" },
      {
        photo_url: "https://example.org/zzenrich-kept.jpg",
        species_id: DONE,
        embedding: [0.75, 0.75],
        model_version: "m1",
      },
    ]);
    // A reference vector is only filled in where there's none yet.
    const embeddings = await db.query(
      `SELECT species_id, embedding::float8[] AS embedding, model_version FROM species_reference_embeddings WHERE species_id = ANY($1) ORDER BY species_id`,
      [[NEW, DONE, STALE]],
    );
    expect(embeddings.rows).toEqual([
      { species_id: NEW, embedding: [1, 2], model_version: "m1" },
      { species_id: DONE, embedding: [9, 9], model_version: "older" },
    ]);
  });

  it("replaces a species' hotspots and removes those of species the pack drops, in that region only", async () => {
    const hotspot = (lat: number) => ({
      centroidLat: lat,
      centroidLon: -150,
      pointCount: 4,
      bboxDiagonalKm: 2.5,
      lastSeenYear: 2024,
      distinctYears: 3,
    });
    for (const region of [countryId, otherCountryId]) {
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2), ($1, $3)`, [
        region,
        NEW,
        DROP,
      ]);
      await db.query(
        `INSERT INTO region_species_hotspots (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km)
         VALUES ($1, $2, 1, 1, 1, 1), ($1, $3, 2, 2, 2, 2)`,
        [region, NEW, DROP],
      );
    }
    await apply({
      type: "region",
      region: ENRICH_COUNTRY,
      taxon: "aves",
      species: [{ ...species("Zzenrich novus"), hotspots: [hotspot(60), hotspot(61)] }],
    });

    const spots = async (region: string) =>
      (
        await db.query(
          `SELECT species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km, last_seen_year, distinct_years
           FROM region_species_hotspots WHERE region_id = $1 ORDER BY species_id, centroid_lat`,
          [region],
        )
      ).rows;
    expect(await spots(countryId)).toEqual([
      {
        species_id: NEW,
        centroid_lat: 60,
        centroid_lon: -150,
        point_count: 4,
        bbox_diagonal_km: 2.5,
        last_seen_year: 2024,
        distinct_years: 3,
      },
      {
        species_id: NEW,
        centroid_lat: 61,
        centroid_lon: -150,
        point_count: 4,
        bbox_diagonal_km: 2.5,
        last_seen_year: 2024,
        distinct_years: 3,
      },
    ]);
    expect((await spots(otherCountryId)).map((s) => s.centroid_lat)).toEqual([1, 2]);
    const checklist = await db.query(`SELECT species_id FROM region_species WHERE region_id = $1`, [countryId]);
    expect(checklist.rows).toEqual([{ species_id: NEW }]);
  });

  it("applies a sea zone pack to that zone's checklist, replacing it for the pack's taxon", async () => {
    await db.query(
      `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $2, 3), ($1, $3, 3)`,
      [seaId, DROP, NEW],
    );
    const result = await apply({
      type: "seaZone",
      seaZone: SEA,
      taxon: "aves",
      species: [
        { ...species("Zzenrich novus"), recordCount: 7 },
        species("Zzenrich doneus"),
        species("Zzenrich unknownus"),
      ],
    });
    expect(result).toMatchObject({ speciesCount: 2, skipped: 1, skippedNames: ["Zzenrich unknownus"] });
    expect(result.touched.map((t) => t.speciesId)).toEqual([NEW, DONE]);
    const rows = await db.query(
      `SELECT species_id, record_count FROM sea_zone_species WHERE sea_zone_id = $1 ORDER BY species_id`,
      [seaId],
    );
    expect(rows.rows).toEqual([
      { species_id: NEW, record_count: 7 },
      { species_id: DONE, record_count: 0 },
    ]);
    const zone = await db.query(`SELECT occurrence_computed_at FROM sea_zones WHERE id = $1`, [seaId]);
    expect(zone.rows[0].occurrence_computed_at).not.toBeNull();
    const regionRows = await db.query(`SELECT 1 FROM region_species WHERE region_id = $1`, [countryId]);
    expect(regionRows.rowCount).toBe(0);
  });

  it("creates bundled provinces under the country and reports which are overseas territories", async () => {
    // An existing province row is reused, and its territory flag follows the pack.
    const existingMainland = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, is_overseas_territory) VALUES ($1, $2, true) RETURNING id`,
        [MAINLAND, countryId],
      )
    ).rows[0].id;
    const boundary = { type: "Point", coordinates: [1, 2] };
    const result = await apply({
      type: "region",
      region: ENRICH_COUNTRY,
      species: [species("Zzenrich novus"), species("Zzenrich countryonlyus")],
      children: [
        {
          name: ISLE,
          ebirdRegionCode: "ZZ-I",
          boundaryGeoJson: boundary,
          externalCodes: ["ZZI"],
          species: [species("Zzenrich doneus"), species("Zzenrich childonlyus")],
          isOverseasTerritory: true,
        },
        // A pack from before the territory flag: treated as not a territory.
        {
          name: MAINLAND,
          ebirdRegionCode: null,
          boundaryGeoJson: null,
          externalCodes: [],
          species: [species("Zzenrich staleus")],
        },
      ],
    });
    const children = await db.query(
      `SELECT id, name, ebird_region_code, boundary_geojson, external_codes, is_overseas_territory, has_children,
              occurrence_computed_at IS NOT NULL AS computed
       FROM regions WHERE parent_id = $1 ORDER BY name`,
      [countryId],
    );
    const isle = children.rows.find((r) => r.name === ISLE);
    expect(children.rows).toEqual([
      {
        id: isle.id,
        name: ISLE,
        ebird_region_code: "ZZ-I",
        boundary_geojson: boundary,
        external_codes: ["ZZI"],
        is_overseas_territory: true,
        has_children: false,
        computed: true,
      },
      {
        id: existingMainland,
        name: MAINLAND,
        ebird_region_code: null,
        boundary_geojson: null,
        external_codes: [],
        is_overseas_territory: false,
        has_children: false,
        computed: true,
      },
    ]);
    expect(result.allChildRegionIds).toEqual([isle.id, existingMainland]);
    expect(result.territoryChildRegionIds).toEqual([isle.id]);
    expect(result.speciesCount).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.skippedNames).toEqual(["Zzenrich countryonlyus", "Zzenrich childonlyus"]);
    expect(result.touched.map((t) => t.speciesId)).toEqual([NEW, DONE, STALE]);
    const country = await db.query(`SELECT has_children FROM regions WHERE id = $1`, [countryId]);
    expect(country.rows[0].has_children).toBe(true);
    const childChecklist = await db.query(`SELECT species_id FROM region_species WHERE region_id = $1`, [isle.id]);
    expect(childChecklist.rows).toEqual([{ species_id: DONE }]);
  });

  it("changes nothing for a region or sea zone this install doesn't have", async () => {
    for (const manifest of [
      {
        type: "region",
        region: "Zzenrich Nowhere",
        species: [species("Zzenrich novus")],
        children: [
          {
            name: ISLE,
            ebirdRegionCode: null,
            boundaryGeoJson: null,
            externalCodes: [],
            species: [],
            isOverseasTerritory: false,
          },
        ],
      },
      { type: "seaZone", seaZone: "Zzenrich Nowhere Sea", species: [species("Zzenrich novus")] },
      { type: "seaZone", species: [species("Zzenrich novus")] },
    ]) {
      const result = await apply(manifest);
      expect(result).toMatchObject({ speciesCount: 0, skipped: 0, touched: [], allChildRegionIds: [] });
    }
    expect((await speciesRow(NEW)).enriched).toBe(false);
    expect((await db.query(`SELECT 1 FROM regions WHERE name = $1`, [ISLE])).rowCount).toBe(0);
  });

  it("removes its extracted copy of the pack, also when the pack is broken", async () => {
    const extracted = () =>
      readdirSync(os.tmpdir())
        .filter((name) => /^lifer-pack-[A-Za-z0-9]{6}$/.test(name))
        .sort();
    const before = extracted();
    await apply({ type: "region", region: ENRICH_COUNTRY, species: [] });
    expect(extracted()).toEqual(before);
    const dir = mkdtempSync(path.join(os.tmpdir(), "lifer-pack-src-"));
    writeFileSync(path.join(dir, "readme.txt"), "no manifest here");
    const broken = path.join(dir, "broken.pack.tar.gz");
    await tar.create({ gzip: true, file: broken, cwd: dir }, ["readme.txt"]);
    const { applyPack } = await import("./apply.js");
    const client = await db.connect();
    try {
      await expect(applyPack(client, broken)).rejects.toThrow(/manifest\.json/);
    } finally {
      client.release();
    }
    expect(extracted()).toEqual(before);
  });

  it("applies more species than fit in one bulk statement", async () => {
    const many = Array.from({ length: 501 }, (_, i) => `Zzbulk species ${String(i).padStart(3, "0")}`);
    await db.query(
      `INSERT INTO species (gbif_key, scientific_name, taxon_class)
       SELECT 9206000 + i, 'Zzbulk species ' || lpad(i::text, 3, '0'), 'aves' FROM generate_series(0, 500) AS i`,
    );
    try {
      const result = await apply({
        type: "region",
        region: ENRICH_COUNTRY,
        species: many.map((name, i) => ({
          ...species(name),
          localFrequency: i,
          hotspots: [
            {
              centroidLat: i / 10,
              centroidLon: 0,
              pointCount: 1,
              bboxDiagonalKm: 1,
              lastSeenYear: null,
              distinctYears: null,
            },
          ],
        })),
      });
      expect(result.speciesCount).toBe(501);
      const stats = await db.query(
        `SELECT count(*)::int AS n, sum(local_frequency)::int AS total, count(*) FILTER (WHERE s.enriched_at IS NOT NULL)::int AS enriched
         FROM region_species rs JOIN species s ON s.id = rs.species_id WHERE rs.region_id = $1`,
        [countryId],
      );
      expect(stats.rows[0]).toEqual({ n: 501, total: (500 * 501) / 2, enriched: 501 });
      const hotspots = await db.query(`SELECT count(*)::int AS n FROM region_species_hotspots WHERE region_id = $1`, [
        countryId,
      ]);
      expect(hotspots.rows[0].n).toBe(501);
    } finally {
      await db.query(`DELETE FROM species WHERE scientific_name LIKE 'Zzbulk species %'`);
    }
  });
});
