// Rehearses a catalog update the way an existing install meets it: loads the PUBLISHED seed into
// an empty scratch database, then merges the NEW seed over it with applyCatalogSeedFile, and checks
// the result. Never point it at a real database: it refuses any database not named *scratch*.
//
//   docker exec lifer-app-postgres-1 createdb -U lifer lifer_seedupdate_scratch
//   DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_seedupdate_scratch npm run migrate
//   DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_seedupdate_scratch npx tsx apps/api/scripts/rehearse-catalog-update.ts
//   docker exec lifer-app-postgres-1 dropdb -U lifer lifer_seedupdate_scratch
//
// --base and --next take other seed files. A second run skips the base load and merges again,
// which must change nothing.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pool } from "@lifer/core/db.js";
import { applyCatalogSeedFile } from "../src/species/catalogSeedUpdate.js";
import { ensureRegionRollup } from "../src/regions/rollup.js";
import { whenSpeciesSearchReady } from "../src/species/search.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const { values: args } = parseArgs({
  options: {
    base: {
      type: "string",
      default: path.join(REPO, "apps/desktop/src-tauri/resources-staging/catalog-seed/lifer-catalog-seed.sql.gz"),
    },
    next: {
      type: "string",
      default: path.join(REPO, "packages/data-pipeline/data/build/catalog-seed/lifer-catalog-seed.sql.gz"),
    },
  },
});

const dbName = new URL(process.env.DATABASE_URL ?? "postgres://x/none").pathname.slice(1);
if (!dbName.includes("scratch")) {
  console.error(`Refusing to run against "${dbName}": DATABASE_URL must name a *scratch* database.`);
  process.exit(1);
}

const noProgress = { update: () => {}, throwIfCancelled: () => {} };
const one = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows[0];
const count = async (table: string) => Number((await one(`SELECT count(*) AS n FROM ${table}`)).n);
const failures: string[] = [];
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const seconds = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

const TABLES = ["regions", "region_species", "region_species_hidden", "region_species_user_added", "gazetteer_places"];
const snapshot = async () => Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await count(t)])));

// A country's own checklist plus its provinces' and nearby sea zones', the way the app counts it.
const countrySpecies = (name: string, taxonClass: string) =>
  one(
    `WITH RECURSIVE c AS (SELECT id FROM regions WHERE name = $1
                            ORDER BY parent_id NULLS FIRST LIMIT 1),
       t(id) AS (SELECT id FROM c UNION SELECT r.id FROM regions r JOIN c ON r.home_country_id = c.id
                 UNION SELECT r.id FROM regions r JOIN t ON r.parent_id = t.id)
     SELECT
       (SELECT count(DISTINCT rs.species_id) FROM t JOIN region_species rs ON rs.region_id = t.id
          JOIN species s ON s.id = rs.species_id WHERE s.taxon_class = $2) AS land,
       (SELECT count(DISTINCT zs.species_id) FROM regions r JOIN c ON c.id = r.id
          JOIN sea_zone_species zs ON zs.sea_zone_id = ANY (r.nearby_sea_zone_ids)
          JOIN species s ON s.id = zs.species_id WHERE s.taxon_class = $2) AS sea,
       (SELECT count(DISTINCT x.species_id) FROM (
          SELECT rs.species_id FROM t JOIN region_species rs ON rs.region_id = t.id
          UNION SELECT zs.species_id FROM regions r JOIN c ON c.id = r.id
          JOIN sea_zone_species zs ON zs.sea_zone_id = ANY (r.nearby_sea_zone_ids)) x
          JOIN species s ON s.id = x.species_id WHERE s.taxon_class = $2) AS total`,
    [name, taxonClass],
  );

const USER = "5c4a7c11-0000-4000-8000-000000000001";
// Both copies of every province the published catalog lists twice.
const PAIRS = `SELECT a.id AS flat, b.id AS grouped FROM regions a
  JOIN regions g ON g.parent_id = a.parent_id JOIN regions b ON b.parent_id = g.id AND b.name = a.name
  WHERE NOT EXISTS (SELECT 1 FROM regions c WHERE c.parent_id IN (a.id, b.id))`;

// A user with data on both copies: a photo on each, a hidden species on one, the same own
// addition on both (one survives), and a tier on both copies for a few hundred of them.
async function addUserData() {
  await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'rehearsal@scratch', 'x')`, [USER]);
  const sp = (await one(`SELECT id FROM species ORDER BY id LIMIT 1`)).id;
  await pool.query(
    `INSERT INTO captures_all (user_id, species_id, fingerprint, region_id)
     SELECT $1, $2, 'rehearsal-' || x.id, x.id FROM (SELECT flat AS id FROM (${PAIRS}) p UNION ALL SELECT grouped FROM (${PAIRS}) p) x`,
    [USER, sp],
  );
  await pool.query(
    `INSERT INTO region_species_hidden (user_id, region_id, species_id) SELECT $1, grouped, $2 FROM (${PAIRS}) p`,
    [USER, sp],
  );
  await pool.query(
    `INSERT INTO region_species_user_added (user_id, region_id, species_id)
     SELECT $1, x.id, $2 FROM (SELECT flat AS id FROM (${PAIRS}) p UNION ALL SELECT grouped FROM (${PAIRS}) p) x`,
    [USER, sp],
  );
  await pool.query(
    `INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier)
     SELECT $1, x.id, $2, x.tier FROM (SELECT * FROM (${PAIRS}) p ORDER BY flat LIMIT 300) p,
       LATERAL (VALUES (p.flat, 'rare'), (p.grouped, 'common')) x(id, tier)`,
    [USER, sp],
  );
  const pairs = Number((await one(`SELECT count(*) AS n FROM (${PAIRS}) p`)).n);
  console.log(`Added a user's data to both copies of ${pairs} duplicated provinces`);
}

