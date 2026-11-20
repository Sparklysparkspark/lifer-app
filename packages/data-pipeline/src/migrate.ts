import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { pool } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "..", "migrations");

// Arbitrary constant key. Serialises concurrent migrate runs (two API processes starting at once).
const MIGRATION_LOCK_KEY = 4_310_103;

// Line endings normalised, so a Windows checkout hashes the same as the one that applied it.
const sha256 = (sql: string) => createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");

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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
