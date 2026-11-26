// Runs only with TEST_DATABASE_URL pointing at a migrated test database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run nestedPackCopies
// A pack once matched a province named like its country (Belize District in Belize) as the
// country, and built copies of every province inside it. Startup folds those copies back, and the
// pack lookup now only matches a continent's child.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const id = (n: number) => `ffffffff-0000-4000-8000-0000000001${String(n).padStart(2, "0")}`;
// Ids chosen so the same-named province sorts before its country, as Belize District did.
const WORLD = id(90);
const CONTINENT = id(91);
const COUNTRY = id(92);
const PROVINCE = id(10); // "Nestland", like Belize District: same name as the country
const CAYO = id(93);
const COPY_ROOT = id(94); // the pack's copy of the country, inside PROVINCE
const COPY_PROVINCE = id(95);
const COPY_CAYO = id(96);
const REAL_SUBPLACE = id(97); // a real place named like the country inside a province, own code
const REGIONS = [COPY_PROVINCE, COPY_CAYO, COPY_ROOT, REAL_SUBPLACE, CAYO, PROVINCE, COUNTRY, CONTINENT, WORLD];
const LAND = id(80);
const SEA = id(81);
const SPECIES = [LAND, SEA];

describe.skipIf(!url)("province copies nested under a same-named province", () => {
  let db: pg.Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    for (const [sid, key, name] of [
      [LAND, 910911, "Nestus terrae"],
      [SEA, 910912, "Nestus maris"],
    ] as const)
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'aves') ON CONFLICT (id) DO NOTHING`,
        [sid, key, name],
      );
    const add = (rid: string, name: string, parent: string | null, code: string | null) =>
      db.query(`INSERT INTO regions (id, name, parent_id, ebird_region_code) VALUES ($1, $2, $3, $4)`, [
        rid,
        name,
        parent,
        code,
      ]);
    await add(WORLD, "Nest World", null, null);
    await add(CONTINENT, "Nest Continent", WORLD, null);
    await add(COUNTRY, "Nestland", CONTINENT, null); // no codes, like Belize
    await add(PROVINCE, "Nestland", COUNTRY, "ZZ-NL");
    await add(CAYO, "Nest Cayo", COUNTRY, "ZZ-NC");
    await add(COPY_ROOT, "Nestland", PROVINCE, "ZZ-NL");
    await add(COPY_PROVINCE, "Nestland", COPY_ROOT, "ZZ-NL");
    await add(COPY_CAYO, "Nest Cayo", COPY_ROOT, "ZZ-NC");
    await add(REAL_SUBPLACE, "Nestland", CAYO, "ZZ-NC-NL");
    // The real provinces list land birds; the copies got only the sea pack's species.
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $5), ($2, $5), ($3, $6), ($4, $6)`, [
      PROVINCE,
      CAYO,
      COPY_PROVINCE,
      COPY_CAYO,
      LAND,
      SEA,
    ]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM region_species WHERE region_id = ANY($1)`, [REGIONS]);
    for (const rid of REGIONS) await db.query(`DELETE FROM regions WHERE id = $1`, [rid]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("matches a pack named after the country to the country, not its same-named province", async () => {
    const { packRegionIdSql } = await import("@lifer/core/regions/regionTree.js");
    const res = await db.query<{ id: string }>(packRegionIdSql("$1"), ["Nestland"]);
    expect(res.rows[0]?.id).toBe(COUNTRY);
  });

  it("folds the copies into the real provinces, keeping their species and a real sub-place", async () => {
    const { foldNestedPackCopies } = await import("./catalogSeedUpdate.js");
    const { pool } = await import("@lifer/core/db.js");
    expect(await foldNestedPackCopies(pool)).toBe(3);

    const left = await db.query<{ id: string }>(`SELECT id FROM regions WHERE id = ANY($1)`, [REGIONS]);
    const ids = left.rows.map((r) => r.id);
    for (const copy of [COPY_ROOT, COPY_PROVINCE, COPY_CAYO]) expect(ids).not.toContain(copy);
    expect(ids).toContain(REAL_SUBPLACE);

    const species = async (rid: string) =>
      (await db.query<{ species_id: string }>(`SELECT species_id FROM region_species WHERE region_id = $1`, [rid])).rows
        .map((r) => r.species_id)
        .sort();
    expect(await species(PROVINCE)).toEqual([LAND, SEA].sort());
    expect(await species(CAYO)).toEqual([LAND, SEA].sort());

    // Nothing left to do on a second run.
    expect(await foldNestedPackCopies(pool)).toBe(0);
  });
});
