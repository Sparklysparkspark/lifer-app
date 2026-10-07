// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55473/lifer npx vitest run restoredSeedVersion
// The desktop app restores its bundled catalog seed before the API starts, without recording its
// version. The API records it from the bundled manifest, so Settings doesn't offer the same
// catalog as an update.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const SPECIES = "eeeeeeee-0000-4000-8000-0000000005c1";

describe.skipIf(!url)("recording a restored seed's version", () => {
  let db: pg.Pool;
  let seedDir: string;
  let savedVersion: unknown;

  const recorded = async () =>
    (await db.query<{ value: number }>(`SELECT value FROM install_settings WHERE key = 'catalog_seed_version'`)).rows[0]
      ?.value ?? null;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    savedVersion = (await db.query(`SELECT value FROM install_settings WHERE key = 'catalog_seed_version'`)).rows[0]
      ?.value;
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 915801, 'Seeda restorata', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    seedDir = mkdtempSync(path.join(tmpdir(), "lifer-bundled-seed-"));
    writeFileSync(
      path.join(seedDir, "catalog-manifest.json"),
      JSON.stringify({ version: 1767225600000, publishedAt: "2026-01-01T00:00:00.000Z" }),
    );
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM install_settings WHERE key = 'catalog_seed_version'`);
  });

  afterAll(async () => {
    await db.query(`DELETE FROM install_settings WHERE key = 'catalog_seed_version'`);
    if (savedVersion !== undefined) {
      await db.query(`INSERT INTO install_settings (key, value) VALUES ('catalog_seed_version', $1)`, [
        JSON.stringify(savedVersion),
      ]);
    }
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(seedDir, { recursive: true, force: true });
  });

  it("records the bundled manifest's version for a database created in this Postgres run", async () => {
    const { recordRestoredSeedVersion } = await import("./restoredSeedVersion.js");
    const { pool } = await import("@lifer/core/db.js");
    expect(await recordRestoredSeedVersion(pool, [path.join(seedDir, "missing"), seedDir])).toBe(1767225600000);
    expect(await recorded()).toBe(1767225600000);
  });

  it("never replaces a recorded version", async () => {
    await db.query(`INSERT INTO install_settings (key, value) VALUES ('catalog_seed_version', '42')`);
    const { recordRestoredSeedVersion } = await import("./restoredSeedVersion.js");
    const { pool } = await import("@lifer/core/db.js");
    expect(await recordRestoredSeedVersion(pool, [seedDir])).toBeNull();
    expect(await recorded()).toBe(42);
  });

  it("leaves an older database alone: its catalog may predate the bundled seed", async () => {
    // An install from before this fix, opened by a newer app: migrated before this Postgres run.
    const first = await db.query<{ filename: string; applied_at: Date }>(
      `SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at LIMIT 1`,
    );
    await db.query(`UPDATE schema_migrations SET applied_at = '2000-01-01' WHERE filename = $1`, [
      first.rows[0].filename,
    ]);
    try {
      const { recordRestoredSeedVersion } = await import("./restoredSeedVersion.js");
      const { pool } = await import("@lifer/core/db.js");
      expect(await recordRestoredSeedVersion(pool, [seedDir])).toBeNull();
      expect(await recorded()).toBeNull();
    } finally {
      await db.query(`UPDATE schema_migrations SET applied_at = $2 WHERE filename = $1`, [
        first.rows[0].filename,
        first.rows[0].applied_at,
      ]);
    }
  });

  it("does nothing without a bundled manifest", async () => {
    const { recordRestoredSeedVersion } = await import("./restoredSeedVersion.js");
    const { pool } = await import("@lifer/core/db.js");
    expect(await recordRestoredSeedVersion(pool, [path.join(seedDir, "missing")])).toBeNull();
    expect(await recorded()).toBeNull();
  });
});
