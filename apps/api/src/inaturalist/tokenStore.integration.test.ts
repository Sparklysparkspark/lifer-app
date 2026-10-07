// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Linked iNaturalist accounts' tokens are stored encrypted; rows from before that are encrypted at
// startup or on first read.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000651";

describe.skipIf(!url)("iNaturalist token storage", () => {
  let db: pg.Pool;
  let dataDir: string;
  let store: typeof import("./tokenStore.js");
  let box: typeof import("../lib/secretBox.js");

  const row = async () =>
    (await db.query(`SELECT access_token, refresh_token FROM user_inaturalist_accounts WHERE user_id = $1`, [USER]))
      .rows[0];
  const insertPlain = (access: string, refresh: string | null) =>
    db.query(
      `INSERT INTO user_inaturalist_accounts (user_id, access_token, refresh_token, inat_user_id, inat_username)
       VALUES ($1, $2, $3, '42', 'naturalist') ON CONFLICT (user_id) DO UPDATE SET access_token = $2, refresh_token = $3`,
      [USER, access, refresh],
    );

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-tokens-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    db = new pg.Pool({ connectionString: url });
    store = await import("./tokenStore.js");
    box = await import("../lib/secretBox.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'inat-tokens@test', 'x')`, [USER]);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("stores both tokens encrypted and reads them back", async () => {
    await store.saveInatAccount({
      userId: USER,
      accessToken: "access-abc",
      refreshToken: "refresh-xyz",
      inatUserId: "42",
      inatUsername: "naturalist",
    });
    const stored = await row();
    expect(stored.access_token).toMatch(/^lifer-enc:v1:/);
    expect(stored.refresh_token).toMatch(/^lifer-enc:v1:/);
    expect(JSON.stringify(stored)).not.toMatch(/access-abc|refresh-xyz/);
    expect(await store.loadInatAccount(USER)).toEqual({ accessToken: "access-abc", inatUsername: "naturalist" });
    // The two tokens can't be swapped for each other.
    expect(() => box.secretBox.decrypt(stored.refresh_token, box.SECRET_CONTEXT.inatAccessToken)).toThrow(
      box.SecretUnavailableError,
    );
  });

  it("encrypts a plain-text row from an older version on first read", async () => {
    await insertPlain("old-access", null);
    expect(await store.loadInatAccount(USER)).toEqual({ accessToken: "old-access", inatUsername: "naturalist" });
    expect((await row()).access_token).toMatch(/^lifer-enc:v1:/);
    expect(await store.loadInatAccount(USER)).toEqual({ accessToken: "old-access", inatUsername: "naturalist" });
  });

  it("encrypts plain-text rows at startup, refresh token included", async () => {
    await insertPlain("old-access-2", "old-refresh-2");
    expect(await store.encryptStoredInatTokens()).toBeGreaterThanOrEqual(1);
    const stored = await row();
    expect(box.secretBox.decrypt(stored.access_token, box.SECRET_CONTEXT.inatAccessToken)).toBe("old-access-2");
    expect(box.secretBox.decrypt(stored.refresh_token, box.SECRET_CONTEXT.inatRefreshToken)).toBe("old-refresh-2");
    // Nothing left to do the second time.
    expect(await store.encryptStoredInatTokens()).toBe(0);
  });

  it("treats an account whose tokens can't be decrypted as not linked", async () => {
    await insertPlain(box.secretBox.encrypt("x", "some other purpose"), null);
    expect(await store.loadInatAccount(USER)).toBeNull();
  });
});
