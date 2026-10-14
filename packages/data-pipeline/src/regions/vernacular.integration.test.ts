// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer npx vitest run vernacular
// Migration 139's cleanup of frozen province copies inside vernacular groups, then the sync that
// nests the live provinces under their groups.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncVernacularRegions } from "./vernacular.js";
import type { CountryGrouping } from "../build/vernacular-regions-data.js";

const url = process.env.TEST_DATABASE_URL;
const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "139_vernacular_region_cleanup.sql",
);

const id = (n: number) => `13913900-0000-4000-8000-${String(n).padStart(12, "0")}`;
const WORLD = id(1);
const CONTINENT = id(2);
const COUNTRY = id(3);
const OLD_GROUP = id(4);
const USER = id(5);
const SPECIES = id(6);
const COUNTRY_NAME = "Vernacularia";

const square = (x: number) => ({
  type: "Feature",
  properties: {},
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x, 0],
        [x + 1, 0],
        [x + 1, 1],
        [x, 1],
        [x, 0],
      ],
    ],
  },
});

const groupings: Record<string, CountryGrouping> = {
  [COUNTRY_NAME]: {
    verdict: "grouping",
    groups: {
      "Old North": ["Alpha", "Beta"],
      // Named after one of its own provinces.
      Skopa: ["Skopa", "Gamma"],
      // A one-province wrapper named after it adds nothing.
      Delta: ["Delta"],
      "New East": ["Epsilon", "Nowhere"],
    },
    disconnects: ["Far Isle"],
  },
};

