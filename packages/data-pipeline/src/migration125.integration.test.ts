// Runs only with TEST_DATABASE_URL pointing at a disposable server: it creates and drops its own
// database there (named lifer_migrate125_test_*), and runs `npm run migrate`'s script against it.
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run migration125
// Migration 125 moves hand-imported (Other Taxa) species off the shared region_species table and
// onto each user's own checklist additions. Seeded the way installs from before it stored them,
// it should leave every user with exactly the hand imports they saw, and the catalog untouched.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION = "125_hand_imports_to_user_added.sql";

const ALICE = "12512500-0000-4000-8000-000000000001";
const BOB = "12512500-0000-4000-8000-000000000002";
const CONTINENT = "12512500-0000-4000-8000-0000000000a1";
const COUNTRY = "12512500-0000-4000-8000-0000000000a2";
const PROVINCE = "12512500-0000-4000-8000-0000000000a3";
// Hand imports: a beetle on the country and the province, a fern on the continent (the import
// window allowed any region then).
const BEETLE = "12512500-0000-4000-8000-0000000000b1";
const FERN = "12512500-0000-4000-8000-0000000000b2";
// A catalog bird on the country's checklist, and a catalog bird a hand import matched by GBIF
// key: its row looks like the catalog's own, so it stays.
const BIRD = "12512500-0000-4000-8000-0000000000c1";
const MATCHED = "12512500-0000-4000-8000-0000000000c2";

function databaseUrl(name: string): string {
  const u = new URL(url!);
  u.pathname = `/${name}`;
  return u.toString();
}

function migrate(dbName: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/migrate.ts"],
      // DATABASE_URL set explicitly, so the repo's .env can't point it anywhere else.
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: databaseUrl(dbName) }, timeout: 180_000 },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr }),
    );
  });
}

describe.skipIf(!url)("migration 125: hand imports become each user's checklist additions", () => {
  const admin = new pg.Pool({ connectionString: url });
  const name = `lifer_migrate125_test_${process.pid}`;
  let db: pg.Pool;
  let output = "";

  const additions = async () =>
    (
      await db.query<{ user_id: string; region_id: string; species_id: string }>(
        `SELECT user_id, region_id, species_id FROM region_species_user_added ORDER BY user_id, region_id, species_id`,
      )
    ).rows;
  const catalog = async () =>
    (
      await db.query<{ region_id: string; species_id: string }>(
        `SELECT region_id, species_id FROM region_species ORDER BY region_id, species_id`,
      )
    ).rows;

  beforeAll(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    const first = await migrate(name);
    expect(first.code, first.output).toBe(0);
    db = new pg.Pool({ connectionString: databaseUrl(name) });

    // Back to just before 125: the rows below are what a hand import used to write.
    await db.query(`DELETE FROM schema_migrations WHERE filename = $1`, [MIGRATION]);
    await db.query(
      `INSERT INTO users (id, email, password_hash) VALUES ($1, 'alice@test', 'x'), ($2, 'bob@test', 'x')`,
      [ALICE, BOB],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, external_codes) VALUES
         ($1, 'Mig Continent', NULL, '{}'), ($2, 'Migland', $1, '{ZZM}'), ($3, 'Mig North', $2, '{ZZM-N}')`,
      [CONTINENT, COUNTRY, PROVINCE],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, is_other_taxa) VALUES
         ($1, -912501, 'Migratus beetlei', 'insecta', true),
         ($2, -912502, 'Migratus fernus', 'plantae', true),
         ($3, 912503, 'Migratus avis', 'aves', false),
         ($4, 912504, 'Migratus matched', 'aves', false)`,
      [BEETLE, FERN, BIRD, MATCHED],
    );
    await db.query(
      `INSERT INTO region_species (region_id, species_id, is_vagrant, is_invasive) VALUES
         ($1, $4, false, false), ($2, $4, false, false), ($3, $5, false, false),
         ($1, $6, false, false), ($2, $7, false, false)`,
      [COUNTRY, PROVINCE, CONTINENT, BEETLE, FERN, BIRD, MATCHED],
    );
    // Bob had hidden the beetle in the province; Alice had already added it there herself.
    await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      BOB,
      PROVINCE,
      BEETLE,
    ]);
    await db.query(
      `INSERT INTO region_species_user_added (user_id, region_id, species_id, added_at) VALUES ($1, $2, $3, '2026-05-01T00:00:00Z')`,
      [ALICE, PROVINCE, BEETLE],
    );

    const second = await migrate(name);
    output = second.output;
    expect(second.code, second.output).toBe(0);
  }, 240_000);

  afterAll(async () => {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it("applies only migration 125", () => {
    expect(output).toContain(`apply ${MIGRATION}`);
    expect(output).toContain("Done. 1 migration(s) applied");
  });

  it("gives every user each hand import on every region it was on", async () => {
    const expected = [ALICE, BOB].flatMap((user) =>
      [
        [COUNTRY, BEETLE],
        [PROVINCE, BEETLE],
        [CONTINENT, FERN],
      ].map(([region, species]) => ({ user_id: user, region_id: region, species_id: species })),
    );
    const order = (r: { user_id: string; region_id: string; species_id: string }) =>
      `${r.user_id}${r.region_id}${r.species_id}`;
    expect(await additions()).toEqual(expected.sort((a, b) => (order(a) < order(b) ? -1 : 1)));
  });

  it("takes them off the shared catalog checklist and leaves the catalog's own rows", async () => {
    expect(await catalog()).toEqual(
      [
        { region_id: COUNTRY, species_id: BIRD },
        { region_id: PROVINCE, species_id: MATCHED },
      ].sort((a, b) => (a.region_id < b.region_id ? -1 : 1)),
    );
  });

  it("keeps an addition made before, and a hide", async () => {
    const before = await db.query<{ added_at: Date }>(
      `SELECT added_at FROM region_species_user_added WHERE user_id = $1 AND region_id = $2 AND species_id = $3`,
      [ALICE, PROVINCE, BEETLE],
    );
    expect(before.rows[0].added_at).toEqual(new Date("2026-05-01T00:00:00Z"));
    const hidden = await db.query(`SELECT 1 FROM region_species_hidden WHERE user_id = $1 AND species_id = $2`, [
      BOB,
      BEETLE,
    ]);
    expect(hidden.rowCount).toBe(1);
  });
});
