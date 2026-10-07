// Runs only with TEST_DATABASE_URL pointing at a disposable server: it creates and drops its own
// database (lifer_iucn129_test_*), applies migrations up to 128, writes pre-129 data, then 129.
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55611/lifer npx vitest run iucnMigration
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { normalizeIucnStatus } from "@lifer/shared";

const url = process.env.TEST_DATABASE_URL;
const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
const MIGRATION = "129_iucn_status_single_source.sql";

// Everything the SQL copy of normalizeIucnStatus must agree with it on.
const RAW = [
  "least concern",
  "Data Deficient",
  "endangered",
  "vulnerable",
  "near threatened",
  "critically endangered",
  "extinct",
  "extinct_in_wild",
  "extinct in the wild",
  "not evaluated",
  "conservation dependent",
  "LEAST_CONCERN",
  "Critically Endangered (Possibly Extinct)",
  "LR/lc",
  "lr/cd",
  "Near-Threatened",
  "LC",
  "NE",
  "Regionally Extinct",
  "lower risk",
  "S3",
];

// The test creates a database and replays every migration before 129 into it: about a second on
// an idle machine and several under load (coverage, other suites), past vitest's 5 s default.
const MIGRATION_TEST_TIMEOUT_MS = 60_000;

function databaseUrl(name: string): string {
  const u = new URL(url!);
  u.pathname = `/${name}`;
  return u.toString();
}

describe.skipIf(!url)(`migration ${MIGRATION}`, () => {
  const admin = new pg.Pool({ connectionString: url });
  const name = `lifer_iucn129_test_${process.pid}`;
  let db: pg.Pool;

  afterAll(async () => {
    await db?.end();
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it(
    "normalizes every legacy value like the shared mapping, moves Other Taxa statuses, and drops species.iucn_status",
    async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${name}`);
      db = new pg.Pool({ connectionString: databaseUrl(name) });
      const files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
      for (const f of files.filter((f) => f < MIGRATION))
        await db.query(readFileSync(path.join(migrationsDir, f), "utf8"));

      // Pre-129: catalog statuses as free text in species_traits, Other Taxa ones on species.
      for (const [i, raw] of RAW.entries()) {
        const sid = (
          await db.query<{ id: string }>(
            `INSERT INTO species (gbif_key, scientific_name, taxon_class) VALUES ($1, $2, 'aves') RETURNING id`,
            [1000 + i, `Zzmig raw${i}`],
          )
        ).rows[0].id;
        await db.query(
          `INSERT INTO species_traits (species_id, iucn_status, source_attribution) VALUES ($1, $2, 'test')`,
          [sid, raw],
        );
      }
      const other = (
        await db.query<{ id: string }>(
          `INSERT INTO species (gbif_key, scientific_name, taxon_class, is_other_taxa, iucn_status) VALUES (-5, 'Zzmig other', 'insecta', true, 'Vulnerable') RETURNING id`,
        )
      ).rows[0].id;
      const otherJunk = (
        await db.query<{ id: string }>(
          `INSERT INTO species (gbif_key, scientific_name, taxon_class, is_other_taxa, iucn_status) VALUES (-6, 'Zzmig junk', 'insecta', true, 'G4') RETURNING id`,
        )
      ).rows[0].id;

      await db.query("BEGIN");
      await db.query(readFileSync(path.join(migrationsDir, MIGRATION), "utf8"));
      await db.query("COMMIT");

      const after = await db.query<{ name: string; iucn_status: string | null; iucn_source: string | null }>(
        `SELECT s.scientific_name AS name, t.iucn_status, t.iucn_source FROM species s JOIN species_traits t ON t.species_id = s.id
       WHERE s.scientific_name LIKE 'Zzmig raw%'`,
      );
      const byName = new Map(after.rows.map((r) => [r.name, r]));
      for (const [i, raw] of RAW.entries()) {
        const row = byName.get(`Zzmig raw${i}`)!;
        expect(row.iucn_status, raw).toBe(normalizeIucnStatus(raw));
        expect(row.iucn_source, raw).toBe(normalizeIucnStatus(raw) ? "wikidata" : null);
      }

      const moved = await db.query(
        `SELECT species_id, iucn_status, iucn_source, source_attribution FROM species_traits WHERE species_id = ANY($1)`,
        [[other, otherJunk]],
      );
      expect(moved.rows).toEqual([
        { species_id: other, iucn_status: "VU", iucn_source: "inaturalist", source_attribution: "iNaturalist" },
      ]);

      const column = await db.query(
        `SELECT 1 FROM information_schema.columns WHERE table_name = 'species' AND column_name = 'iucn_status'`,
      );
      expect(column.rowCount).toBe(0);
      await expect(db.query(`UPDATE species_traits SET iucn_status = 'Least Concern'`)).rejects.toThrow(
        /species_traits_iucn_status_code/,
      );
      await expect(db.query(`UPDATE species_traits SET iucn_source = 'gbif'`)).rejects.toThrow(
        /species_traits_iucn_source_known/,
      );
    },
    MIGRATION_TEST_TIMEOUT_MS,
  );
});
