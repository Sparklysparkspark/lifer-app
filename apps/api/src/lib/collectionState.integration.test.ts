// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run collectionState
// A fresh install pointed at an existing library gets its archived, hidden, seen and target
// species back from the library's own record.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000110";
const SP = ["ffffffff-0000-4000-8000-0000000000a1", "ffffffff-0000-4000-8000-0000000000a2", "ffffffff-0000-4000-8000-0000000000a3", "ffffffff-0000-4000-8000-0000000000a4"];
const REGION = "ffffffff-0000-4000-8000-0000000000b1";

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
  });

  afterAll(async () => {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.end();
    const { pool } = await import("../db.js");
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
    });

    // A fresh install: same photos folder, none of this state in the database.
    await db.query(`DELETE FROM user_archived_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM region_species_hidden WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);

    expect(await restoreCollectionState(USER)).toEqual({ restored: 4, notFound: 0 });
    const counts = await db.query(
      `SELECT (SELECT count(*) FROM user_archived_species WHERE user_id = $1)::int AS archived,
              (SELECT count(*) FROM region_species_hidden WHERE user_id = $1)::int AS hidden,
              (SELECT count(*) FROM user_species WHERE user_id = $1 AND state = 'seen')::int AS seen,
              (SELECT count(*) FROM user_species WHERE user_id = $1 AND is_target)::int AS targets`,
      [USER],
    );
    expect(counts.rows[0]).toEqual({ archived: 1, hidden: 1, seen: 1, targets: 1 });

    // The database has its own state now, so a second restore leaves it alone.
    expect(await restoreCollectionState(USER)).toBeNull();
  });
});