const userRows = async () =>
  one(
    `SELECT (SELECT count(*) FROM captures_all WHERE user_id = $1)::int AS captures,
            (SELECT count(*) FROM region_species_hidden WHERE user_id = $1)::int AS hidden,
            (SELECT count(*) FROM region_species_user_added WHERE user_id = $1)::int AS added,
            (SELECT count(DISTINCT region_id) FROM region_species_user_added WHERE user_id = $1)::int AS added_regions,
            (SELECT count(*) FROM user_tier_overrides WHERE user_id = $1)::int AS tiers`,
    [USER],
  );

async function main() {
  if ((await count("regions")) === 0) {
    const started = Date.now();
    console.log(`Loading the published seed ${args.base}`);
    await applyCatalogSeedFile(pool, args.base!, 1, noProgress);
    // The after-commit cleanup deletes the files these columns name: a seed's paths are not ours.
    await pool.query(`UPDATE species_reference_photos SET display_path = NULL, thumb_path = NULL`);
    await pool.query(`UPDATE species SET reference_display_path = NULL, reference_thumb_path = NULL`);
    console.log(`Published seed loaded in ${seconds(started)}`);
  }
  if (!(await one(`SELECT 1 AS x FROM users WHERE id = $1`, [USER]))) await addUserData();

  const before = await snapshot();
  const userBefore = await userRows();
  const fishBefore = await countrySpecies("Japan", "actinopterygii");
  const started = Date.now();
  console.log(`Merging the new seed ${args.next}`);
  const merged = await applyCatalogSeedFile(pool, args.next!, null, noProgress);
  console.log(`Merged in ${seconds(started)}`);
  const after = await snapshot();
  console.log("merge result:", merged);
  console.table(Object.fromEntries(TABLES.map((t) => [t, { before: before[t], after: after[t] }])));

  // Every column that holds a region id, FK or not, points at a region that exists.
  const fks = await pool.query<{ tbl: string; col: string }>(
    `SELECT c.conrelid::regclass::text AS tbl, a.attname AS col
       FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'regions'::regclass`,
  );
  const refs = [
    ...fks.rows,
    { tbl: "regions", col: "home_country_id" },
    { tbl: "regions", col: "populous_child_id" },
    { tbl: "gazetteer_places", col: "country_region_id" },
    { tbl: "gazetteer_places", col: "province_region_id" },
  ];
  for (const { tbl, col } of refs) {
    const orphans = await one(
      `SELECT count(*) AS n FROM ${tbl} x WHERE x.${col} IS NOT NULL AND NOT EXISTS (SELECT 1 FROM regions r WHERE r.id = x.${col})`,
    );
    check(Number(orphans.n) === 0, `${tbl}.${col}: every id is a region (${orphans.n} orphans)`);
  }
  const dupes = await one(
    `SELECT count(*) AS n FROM regions a JOIN regions b ON b.name = a.name AND b.id <> a.id
       JOIN regions g ON g.id = b.parent_id AND g.parent_id = a.parent_id AND g.id <> a.id
      WHERE NOT EXISTS (SELECT 1 FROM regions c WHERE c.parent_id = a.id)`,
  );
  check(Number(dupes.n) === 0, `no province is listed both under its country and under its group (${dupes.n})`);
  check(after.regions <= before.regions, `regions did not grow (${before.regions} -> ${after.regions})`);
  const userAfter = await userRows();
  console.log("user rows before:", userBefore, "after:", userAfter);
  check(userAfter.captures === userBefore.captures, "every photo kept");
  check(userAfter.hidden === userBefore.hidden, "hidden species kept");
  // Merged copies keep one addition each: as many as there were regions, one per region.
  check(userAfter.added === userAfter.added_regions, "own additions kept, one per region");
  check(
    merged.regionsFolded == null || userAfter.added === userBefore.added - merged.regionsFolded,
    "own additions: only the folded copies' repeats went",
  );
  check(merged.regionsFolded == null || userAfter.tiers === userBefore.tiers / 2, "tiers set on both copies keep one");

  for (const [country, taxonClass] of [
    ["Japan", "actinopterygii"],
    ["Japan", "aves"],
    ["Canada", "aves"],
    ["Canada", "actinopterygii"],
    ["Colombia", "aves"],
    ["Colombia", "actinopterygii"],
  ]) {
    const n = await countrySpecies(country, taxonClass);
    console.log(`${country} ${taxonClass}: land ${n.land}, sea ${n.sea}, total ${n.total}`);
  }
  const japanFish = Number((await countrySpecies("Japan", "actinopterygii")).total);
  check(
    japanFish > 4000 && japanFish < 6500,
    `Japan fish incl. sea zones around 5,000 (${japanFish}, was ${fishBefore.total})`,
  );
  const colombiaBirds = Number((await countrySpecies("Colombia", "aves")).total);
  check(colombiaBirds > 1700, `Colombia birds above 1,700 (${colombiaBirds})`);
  const canadaBirds = Number((await countrySpecies("Canada", "aves")).total);
  check(canadaBirds > 450 && canadaBirds < 900, `Canada birds between 450 and 900 (${canadaBirds})`);

  const rollupStarted = Date.now();
  await ensureRegionRollup();
  console.log(`Region rollup rebuilt in ${seconds(rollupStarted)} (${await count("region_species_rollup")} rows)`);

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exitCode = 1;
  } else console.log("\nAll checks passed");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await whenSpeciesSearchReady();
    await pool.end();
  });
