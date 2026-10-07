// Runs only with TEST_DATABASE_URL pointing at a disposable server: it creates and drops its own
// databases there (named lifer_migrate_test_*), and runs `npm run migrate`'s script against them.
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run migrate
// migrate.ts runs on import, so it's tested as the command it is, in a child process.
import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const pkgDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationFiles = readdirSync(path.join(pkgDir, "migrations")).filter((f) => f.endsWith(".sql"));

// Each test creates a database and runs the whole migration chain in a fresh `node --import tsx`
// process, two of them twice. That takes about a second on an idle machine and several under
// load (coverage, other suites), past vitest's 5 s default, so each test gets this instead.
const MIGRATE_TEST_TIMEOUT_MS = 60_000;

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
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: databaseUrl(dbName) }, timeout: 120_000 },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, output: stdout + stderr }),
    );
  });
}

describe.skipIf(!url)("migrate", () => {
  const admin = new pg.Pool({ connectionString: url });
  const created: string[] = [];

  async function freshDatabase(suffix: string): Promise<{ name: string; db: pg.Pool }> {
    const name = `lifer_migrate_test_${process.pid}_${suffix}`;
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${name}`);
    created.push(name);
    return { name, db: new pg.Pool({ connectionString: databaseUrl(name) }) };
  }

  afterAll(async () => {
    for (const name of created) await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  });

  it(
    "applies every migration once, and a second run applies none and changes nothing",
    async () => {
      const { name, db } = await freshDatabase("rerun");
      try {
        const first = await migrate(name);
        expect(first.code, first.output).toBe(0);
        expect(first.output).toContain(`Done. ${migrationFiles.length} migration(s) applied, 0 already up to date.`);
        const applied = await db.query<{ filename: string; at: string }>(
          `SELECT filename, applied_at::text AS at FROM schema_migrations ORDER BY filename`,
        );
        expect(applied.rows.map((r) => r.filename)).toEqual([...migrationFiles].sort());

        const second = await migrate(name);
        expect(second.code, second.output).toBe(0);
        expect(second.output).toContain(`Done. 0 migration(s) applied, ${migrationFiles.length} already up to date.`);
        const after = await db.query(
          `SELECT filename, applied_at::text AS at FROM schema_migrations ORDER BY filename`,
        );
        expect(after.rows).toEqual(applied.rows);
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );

  it(
    "lets two servers starting at once share the work without applying anything twice",
    async () => {
      const { name, db } = await freshDatabase("concurrent");
      try {
        const [a, b] = await Promise.all([migrate(name), migrate(name)]);
        expect(a.code, a.output).toBe(0);
        expect(b.code, b.output).toBe(0);
        const appliedBy = (out: string) => (out.match(/^apply /gm) ?? []).length;
        expect(appliedBy(a.output) + appliedBy(b.output)).toBe(migrationFiles.length);
        const rows = await db.query(
          `SELECT count(*)::int AS n, count(DISTINCT filename)::int AS d FROM schema_migrations`,
        );
        expect(rows.rows[0]).toEqual({ n: migrationFiles.length, d: migrationFiles.length });
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );

  it(
    "stops at a failing migration, rolls back all of it and records nothing for it",
    async () => {
      const { name, db } = await freshDatabase("failing");
      try {
        // The first migration creates species (and an extension) before regions, which is in the way.
        await db.query(`CREATE TABLE regions (id int)`);
        const res = await migrate(name);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain(`Migration ${migrationFiles.sort()[0]} failed:`);
        const species = await db.query(`SELECT to_regclass('public.species') AS t`);
        expect(species.rows[0].t).toBeNull();
        expect((await db.query(`SELECT count(*)::int AS n FROM schema_migrations`)).rows[0].n).toBe(0);
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );
});
