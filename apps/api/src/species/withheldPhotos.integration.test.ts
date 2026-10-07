// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run withheldPhotos.integration
// Which species the background fetch of withheld photos looks at, and what it writes.
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const COUNTRY = "Zzwithheld Land";
const PROVINCE = "Zzwithheld North";
const OFFLOADED = "Zzwithheld Offloaded";
const OTHER_COUNTRY = "Zzwithheld Elsewhere";
const ZONE = "Zzwithheld Sea";
const PACK = "zzwithheld-land-aves";
const ZONE_PACK = "zzwithheld-sea-fish";

const id = (n: number) => `77777777-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const S = {
  onCountry: id(1),
  hasPhoto: id(2),
  notWithheld: id(3),
  noPack: id(4),
  offloadedOnly: id(5),
  checkedRecently: id(6),
  checkedLongAgo: id(7),
  onZone: id(8),
  onProvince: id(9),
};
const ALL = Object.values(S);

describe.skipIf(!url)("withheld photo fetch (integration)", async () => {
  const db = new pg.Pool({ connectionString: url });
  const {
    attemptsInLastDay,
    isWithheldPhotoFetchEnabled,
    markPhotoChecked,
    selectWithheldPhotoSpecies,
    FETCH_WITHHELD_PHOTOS_SETTING,
  } = await import("./withheldPhotos.js");
  const { setInstallSetting } = await import("../lib/installSettings.js");
  const { persistMainPhotoIfMissing } = await import("@lifer/core/species/lazyEnrich.js");
  const { pool } = await import("@lifer/core/db.js");

  async function cleanUp() {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id IN ($1, $2)`, [PACK, ZONE_PACK]);
    await db.query(`DELETE FROM regions WHERE name IN ($1, $2, $3)`, [PROVINCE, OFFLOADED, OTHER_COUNTRY]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [COUNTRY]);
    await db.query(`DELETE FROM sea_zones WHERE name = $1`, [ZONE]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [FETCH_WITHHELD_PHOTOS_SETTING]);
  }

  afterAll(async () => {
    await cleanUp();
    await db.end();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanUp();
    for (const [i, speciesId] of ALL.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, photo_withheld) VALUES ($1, $2, $3, 'aves', $4)`,
        [speciesId, 7_770_000 + i, `Zzwithheld species${i}`, speciesId !== S.notWithheld],
      );
    }
    await db.query(
      `UPDATE species SET reference_photo = 'https://example.org/own.jpg', reference_credit = 'Me', reference_license = 'cc-by'
       WHERE id = $1`,
      [S.hasPhoto],
    );
    await db.query(`UPDATE species SET photo_checked_at = now() - interval '5 days' WHERE id = $1`, [
      S.checkedRecently,
    ]);
    await db.query(`UPDATE species SET photo_checked_at = now() - interval '40 days' WHERE id = $1`, [
      S.checkedLongAgo,
    ]);

    const region = async (name: string, parent: string | null) =>
      (
        await db.query<{ id: string }>(`INSERT INTO regions (name, parent_id) VALUES ($1, $2) RETURNING id`, [
          name,
          parent,
        ])
      ).rows[0].id;
    const country = await region(COUNTRY, null);
    const province = await region(PROVINCE, country);
    const offloaded = await region(OFFLOADED, country);
    const elsewhere = await region(OTHER_COUNTRY, null);
    const zone = (
      await db.query<{ id: string }>(
        `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
         VALUES ($1, 'POLYGON EMPTY', 0, 0, 1, 1) RETURNING id`,
        [ZONE],
      )
    ).rows[0].id;

    const onRegion = async (regionId: string, speciesIds: string[]) => {
      for (const sid of speciesIds)
        await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [regionId, sid]);
    };
    await onRegion(country, [S.onCountry, S.hasPhoto, S.notWithheld, S.checkedRecently, S.checkedLongAgo]);
    await onRegion(province, [S.onProvince]);
    await onRegion(offloaded, [S.offloadedOnly]);
    // A checklist from the catalog, with no pack downloaded for it.
    await onRegion(elsewhere, [S.noPack]);
    await db.query(`INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $2, 3)`, [
      zone,
      S.onZone,
    ]);

    // The country pack, with one province offloaded.
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, region, taxon, applied_province_region_ids) VALUES ($1, $2, 'aves', $3)`,
      [PACK, COUNTRY, JSON.stringify([province])],
    );
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ($1, $2, 'fish')`, [ZONE_PACK, ZONE]);
    const packSpecies = [
      S.onCountry,
      S.hasPhoto,
      S.notWithheld,
      S.offloadedOnly,
      S.checkedRecently,
      S.checkedLongAgo,
      S.onProvince,
    ];
    for (const sid of packSpecies)
      await db.query(`INSERT INTO pack_species (pack_id, species_id) VALUES ($1, $2)`, [PACK, sid]);
    await db.query(`INSERT INTO pack_species (pack_id, species_id) VALUES ($1, $2)`, [ZONE_PACK, S.onZone]);
  });

  const selectedIds = async () =>
    (await selectWithheldPhotoSpecies(db, 100)).map((r) => r.id).filter((sid) => ALL.includes(sid));

  it("picks withheld, photoless species on a downloaded pack's region, applied provinces or sea zone", async () => {
    expect((await selectedIds()).sort()).toEqual([S.onCountry, S.checkedLongAgo, S.onZone, S.onProvince].sort());
  });

  it("puts species never tried first", async () => {
    const ids = await selectedIds();
    expect(ids.at(-1)).toBe(S.checkedLongAgo);
  });

  it("skips a species tried within the retry window, and picks it up again after it", async () => {
    await markPhotoChecked(S.onCountry, db);
    expect(await selectedIds()).not.toContain(S.onCountry);

    expect((await selectWithheldPhotoSpecies(db, 100, 0)).map((r) => r.id)).toContain(S.onCountry);
  });

  it("forgets a pack's species once the pack is gone", async () => {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    expect(await selectedIds()).toEqual([S.onZone]);
  });

  it("counts the attempts of the last day", async () => {
    const before = await attemptsInLastDay(db);
    await markPhotoChecked(S.onCountry, db);
    await markPhotoChecked(S.onZone, db);
    expect(await attemptsInLastDay(db)).toBe(before + 2);
  });

  it("stores a fetched photo with its credit and license, and never replaces one the species has", async () => {
    const photo = {
      photoUrl: "https://inaturalist-open-data.s3.amazonaws.com/photos/9/medium.jpg",
      credit: "(c) Someone, all rights reserved",
      license: "all-rights-reserved",
      displayPath: "/nonexistent/display.webp",
      thumbPath: "/nonexistent/thumb.webp",
    };
    expect(await persistMainPhotoIfMissing(S.onCountry, photo)).toBe(true);
    expect(await persistMainPhotoIfMissing(S.hasPhoto, photo)).toBe(false);

    const rows = await db.query(
      `SELECT id, reference_photo, reference_credit, reference_license, reference_display_path, photo_withheld
         FROM species WHERE id = ANY($1) ORDER BY id`,
      [[S.onCountry, S.hasPhoto]],
    );
    expect(rows.rows).toEqual([
      {
        id: S.onCountry,
        reference_photo: photo.photoUrl,
        reference_credit: photo.credit,
        reference_license: "all-rights-reserved",
        reference_display_path: photo.displayPath,
        // Still withheld from packs; the install just has its own copy now.
        photo_withheld: true,
      },
      {
        id: S.hasPhoto,
        reference_photo: "https://example.org/own.jpg",
        reference_credit: "Me",
        reference_license: "cc-by",
        reference_display_path: null,
        photo_withheld: true,
      },
    ]);
    expect(await selectedIds()).not.toContain(S.onCountry);
  });

  it("is on by default and can be turned off for the install", async () => {
    expect(await isWithheldPhotoFetchEnabled(db)).toBe(true);
    await setInstallSetting(db, FETCH_WITHHELD_PHOTOS_SETTING, false);
    expect(await isWithheldPhotoFetchEnabled(db)).toBe(false);
  });
});
