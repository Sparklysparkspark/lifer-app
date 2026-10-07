// A tiny species catalog for e2e runs, inserted straight into the scratch database. The API seeds
// the real catalog (about 200 MB, downloaded) only when `species` is empty, so having these rows
// skips that and keeps the run offline. The same data is published as region packs by the local
// mirror (mirror.ts), so onboarding downloads and applies real packs against it.
import type { ClientBase } from "pg";

export interface FixtureSpecies {
  scientificName: string;
  commonName: string;
  taxonClass: "aves" | "mammalia" | "amphibia";
  family: string;
  order: string;
  // Packs ship a reference photo for these. Without one, and with no traits row, a species counts
  // as obscure and is hidden while "Hide obscure species" is on (apps/api/src/species/obscurity.ts).
  hasPhoto: boolean;
  inProvince: boolean;
}

export const SPECIES = {
  chickadee: {
    scientificName: "Poecile atricapillus",
    commonName: "Black-capped Chickadee",
    taxonClass: "aves",
    family: "Paridae",
    order: "Passeriformes",
    hasPhoto: true,
    inProvince: true,
  },
  robin: {
    scientificName: "Turdus migratorius",
    commonName: "American Robin",
    taxonClass: "aves",
    family: "Turdidae",
    order: "Passeriformes",
    hasPhoto: true,
    inProvince: false,
  },
  moose: {
    scientificName: "Alces alces",
    commonName: "Moose",
    taxonClass: "mammalia",
    family: "Cervidae",
    order: "Artiodactyla",
    hasPhoto: true,
    inProvince: true,
  },
  woodFrog: {
    scientificName: "Lithobates sylvaticus",
    commonName: "Wood Frog",
    taxonClass: "amphibia",
    family: "Ranidae",
    order: "Anura",
    hasPhoto: false,
    inProvince: false,
  },
} satisfies Record<string, FixtureSpecies>;

export const ALL_SPECIES: FixtureSpecies[] = Object.values(SPECIES);
export const TAXA = [...new Set(ALL_SPECIES.map((s) => s.taxonClass))];

// The region tree the app expects: World, then continents, then countries (with ISO codes), then
// provinces (with subdivision codes). resolvePackRegionName tells levels apart by those codes.
export const COUNTRY = { name: "Canada", code: "CA" };
export const PROVINCE = { name: "British Columbia", code: "CA-BC" };
// A country the mirror publishes no pack for, so its checklist is never downloaded.
export const PACKLESS_COUNTRY = { name: "United States", code: "US" };
// Canada's nearby water. Sea zones have checklists (and packs) of their own; this one's is empty.
export const SEA_ZONE = { name: "Gulf of Alaska" };

// Matches the mirror's catalog manifest, so the app sees its catalog as up to date.
export const CATALOG_VERSION = 1;

export async function insertFixtureCatalog(db: ClientBase): Promise<void> {
  await db.query("BEGIN");
  try {
    // gbif_key is unique and required. These are made up: nothing looks them up in an offline run.
    for (const [i, s] of ALL_SPECIES.entries()) {
      await db.query(
        `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, family, taxon_order, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [990_000_001 + i, s.scientificName, s.commonName, s.taxonClass, s.family, s.order, i + 1],
      );
    }

    const world = await db.query<{ id: string }>(
      `INSERT INTO regions (name, has_children) VALUES ('World', true) RETURNING id`,
    );
    const continent = await db.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, has_children) VALUES ('North America', $1, true) RETURNING id`,
      [world.rows[0].id],
    );
    const country = await db.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, has_children)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [COUNTRY.name, continent.rows[0].id, [COUNTRY.code], COUNTRY.code],
    );
    await db.query(`INSERT INTO regions (name, parent_id, external_codes, ebird_region_code) VALUES ($1, $2, $3, $4)`, [
      PACKLESS_COUNTRY.name,
      continent.rows[0].id,
      [PACKLESS_COUNTRY.code],
      PACKLESS_COUNTRY.code,
    ]);
    const seaZone = await db.query<{ id: string }>(
      `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
       VALUES ($1, 'POLYGON((-150 55,-135 55,-135 60,-150 60,-150 55))', -150, 55, -135, 60) RETURNING id`,
      [SEA_ZONE.name],
    );
    await db.query(`UPDATE regions SET nearby_sea_zone_ids = $1 WHERE id = $2`, [
      [seaZone.rows[0].id],
      country.rows[0].id,
    ]);
    const province = await db.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [PROVINCE.name, country.rows[0].id, [PROVINCE.code], PROVINCE.code],
    );

    // Checklist rows. The collection only lists a taxon once its pack is downloaded, which the
    // first-run spec does through onboarding.
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_tier)
       SELECT $1, id, 'common' FROM species WHERE scientific_name = ANY($2)`,
      [country.rows[0].id, ALL_SPECIES.map((s) => s.scientificName)],
    );
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_tier)
       SELECT $1, id, 'common' FROM species WHERE scientific_name = ANY($2)`,
      [province.rows[0].id, ALL_SPECIES.filter((s) => s.inProvince).map((s) => s.scientificName)],
    );

    await db.query(`INSERT INTO install_settings (key, value) VALUES ('catalog_seed_version', $1)`, [
      JSON.stringify(CATALOG_VERSION),
    ]);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK").catch(() => {});
    throw err;
  }
}
