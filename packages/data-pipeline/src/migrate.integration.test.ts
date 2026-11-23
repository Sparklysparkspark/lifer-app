// Runs only with TEST_DATABASE_URL pointing at a disposable server: it creates and drops its own
// databases there (named lifer_migrate_test_*), and runs `npm run migrate`'s script against them.
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run migrate
// migrate.ts runs on import, so it's tested as the command it is, in a child process.
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
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

function migrate(dbName: string, env: Record<string, string> = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ["--import", "tsx", "src/migrate.ts"],
      // DATABASE_URL set explicitly, so the repo's .env can't point it anywhere else.
      { cwd: pkgDir, env: { ...process.env, DATABASE_URL: databaseUrl(dbName), ...env }, timeout: 120_000 },
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
  }, MIGRATE_TEST_TIMEOUT_MS);

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
    "records each migration's sha256 and warns when an applied one has changed",
    async () => {
      const { name, db } = await freshDatabase("checksum");
      try {
        expect((await migrate(name)).code).toBe(0);
        const [first, second] = [...migrationFiles].sort();
        const hashed = await db.query(
          `SELECT count(*)::int AS n FROM schema_migrations WHERE sha256 ~ '^[0-9a-f]{64}$'`,
        );
        expect(hashed.rows[0].n).toBe(migrationFiles.length);
        // An edited migration, and a row from before the column existed.
        await db.query(`UPDATE schema_migrations SET sha256 = 'edited' WHERE filename = $1`, [first]);
        await db.query(`UPDATE schema_migrations SET sha256 = NULL WHERE filename = $1`, [second]);
        const rerun = await migrate(name);
        expect(rerun.code, rerun.output).toBe(0);
        expect(rerun.output).toContain(`warn  ${first} changed after it was applied`);
        expect(rerun.output).not.toContain(`warn  ${second}`);
        const backfilled = await db.query(`SELECT sha256 FROM schema_migrations WHERE filename = $1`, [second]);
        expect(backfilled.rows[0].sha256).toMatch(/^[0-9a-f]{64}$/);
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
  // Stands in for pg_dump: records its arguments and password in the dump file, or fails.
  function backupEnv(fails = false): { env: Record<string, string>; dir: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), "lifer-migrate-backup-"));
    const pgDump = path.join(root, "pg_dump");
    writeFileSync(
      pgDump,
      fails
        ? `#!/bin/sh\necho "no room left" >&2\nexit 1\n`
        : `#!/bin/sh\nfor a; do case "$a" in --file=*) f="\${a#--file=}";; esac; done\nprintf '%s\\n' "$*" "$PGPASSWORD" > "$f"\n`,
    );
    chmodSync(pgDump, 0o755);
    tmpDirs.push(root);
    const dir = path.join(root, "backups");
    return { env: { LIFER_PG_DUMP: pgDump, LIFER_DB_BACKUP_DIR: dir }, dir };
  }
  const tmpDirs: string[] = [];
  afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
  const lastMigration = [...migrationFiles].sort().at(-1)!;

  it.skipIf(process.platform === "win32")(
    "backs up nothing for a new database",
    async () => {
      const { name, db } = await freshDatabase("fresh_backup");
      try {
        const { env, dir } = backupEnv();
        const res = await migrate(name, env);
        expect(res.code, res.output).toBe(0);
        expect(existsSync(dir)).toBe(false);
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === "win32")(
    "backs up an existing database before migrating it, keeping the newest three",
    async () => {
      const { name, db } = await freshDatabase("backup");
      try {
        expect((await migrate(name)).code).toBe(0);
        // Pretends the last migration is new to this database.
        await db.query(`DELETE FROM schema_migrations WHERE filename = $1`, [lastMigration]);
        const { env, dir } = backupEnv();
        // Older backups; names start with the time.
        mkdirSync(dir);
        for (const day of ["01", "02", "03"]) writeFileSync(path.join(dir, `lifer-2000-01-${day}-before-x.dump`), "");
        // Rerunning the real last migration may fail on its own changes; only the backup is checked.
        const res = await migrate(name, env);
        expect(res.output).toContain("backup ");

        const dumps = readdirSync(dir).sort();
        expect(dumps.slice(0, 2)).toEqual(["lifer-2000-01-02-before-x.dump", "lifer-2000-01-03-before-x.dump"]);
        expect(dumps).toHaveLength(3);
        const newest = dumps[2]!;
        expect(newest).toMatch(new RegExp(`^lifer-.*-before-${lastMigration.replace(/\.sql$/, "")}\\.dump$`));
        const [args, password] = readFileSync(path.join(dir, newest), "utf8").split("\n");
        const u = new URL(url!);
        expect(password).toBe(decodeURIComponent(u.password));
        expect(args).toContain("--format=custom");
        expect(args).toContain(`/${name}`);
        expect(args).toContain(`//${u.username}@`);
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );

  it.skipIf(process.platform === "win32")(
    "changes nothing when the backup fails",
    async () => {
      const { name, db } = await freshDatabase("backup_fails");
      try {
        expect((await migrate(name)).code).toBe(0);
        await db.query(`DELETE FROM schema_migrations WHERE filename = $1`, [lastMigration]);
        const { env, dir } = backupEnv(true);
        const res = await migrate(name, env);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("Couldn't back up the database before updating it, so nothing was changed.");
        expect(res.output).toContain("no room left");
        expect(res.output).not.toContain("apply ");
        expect(readdirSync(dir)).toEqual([]);
        const row = await db.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [lastMigration]);
        expect(row.rowCount).toBe(0);
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );

  it(
    "refuses a database a newer Lifer has migrated, before changing anything",
    async () => {
      const { name, db } = await freshDatabase("newer");
      try {
        expect((await migrate(name)).code).toBe(0);
        await db.query(`DELETE FROM schema_migrations WHERE filename = $1`, [lastMigration]);
        await db.query(`INSERT INTO schema_migrations (filename) VALUES ('999_from_a_newer_lifer.sql')`);
        const res = await migrate(name);
        expect(res.code).not.toBe(0);
        expect(res.output).toContain("This database was updated by a newer version of Lifer");
        expect(res.output).toContain("999_from_a_newer_lifer.sql");
        // Plain message, no stack trace.
        expect(res.output).not.toMatch(/^\s+at /m);
        const row = await db.query(`SELECT 1 FROM schema_migrations WHERE filename = $1`, [lastMigration]);
        expect(row.rowCount).toBe(0);
      } finally {
        await db.end();
      }
    },
    MIGRATE_TEST_TIMEOUT_MS,
  );
});
