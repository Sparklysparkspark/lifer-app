// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run speciesSplits
// Photos under a split species (migration 118) are re-filed by where they were taken.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000511";
const WORLD = "ffffffff-0000-4000-8000-0000000005a0";
const CONTINENT = "ffffffff-0000-4000-8000-0000000005a1";
const COUNTRY = "ffffffff-0000-4000-8000-0000000005a2";
// Only the first new species lives here.
const PROVINCE = "ffffffff-0000-4000-8000-0000000005a3";
// The old species is still listed here.
const PROVINCE_OLD = "ffffffff-0000-4000-8000-0000000005a4";
const PARENT = "ffffffff-0000-4000-8000-000000000520";
const DAUGHTER1 = "ffffffff-0000-4000-8000-000000000521";
const DAUGHTER2 = "ffffffff-0000-4000-8000-000000000522";
const CAP_SETTLED = "ffffffff-0000-4000-8000-000000000531";
const CAP_NO_PLACE = "ffffffff-0000-4000-8000-000000000532";
const CAP_STILL_VALID = "ffffffff-0000-4000-8000-000000000533";

describe.skipIf(!url)("species splits", () => {
  let db: pg.Pool;
  let hasTable = false;

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE id = ANY($1)`, [[CAP_SETTLED, CAP_NO_PLACE, CAP_STILL_VALID]]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[PARENT, DAUGHTER1, DAUGHTER2]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, PROVINCE_OLD]]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [COUNTRY]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [CONTINENT]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [WORLD]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    hasTable = ((await db.query(`SELECT 1 FROM pg_class WHERE relname = 'species_split_kept'`)).rowCount ?? 0) > 0;
    if (!hasTable) return;
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'split@test', 'x')`, [USER]);
    await db.query(`INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Zzsplit World', NULL)`, [WORLD]);
    await db.query(`INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Zzsplit Continent', $2)`, [
      CONTINENT,
      WORLD,
    ]);
    await db.query(`INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Zzsplitland', $2)`, [COUNTRY, CONTINENT]);
    await db.query(
      `INSERT INTO regions (id, name, parent_id) VALUES ($1, 'Zzsplit North', $3), ($2, 'Zzsplit South', $3)`,
      [PROVINCE, PROVINCE_OLD, COUNTRY],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 915100, 'Zzsplitia vetus', 'Old Split Lizard', 'squamata'),
         ($2, 915101, 'Zzsplitia borealis', 'Northern Split Lizard', 'squamata'),
         ($3, 915102, 'Zzsplitia australis', 'Southern Split Lizard', 'squamata')`,
      [PARENT, DAUGHTER1, DAUGHTER2],
    );
    await db.query(`INSERT INTO species_splits (parent_species_id, daughter_species_id) VALUES ($1, $2), ($1, $3)`, [
      PARENT,
      DAUGHTER1,
      DAUGHTER2,
    ]);
    // Continents list everything in them: this row must not count as "the old species is here".
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $3), ($2, $4), ($5, $4)`, [
      PROVINCE,
      PROVINCE_OLD,
      DAUGHTER1,
      PARENT,
      CONTINENT,
    ]);
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, region_id) VALUES
         ($1, $4, $5, 'zzsplit-1', $6), ($2, $4, $5, 'zzsplit-2', NULL), ($3, $4, $5, 'zzsplit-3', $7)`,
      [CAP_SETTLED, CAP_NO_PLACE, CAP_STILL_VALID, USER, PARENT, PROVINCE, PROVINCE_OLD],
    );
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [
      USER,
      PARENT,
    ]);
  });

  afterAll(async () => {
    if (hasTable) await cleanup();
    await db.end();
  });

  it("moves a photo to the one new species living where it was taken, and leaves the rest", async (ctx) => {
    if (!hasTable) ctx.skip();
    const { resolveSpeciesSplits } = await import("./speciesSplits.js");
    const result = await resolveSpeciesSplits(USER);
    expect(result).toEqual({ moved: 1, unresolved: 1 });
    const caps = await db.query<{ id: string; species_id: string }>(
      `SELECT id, species_id FROM captures_all WHERE id = ANY($1)`,
      [[CAP_SETTLED, CAP_NO_PLACE, CAP_STILL_VALID]],
    );
    const bySpecies = Object.fromEntries(caps.rows.map((r) => [r.id, r.species_id]));
    expect(bySpecies[CAP_SETTLED]).toBe(DAUGHTER1);
    expect(bySpecies[CAP_NO_PLACE]).toBe(PARENT);
    expect(bySpecies[CAP_STILL_VALID]).toBe(PARENT);
    const collected = await db.query(
      `SELECT 1 FROM user_species WHERE user_id = $1 AND species_id = $2 AND state = 'collected'`,
      [USER, DAUGHTER1],
    );
    expect(collected.rowCount).toBe(1);
  });

  it("marks the card as renamed and drops its tags until the owner picks", async (ctx) => {
    if (!hasTable) ctx.skip();
    const { markNameChanged, splitOptions } = await import("./speciesSplits.js");
    const [card] = await markNameChanged(USER, [{ speciesId: PARENT, tier: "legendary", isGhost: true }]);
    expect(card).toMatchObject({ nameChanged: true, tier: null, isGhost: false });
    const options = await splitOptions(USER, PARENT);
    expect(options.captureIds).toEqual([CAP_NO_PLACE]);
    expect(options.species.map((s) => s.id).sort()).toEqual([DAUGHTER1, DAUGHTER2].sort());
  });

  it("stops asking once the owner keeps the old name", async (ctx) => {
    if (!hasTable) ctx.skip();
    const { markNameChanged } = await import("./speciesSplits.js");
    await db.query(`INSERT INTO species_split_kept (capture_id) VALUES ($1)`, [CAP_NO_PLACE]);
    const [card] = await markNameChanged(USER, [{ speciesId: PARENT }]);
    expect(card.nameChanged).toBe(false);
  });
});
