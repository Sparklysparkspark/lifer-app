// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000901";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000090a";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000911";

describe.skipIf(!url)("delete local library", () => {
  let db: pg.Pool;
  let dataDir: string;
  let deleteLibraryRows: typeof import("./deleteLocalLibrary.js").deleteLibraryRows;

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }
  async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-delete-library-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = dataDir;
    db = new pg.Pool({ connectionString: url });
    ({ deleteLibraryRows } = await import("./deleteLocalLibrary.js"));
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'delete-library@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zzdelete testus', 'Delete Bird', 'aves', 990001)`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, origin) VALUES ($1, $2, $3, 'delete-a', 'local')`,
      [CAPTURE, USER, SPECIES],
    );
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps everything while a capture is unpushed, then deletes the rows and the mirror cursor", async () => {
    await db.query(
      `INSERT INTO install_settings (key, value) VALUES ('mirror_cursor', '{}') ON CONFLICT (key) DO NOTHING`,
    );
    expect(await inTransaction((c) => deleteLibraryRows(c, USER))).toBe(1);
    expect((await db.query(`SELECT 1 FROM captures_all WHERE id = $1`, [CAPTURE])).rowCount).toBe(1);

    await db.query(`UPDATE captures_all SET pushed_at = updated_at WHERE id = $1`, [CAPTURE]);
    expect(await inTransaction((c) => deleteLibraryRows(c, USER))).toBe(0);
    expect((await db.query(`SELECT 1 FROM captures_all WHERE id = $1`, [CAPTURE])).rowCount).toBe(0);
    expect((await db.query(`SELECT 1 FROM install_settings WHERE key = 'mirror_cursor'`)).rowCount).toBe(0);
  });
});
