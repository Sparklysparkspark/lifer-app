// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Share link tokens are stored as their sha256 plus an encrypted owner's copy, never as plain text
// (migration 132). Links handed out before that keep working.
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000641";
const SESSION = "lifer_test_share_token_storage_641";
const MIGRATION = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/data-pipeline/migrations/132_share_link_token_hash.sql",
);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe.skipIf(!url)("share link token storage", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let albumId: string;

  const owner = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: SESSION } });
  const visit = (route: string) => app.inject({ method: "GET", url: route });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-share-tokens-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { albumShareRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'share-tokens@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(SESSION),
      OWNER,
    ]);
    albumId = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Tokens') RETURNING id`, [OWNER])
    ).rows[0].id;

    app = Fastify();
    await app.register(cookie);
    await app.register(albumShareRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("stores a new link's token as a hash and an encrypted copy only", async () => {
    const created = await owner("POST", `/api/albums/${albumId}/shares`, {});
    const { id, token } = created.json() as { id: string; token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const row = (await db.query(`SELECT token, token_hash, token_encrypted FROM shared_links WHERE id = $1`, [id]))
      .rows[0];
    expect(row.token).toBeNull();
    expect(row.token_hash).toBe(sha256(token));
    expect(row.token_encrypted).toMatch(/^lifer-enc:v1:/);
    expect(JSON.stringify(row)).not.toContain(token);

    expect((await visit(`/api/share/${token}`)).json()).toMatchObject({ title: "Tokens" });
    // The owner can still copy it from the list.
    const list = (await owner("GET", `/api/albums/${albumId}/shares`)).json() as {
      shares: Array<{ id: string; token: string }>;
    };
    expect(list.shares.find((s) => s.id === id)?.token).toBe(token);
    // A wrong token, or the stored hash itself, opens nothing.
    expect((await visit(`/api/share/${token}x`)).statusCode).toBe(404);
    expect((await visit(`/api/share/${row.token_hash}`)).statusCode).toBe(404);
  });

  it("keeps a link from before migration 132 working, and encrypts its plain copy at startup", async () => {
    const legacyToken = "legacy-share-token-from-an-older-version";
    const { id } = (
      await db.query<{ id: string }>(
        `INSERT INTO shared_links (album_id, token, token_hash) VALUES ($1, $2, 'pending') RETURNING id`,
        [albumId, legacyToken],
      )
    ).rows[0];
    // Hash it with the migration's own statement, as an upgrade does.
    const update = readFileSync(MIGRATION, "utf8")
      .split("\n")
      .find((l) => l.startsWith("UPDATE shared_links SET token_hash"))!
      .replace(/;$/, "");
    await db.query(`${update} WHERE id = $1`, [id]);

    expect((await visit(`/api/share/${legacyToken}`)).statusCode).toBe(200);

    const { encryptStoredShareTokens } = await import("./routes.js");
    expect(await encryptStoredShareTokens()).toBeGreaterThanOrEqual(1);
    const row = (await db.query(`SELECT token, token_encrypted FROM shared_links WHERE id = $1`, [id])).rows[0];
    expect(row.token).toBeNull();
    expect(row.token_encrypted).toMatch(/^lifer-enc:v1:/);

    expect((await visit(`/api/share/${legacyToken}`)).statusCode).toBe(200);
    const list = (await owner("GET", `/api/albums/${albumId}/shares`)).json() as {
      shares: Array<{ id: string; token: string }>;
    };
    expect(list.shares.find((s) => s.id === id)?.token).toBe(legacyToken);
  });

  it("still serves a link whose owner's copy can't be decrypted, and shows it as unavailable", async () => {
    const created = (await owner("POST", `/api/albums/${albumId}/shares`, {})).json() as { id: string; token: string };
    const { secretBox } = await import("../lib/secretBox.js");
    // Encrypted for another purpose: stands in for a copy under a lost key.
    await db.query(`UPDATE shared_links SET token_encrypted = $2 WHERE id = $1`, [
      created.id,
      secretBox.encrypt(created.token, "other"),
    ]);
    const list = (await owner("GET", `/api/albums/${albumId}/shares`)).json() as {
      shares: Array<{ id: string; token: string | null }>;
    };
    expect(list.shares.find((s) => s.id === created.id)?.token).toBeNull();
    expect((await visit(`/api/share/${created.token}`)).statusCode).toBe(200);
  });
});
