import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import path from "node:path";
import { DATABASE_URL } from "@lifer/core/config.js";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

// Arbitrary constant key. Serialises concurrent migrate runs (two API processes starting at once).
const MIGRATION_LOCK_KEY = 4_310_103;

// Line endings normalised, so a Windows checkout hashes the same as the one that applied it.
const sha256 = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

// Enough to step back past a bad update or two without filling the disk.
const BACKUPS_KEPT = 3;

// Printed without a stack trace: the person starting Lifer reads it.
class PlainError extends Error {}

async function main() {
  const lockClient = await pool.connect();
  try {
    await lockClient.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK_KEY]);
    await runMigrations();
  } finally {
    await lockClient.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK_KEY]).catch(() => {});
    lockClient.release();
  }
  await pool.end();
}

async function runMigrations() {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
  );

  // Released migrations must never be edited: an applied one is never rerun, so the edit would
  // silently not reach this database. Rows from before this column get today's hash.
  await pool.query(`ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS sha256 text`);
  const applied = new Map(
    (
      await pool.query<{ filename: string; sha256: string | null }>(`SELECT filename, sha256 FROM schema_migrations`)
    ).rows.map((r) => [r.filename, r.sha256]),
  );
  const unhashed: Array<[string, string]> = [];

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  // A newer Lifer changed this database in ways this build can't know about; running on it could corrupt it.
  const known = new Set(files);
  const unknown = [...applied.keys()].filter((f) => !known.has(f));
  if (unknown.length > 0)
    throw new PlainError(
      `This database was updated by a newer version of Lifer, so this version can't open it safely. ` +
        `Install the latest Lifer and open it again. (Unknown updates: ${unknown.sort().join(", ")})`,
    );

  const pending = files.filter((f) => !applied.has(f));
  // A brand-new database has nothing worth backing up.
  if (pending.length > 0 && applied.size > 0) await backupBeforeMigrating(pending[0]!);

  let appliedCount = 0;
  for (const file of files) {
    const sql = readFileSync(path.join(migrationsDir, file), "utf-8");
    const hash = sha256(sql);
    if (applied.has(file)) {
      const recorded = applied.get(file);
      if (recorded == null) unhashed.push([file, hash]);
      else if (recorded !== hash)
        console.warn(
          `warn  ${file} changed after it was applied here; the change never ran (add a new migration instead)`,
        );
      console.log(`skip  ${file} (already applied)`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename, sha256) VALUES ($1, $2)`, [file, hash]);
      await client.query("COMMIT");
      console.log(`apply ${file}`);
      appliedCount++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
    } finally {
      client.release();
    }
  }

  if (unhashed.length > 0)
    await pool.query(
      `UPDATE schema_migrations m SET sha256 = u.sha256 FROM unnest($1::text[], $2::text[]) AS u(filename, sha256)
       WHERE m.filename = u.filename AND m.sha256 IS NULL`,
      [unhashed.map((u) => u[0]), unhashed.map((u) => u[1])],
    );

  console.log(`Done. ${appliedCount} migration(s) applied, ${files.length - appliedCount} already up to date.`);
}

// Desktop only: the app passes its bundled pg_dump and a folder in its app data. A server's database is
// backed up by whoever runs it (install/backup-restore.md), so there this only says so.
async function backupBeforeMigrating(firstPending: string) {
  const pgDump = process.env.LIFER_PG_DUMP;
  const dir = process.env.LIFER_DB_BACKUP_DIR;
  if (!pgDump || !dir) {
    console.log("note  no automatic backup before these migrations (back up your database yourself)");
    return;
  }
  mkdirSync(dir, { recursive: true });
  // A backup cut short by quitting the app never reaches the catch below, so its file stays behind.
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".dump.partial")))
    rmSync(path.join(dir, f), { force: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `lifer-${stamp}-before-${firstPending.replace(/\.sql$/, "")}.dump`);
  // The password goes in the environment, not the argument list other processes can read.
  const url = new URL(DATABASE_URL);
  const password = decodeURIComponent(url.password);
  url.password = "";
  try {
    await promisify(execFile)(
      pgDump,
      ["--format=custom", "--no-password", `--file=${file}.partial`, `--dbname=${url.toString()}`],
      { env: { ...process.env, PGPASSWORD: password }, maxBuffer: 16 * 1024 * 1024 },
    );
    renameSync(`${file}.partial`, file);
  } catch (err) {
    rmSync(`${file}.partial`, { force: true });
    const detail = ((err as { stderr?: string }).stderr || (err as Error).message).trim();
    throw new PlainError(`Couldn't back up the database before updating it, so nothing was changed. ${detail}`);
  }
  console.log(`backup ${file}`);

  // Names start with the time, so name order is age order.
  const old = readdirSync(dir)
    .filter((f) => /^lifer-.*\.dump$/.test(f))
    .sort()
    .slice(0, -BACKUPS_KEPT);
  for (const f of old) rmSync(path.join(dir, f), { force: true });
}

main().catch((err) => {
  console.error(err instanceof PlainError ? err.message : err);
  process.exit(1);
});
