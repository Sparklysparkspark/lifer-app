// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run speciesMerges
// applySpeciesMerges (migration 113): user data and gaps move to the survivor, chains resolve.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000411";
const REGION = "ffffffff-0000-4000-8000-0000000004b1";
const REGION2 = "ffffffff-0000-4000-8000-0000000004b2";
const NEW = "ffffffff-0000-4000-8000-000000000420";
const OLD = "ffffffff-0000-4000-8000-000000000421";
// Merged into OLD, so it has to follow the chain on to NEW.
const OLDER = "ffffffff-0000-4000-8000-000000000422";
const CAPTURE = "ffffffff-0000-4000-8000-000000000431";

describe.skipIf(!url)("applySpeciesMerges", () => {
  let db: pg.Pool;
  let hasTable = false;

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [CAPTURE]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species_merges WHERE old_species_id = ANY($1) OR new_species_id = ANY($1)`, [[NEW, OLD, OLDER]]).catch(() => {});
    await db.query(`DELETE FROM species_synonyms WHERE synonym_name LIKE 'Zzmerge%'`);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[NEW, OLD, OLDER]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[REGION, REGION2]]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    hasTable = ((await db.query(`SELECT 1 FROM pg_class WHERE relname = 'species_merges'`)).rowCount ?? 0) > 0;
    if (!hasTable) return;
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'merge@test', 'x')`, [USER]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzmergeland', '{ZZM}'), ($2, 'Zzmergeland Two', '{ZZN}')`, [REGION, REGION2]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, ebird_code, taxon_class, family) VALUES
         ($1, 914100, 'Zzmergea nova', NULL, NULL, 'aves', 'Zzmergidae'),
         ($2, 914101, 'Zzmergea vetus', 'Old Merge Bird', 'zzmold1', 'aves', 'Zzmergidae'),
         ($3, 914102, 'Zzmergea antiqua', 'Older Merge Bird', NULL, 'aves', NULL)`,
      [NEW, OLD, OLDER],
    );
    // The survivor is on REGION2 only; the old entry adds REGION, and its REGION2 row is dropped.
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_frequency, local_tier) VALUES
         ($1, $3, 5, 'uncommon'), ($2, $3, 9, 'common'), ($2, $4, 40, 'occasional')`,
      [REGION, REGION2, OLD, NEW],
    );
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Zzmergea vetusta')`, [OLD]);
    // Collected on the old entry, seen and targeted on the survivor.
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected, best_quality, is_target) VALUES
         ($1, $2, 'collected', '2020-01-01', 3, false), ($1, $3, 'seen', NULL, NULL, true), ($1, $4, 'collected', '2018-06-01', 5, false)`,
      [USER, OLD, NEW, OLDER],
    );
    await db.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2)`, [USER, OLD]);
    await db.query(`INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $2, $3, 'zzmerge-fp')`, [CAPTURE, USER, OLD]);
    await db.query(
      `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name) VALUES ($1, $2, 'Zzmergea vetus'), ($3, $1, 'Zzmergea antiqua')`,
      [OLD, NEW, OLDER],
    );
  });

  afterAll(async () => {
    if (hasTable) await cleanup();
    await db.end();
  });

  it("folds both old entries into the survivor with everything they carried", async (ctx) => {
    if (!hasTable) ctx.skip();
    const { applySpeciesMerges } = await import("./speciesMerges.js");
    const client = await db.connect();
    let result;
    try {
      await client.query("BEGIN");
      result = await applySpeciesMerges(client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(result.merged).toBe(2);
    expect(result.captures).toEqual([{ userId: USER, captureId: CAPTURE }]);

    const left = await db.query(`SELECT id FROM species WHERE id = ANY($1)`, [[NEW, OLD, OLDER]]);
    expect(left.rows.map((r) => r.id)).toEqual([NEW]);

    // Gaps filled from the old entry, the survivor's own name kept.
    const sp = (await db.query(`SELECT scientific_name, common_name, ebird_code FROM species WHERE id = $1`, [NEW])).rows[0];
    expect(sp).toEqual({ scientific_name: "Zzmergea nova", common_name: "Old Merge Bird", ebird_code: "zzmold1" });

    // REGION comes from the old entry; REGION2 keeps the survivor's own row.
    const rs = await db.query(`SELECT region_id, local_frequency::int AS f FROM region_species WHERE species_id = $1 ORDER BY region_id`, [NEW]);
    expect(rs.rows).toEqual([
      { region_id: REGION, f: 5 },
      { region_id: REGION2, f: 40 },
    ]);

    // Collected beats seen, the earliest date and best quality win, the target stays.
    const us = (await db.query(`SELECT state, first_collected::text AS fc, best_quality, is_target FROM user_species WHERE user_id = $1`, [USER])).rows;
    expect(us).toEqual([{ state: "collected", fc: "2018-06-01", best_quality: 5, is_target: true }]);

    expect((await db.query(`SELECT species_id FROM captures_all WHERE id = $1`, [CAPTURE])).rows[0].species_id).toBe(NEW);
    expect((await db.query(`SELECT species_id FROM user_archived_species WHERE user_id = $1`, [USER])).rows).toEqual([{ species_id: NEW }]);

    const syn = await db.query(`SELECT synonym_name FROM species_synonyms WHERE species_id = $1 ORDER BY synonym_name`, [NEW]);
    expect(syn.rows.map((r) => r.synonym_name)).toEqual(["Zzmergea antiqua", "Zzmergea vetus", "Zzmergea vetusta"]);

    // The chain's first link now points at the survivor instead of cascading away with OLD.
    const chain = await db.query(`SELECT old_species_id, new_species_id FROM species_merges WHERE old_species_id = ANY($1) ORDER BY old_species_id`, [[OLD, OLDER]]);
    expect(chain.rows).toEqual([
      { old_species_id: OLD, new_species_id: NEW },
      { old_species_id: OLDER, new_species_id: NEW },
    ]);
  });

  it("does nothing the second time", async (ctx) => {
    if (!hasTable) ctx.skip();
    const { applySpeciesMerges } = await import("./speciesMerges.js");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      expect((await applySpeciesMerges(client)).merged).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});
