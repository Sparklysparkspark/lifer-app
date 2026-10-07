// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run collectionState
// A fresh install pointed at an existing library gets its archived, hidden, seen and target
// species, the user's own tiers and their checklist additions, back from the library's own record.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000110";
const SP = ["ffffffff-0000-4000-8000-0000000000a1", "ffffffff-0000-4000-8000-0000000000a2", "ffffffff-0000-4000-8000-0000000000a3", "ffffffff-0000-4000-8000-0000000000a4"];
const REGION = "ffffffff-0000-4000-8000-0000000000b1";
const ZONE = "ffffffff-0000-4000-8000-0000000000c1";

describe.skipIf(!url)("collection state record", () => {
  let db: pg.Pool;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-state-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(tmpdir(), `lifer-state-app-${process.pid}`);
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'state@test', 'x')`, [USER]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Stateland', '{ZZ-ST}') ON CONFLICT (id) DO NOTHING`, [REGION]);
    for (const [i, id] of SP.entries()) {
      await db.query(`INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves') ON CONFLICT (id) DO NOTHING`, [
        id,
        911000 + i,
        `Statea species${i}`,
        `State Bird ${i}`,
      ]);
    }
    await db.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2)`, [USER, SP[0]]);
    await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [USER, REGION, SP[1]]);
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [USER, SP[2]]);
    await db.query(`INSERT INTO user_species (user_id, species_id, is_target) VALUES ($1, $2, true)`, [USER, SP[3]]);
    await db.query(`INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier) VALUES ($1, $2, $3, 'rare'), ($1, NULL, $4, 'uncommon')`, [USER, REGION, SP[1], SP[2]]);
    await db.query(`INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [USER, REGION, SP[3]]);
    await db.query(
      `INSERT INTO sea_zones (id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
       VALUES ($1, 'Zzstate Sea', 'POLYGON((0 0,1 0,1 1,0 1,0 0))', 0, 0, 1, 1) ON CONFLICT (id) DO NOTHING`,
      [ZONE],
    );
    await db.query(`INSERT INTO sea_zone_species_user_added (user_id, sea_zone_id, species_id) VALUES ($1, $2, $3)`, [USER, ZONE, SP[0]]);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM sea_zones WHERE id = $1`, [ZONE]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("saves the state by name and brings it back on a fresh database", async () => {
    const { saveCollectionState, restoreCollectionState, collectionStatePath } = await import("./collectionState.js");
    await saveCollectionState(USER);
    const saved = JSON.parse(readFileSync(collectionStatePath(), "utf8"));
    expect(saved.users["state@test"]).toEqual({
      archived: ["Statea species0"],
      hiddenInRegions: [{ region: "ZZ-ST", species: "Statea species1" }],
      seen: ["Statea species2"],
      targets: ["Statea species3"],
      tierOverrides: [
        { region: "ZZ-ST", species: "Statea species1", tier: "rare" },
        { region: null, species: "Statea species2", tier: "uncommon" },
      ],
      addedToRegions: [{ region: "ZZ-ST", species: "Statea species3" }],
      addedToSeaZones: [{ seaZone: "Zzstate Sea", species: "Statea species0" }],
    });

    // A fresh install: same photos folder, none of this state in the database.
    await db.query(`DELETE FROM user_archived_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM region_species_hidden WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_tier_overrides WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM region_species_user_added WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sea_zone_species_user_added WHERE user_id = $1`, [USER]);

    expect(await restoreCollectionState(USER)).toEqual({ restored: 8, notFound: 0 });
    const counts = await db.query(
      `SELECT (SELECT count(*) FROM user_archived_species WHERE user_id = $1)::int AS archived,
              (SELECT count(*) FROM region_species_hidden WHERE user_id = $1)::int AS hidden,
              (SELECT count(*) FROM user_species WHERE user_id = $1 AND state = 'seen')::int AS seen,
              (SELECT count(*) FROM user_species WHERE user_id = $1 AND is_target)::int AS targets,
              (SELECT count(*) FROM user_tier_overrides WHERE user_id = $1)::int AS overrides,
              (SELECT count(*) FROM region_species_user_added WHERE user_id = $1)::int AS added,
              (SELECT count(*) FROM sea_zone_species_user_added WHERE user_id = $1)::int AS added_to_sea`,
      [USER],
    );
    expect(counts.rows[0]).toEqual({ archived: 1, hidden: 1, seen: 1, targets: 1, overrides: 2, added: 1, added_to_sea: 1 });

    // The database has its own state now, so a second restore leaves it alone.
    expect(await restoreCollectionState(USER)).toBeNull();
  });

  it("retries a startup restore that ran before the catalog was loaded", async () => {
    const { syncCollectionStateOnStartup, tryRestoreCollectionStateOnce } = await import("./collectionState.js");
    // The record from the first test is on disk; the database is fresh again.
    for (const table of ["user_archived_species", "region_species_hidden", "user_species", "user_tier_overrides", "region_species_user_added", "sea_zone_species_user_added"]) {
      await db.query(`DELETE FROM ${table} WHERE user_id = $1`, [USER]);
    }
    // A first Docker start: the catalog seed is still loading, so none of the names exist yet.
    await db.query(`UPDATE species SET scientific_name = 'Loading ' || scientific_name WHERE id = ANY($1)`, [SP]);
    try {
      await syncCollectionStateOnStartup();
    } finally {
      await db.query(`UPDATE species SET scientific_name = substr(scientific_name, 9) WHERE id = ANY($1)`, [SP]);
    }
    const archived = () => db.query(`SELECT 1 FROM user_archived_species WHERE user_id = $1`, [USER]).then((r) => r.rowCount);
    expect(await archived()).toBe(0);

    // The catalog has loaded; the user's next visit (/auth/me) brings the state back.
    tryRestoreCollectionStateOnce(USER);
    for (let i = 0; i < 50 && (await archived()) === 0; i++) await new Promise((r) => setTimeout(r, 50));
    expect(await archived()).toBe(1);
  });
});
