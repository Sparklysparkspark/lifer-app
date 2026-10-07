// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Share link input validation: the owner's routes refuse malformed bodies with a 400, and the
// public routes keep their answers (404 for a bad link or photo, 401 for any wrong password).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000611";
const NO_SUCH = "eeeeeeee-0000-4000-8000-0000000006fe";
const TOKEN = "lifer_test_share_routes_owner_611";
const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("share routes input validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;
  let albumId: string;

  const call = (method: "GET" | "POST" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });
  const visit = (method: "GET" | "POST", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-share-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { albumShareRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'share-routes@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    albumId = (
      await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Shared') RETURNING id`, [OWNER])
    ).rows[0].id;

    app = Fastify();
    await app.register(cookie);
    await app.register(albumShareRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      // Albums (and their share links) go with the user.
      await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
      await db.end();
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("creates a share link from the web app's body and refuses malformed ones", async () => {
    const create = (body: unknown) => call("POST", `/api/albums/${albumId}/shares`, body);
    expect((await create({ allowDownload: "yes" })).json()).toEqual(invalid(/allowDownload must be boolean/));
    expect((await create({ expiresAt: 5 })).statusCode).toBe(400);
    expect((await create({ public: true })).json()).toEqual(invalid(/unexpected field public/));
    expect((await create({ expiresAt: "not a date" })).json()).toEqual({ error: "expiresAt must be a valid date" });
    expect((await call("POST", `/api/albums/nope/shares`, {})).json()).toEqual({ error: "Album not found" });

    // AlbumDetailPage leaves password out when blank and sends expiresAt as null or an ISO time.
    const open = await create({ allowDownload: true, showMetadata: false, expiresAt: null });
    expect(open.statusCode).toBe(200);
    const locked = await create({
      password: "hunter22",
      allowDownload: false,
      showMetadata: true,
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(locked.json()).toMatchObject({ hasPassword: true });

    const list = await call("GET", `/api/albums/${albumId}/shares`);
    expect(list.json().shares).toHaveLength(2);
  });

  it("keeps the public answers for bad links, photos and passwords", async () => {
    const [share] = (await call("GET", `/api/albums/${albumId}/shares`)).json().shares as Array<{
      token: string;
      hasPassword: boolean;
    }>;
    expect(share.hasPassword).toBe(true);

    const bad = await visit("GET", `/api/share/${share.token}/photos/not-a-photo/thumb`);
    expect([bad.statusCode, bad.json()]).toEqual([404, { error: "Photo not found" }]);
    const deadLink = await visit("GET", `/api/share/no-such-token/photos/${NO_SUCH}/display?download=1`);
    expect([deadLink.statusCode, deadLink.json()]).toEqual([404, { error: "Not found" }]);

    for (const body of [undefined, {}, { password: 123 }, { password: "x", extra: 1 }, { password: "wrong" }]) {
      const res = await visit("POST", `/api/share/${share.token}/unlock`, body);
      expect([body, res.statusCode, res.json()]).toEqual([body, 401, { error: "Incorrect password" }]);
    }
    const unlocked = await visit("POST", `/api/share/${share.token}/unlock`, { password: "hunter22" });
    expect([unlocked.statusCode, unlocked.json()]).toEqual([200, { ok: true }]);
  });

  it("revokes by id, answering a malformed id like an unknown one", async () => {
    for (const id of ["nope", NO_SUCH]) {
      const res = await call("DELETE", `/api/shares/${id}`);
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Share not found" }]);
    }
    const [share] = (await call("GET", `/api/albums/${albumId}/shares`)).json().shares as Array<{ id: string }>;
    expect((await call("DELETE", `/api/shares/${share.id}`)).json()).toEqual({ ok: true });
  });
});