describe.skipIf(!url)("vernacular regions", () => {
  const db = new pg.Pool({ connectionString: url });
  const tree = async () =>
    (
      await db.query<{ name: string; parent: string; has_children: boolean; home: string | null }>(
        `WITH RECURSIVE t AS (SELECT id FROM regions WHERE id = $1 UNION ALL SELECT r.id FROM regions r JOIN t ON r.parent_id = t.id)
         SELECT r.name, p.name AS parent, r.has_children, h.name AS home
         FROM t JOIN regions r ON r.id = t.id JOIN regions p ON p.id = r.parent_id LEFT JOIN regions h ON h.id = r.home_country_id
         WHERE r.id <> $1 ORDER BY r.name, p.name`,
        [CONTINENT],
      )
    ).rows;
  const cleanup = async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(
      `WITH RECURSIVE t AS (SELECT id FROM regions WHERE id = $1 UNION ALL SELECT r.id FROM regions r JOIN t ON r.parent_id = t.id)
       DELETE FROM regions WHERE id IN (SELECT id FROM t)`,
      [WORLD],
    );
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  };

  beforeAll(async () => {
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'vernacular@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 139139, 'Vernacula testis', 'aves')`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, has_children) VALUES
         ($1, 'Vernacular World', NULL, true), ($2, 'Vernacular Continent', $1, true),
         ($3, $5, $2, true), ($4, 'Old North', $3, true)`,
      [WORLD, CONTINENT, COUNTRY, OLD_GROUP, COUNTRY_NAME],
    );
    // The live provinces, flat under the country as the province build leaves them.
    const names = ["Alpha", "Beta", "Gamma", "Skopa", "Delta", "Epsilon", "Zeta", "Far Isle"];
    for (const [i, name] of names.entries()) {
      await db.query(`INSERT INTO regions (id, name, parent_id, boundary_geojson) VALUES ($1, $2, $3, $4)`, [
        id(100 + i),
        name,
        COUNTRY,
        JSON.stringify(square(i)),
      ]);
    }
    // Frozen copies inside the old group, one with a user's photo, addition and hide.
    await db.query(`INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Alpha', $3), ($2, 'Beta', $3)`, [
      id(200),
      id(201),
      OLD_GROUP,
    ]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [id(200), SPECIES]);
    await db.query(
      `INSERT INTO captures_all (user_id, species_id, region_id, fingerprint) VALUES ($1, $2, $3, 'v139')`,
      [USER, SPECIES, id(200)],
    );
    await db.query(`INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      id(200),
      SPECIES,
    ]);
    await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      id(200),
      SPECIES,
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("migration 139 removes the frozen copies, moving their user data to the live provinces", async () => {
    // The column already exists in the migrated test database; everything after it is the cleanup.
    const cleanupSql = readFileSync(MIGRATION, "utf8").replace(
      /ALTER TABLE regions ADD COLUMN home_country_id uuid;/,
      "",
    );
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(cleanupSql);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const copies = await db.query(`SELECT id FROM regions WHERE id = ANY($1)`, [[id(200), id(201)]]);
    expect(copies.rows).toEqual([]);
    const capture = await db.query(`SELECT region_id FROM captures_all WHERE fingerprint = 'v139'`);
    expect(capture.rows).toEqual([{ region_id: id(100) }]);
    for (const table of ["region_species_user_added", "region_species_hidden"]) {
      const rows = await db.query(`SELECT region_id FROM ${table} WHERE user_id = $1`, [USER]);
      expect(rows.rows).toEqual([{ region_id: id(100) }]);
    }
    const group = await db.query(`SELECT has_children FROM regions WHERE id = $1`, [OLD_GROUP]);
    expect(group.rows).toEqual([{ has_children: false }]);
  });

  it("nests provinces under their groups, creating missing ones, and moves disconnects to the continent", async () => {
    const result = await syncVernacularRegions(db, true, groupings);
    expect(result).toMatchObject({ countries: 1, groupsCreated: 2, provincesNested: 5, disconnected: 1 });
    expect(result.missing).toEqual([`${COUNTRY_NAME} / New East: Nowhere`]);
    expect(await tree()).toEqual([
      { name: "Alpha", parent: "Old North", has_children: false, home: null },
      { name: "Beta", parent: "Old North", has_children: false, home: null },
      { name: "Delta", parent: COUNTRY_NAME, has_children: false, home: null },
      { name: "Epsilon", parent: "New East", has_children: false, home: null },
      { name: "Far Isle", parent: "Vernacular Continent", has_children: false, home: COUNTRY_NAME },
      { name: "Gamma", parent: "Skopa", has_children: false, home: null },
      { name: "New East", parent: COUNTRY_NAME, has_children: true, home: null },
      { name: "Old North", parent: COUNTRY_NAME, has_children: true, home: null },
      { name: "Skopa", parent: "Skopa", has_children: false, home: null },
      { name: "Skopa", parent: COUNTRY_NAME, has_children: true, home: null },
      { name: COUNTRY_NAME, parent: "Vernacular Continent", has_children: true, home: null },
      { name: "Zeta", parent: COUNTRY_NAME, has_children: false, home: null },
    ]);
    // The existing group was reused, and a created one covers its provinces for GBIF.
    const groups = await db.query<{ id: string; external_codes: string[] }>(
      `SELECT id, external_codes FROM regions WHERE parent_id = $1 AND name IN ('Old North', 'New East') ORDER BY name`,
      [COUNTRY],
    );
    expect(groups.rows[1].id).toBe(OLD_GROUP);
    expect(groups.rows[0].external_codes[0]).toMatch(/^POLYGON/);
  });

  it("changes nothing on a rerun, and nests a province the province build re-created flat", async () => {
    expect(await syncVernacularRegions(db, true, groupings)).toMatchObject({
      groupsCreated: 0,
      provincesNested: 0,
      provincesUngrouped: 0,
      disconnected: 0,
    });
    await db.query(`DELETE FROM regions WHERE name = 'Beta' AND parent_id = $1`, [OLD_GROUP]);
    await db.query(`INSERT INTO regions (name, parent_id) VALUES ('Beta', $1)`, [COUNTRY]);
    const preview = await syncVernacularRegions(db, false, groupings);
    expect(preview.provincesNested).toBe(1);
    const flat = await db.query(`SELECT 1 FROM regions WHERE name = 'Beta' AND parent_id = $1`, [COUNTRY]);
    expect(flat.rowCount).toBe(1);
    await syncVernacularRegions(db, true, groupings);
    const nested = await db.query(`SELECT parent_id FROM regions WHERE name = 'Beta'`);
    expect(nested.rows).toEqual([{ parent_id: OLD_GROUP }]);
  });

  it("takes a province out of a group the data no longer puts it in", async () => {
    const without = structuredClone(groupings);
    without[COUNTRY_NAME].groups!["Old North"] = ["Alpha", "Zeta"];
    const result = await syncVernacularRegions(db, true, without);
    expect(result).toMatchObject({ provincesNested: 1, provincesUngrouped: 1 });
    const parents = await db.query<{ name: string; parent_id: string }>(
      `SELECT name, parent_id FROM regions WHERE name IN ('Beta', 'Zeta') ORDER BY name`,
    );
    expect(parents.rows).toEqual([
      { name: "Beta", parent_id: COUNTRY },
      { name: "Zeta", parent_id: OLD_GROUP },
    ]);
  });
});
