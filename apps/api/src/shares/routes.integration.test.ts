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
const NAME_KEY = `species_name_display:${OWNER}`;
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
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [NAME_KEY]);
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
      await db.query(`DELETE FROM install_settings WHERE key = $1`, [NAME_KEY]);
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

  it("keeps a link open to its earlier visitors after 50 foreign failures", async () => {
    const [share] = (await call("GET", `/api/albums/${albumId}/shares`)).json().shares as Array<{ token: string }>;
    const unlock = (password: string, remoteAddress: string, cookies: Record<string, string> = {}) =>
      app.inject({
        method: "POST",
        url: `/api/share/${share.token}/unlock`,
        payload: { password },
        remoteAddress,
        cookies,
      });

    const first = await unlock("hunter22", "198.51.100.1");
    const known = first.cookies.find((c) => c.name === "lifer_known_device");
    expect(known).toBeDefined();
    // The test above already spent a few of the link's 50.
    for (let i = 0; i < 50; i++) expect([401, 429]).toContain((await unlock("wrong", `203.0.113.${i + 1}`)).statusCode);

    expect((await unlock("hunter22", "198.51.100.2")).statusCode).toBe(429);
    expect((await unlock("hunter22", "198.51.100.2", { lifer_known_device: known!.value })).statusCode).toBe(200);
  });

  it("revokes by id, answering a malformed id like an unknown one", async () => {
    for (const id of ["nope", NO_SUCH]) {
      const res = await call("DELETE", `/api/shares/${id}`);
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Share not found" }]);
    }
    const [share] = (await call("GET", `/api/albums/${albumId}/shares`)).json().shares as Array<{ id: string }>;
    expect((await call("DELETE", `/api/shares/${share.id}`)).json()).toEqual({ ok: true });
  });

  it("names species the way the album's owner does, defaulting when unset or unreadable", async () => {
    const created = await call("POST", `/api/albums/${albumId}/shares`, { allowDownload: false });
    const { token } = created.json() as { token: string };
    const names = async () => (await visit("GET", `/api/share/${token}`)).json().speciesNames;
    const store = (value: unknown) =>
      db.query(
        `INSERT INTO install_settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [NAME_KEY, JSON.stringify(value)],
      );
    expect(await names()).toEqual({ main: "common", also: ["other"] });

    await store({ main: "scientific", also: ["ebird", "aba"] });
    expect(await names()).toEqual({ main: "scientific", also: ["aba", "ebird"] });
    await store({ main: "common", also: [] });
    expect(await names()).toEqual({ main: "common", also: [] });
    // A choice saved in the earlier single Second line shape still reads, mapped exactly.
    await store({ first: "scientific", second: "aba" });
    expect(await names()).toEqual({ main: "scientific", also: ["aba"] });

    for (const junk of [{ main: "scientific", also: ["<script>"] }, { main: "latin", also: [] }, "common"]) {
      await store(junk);
      expect(await names()).toEqual({ main: "common", also: ["other"] });
    }
  });
});

// Common Goldeneye is on eBird's list only in England: a link with places on names the place of its
// Canadian photo, and only the province and country of its English one or one with no region.
describe.skipIf(!url)("share output for a regionally sensitive species", () => {
  const SENS_OWNER = "eeeeeeee-0000-4000-8000-000000000612";
  const GOLDENEYE = "eeeeeeee-0000-4000-8000-000000000613";
  const R = {
    gb: "eeeeeeee-0000-4000-8000-000000000621",
    england: "eeeeeeee-0000-4000-8000-000000000622",
    kent: "eeeeeeee-0000-4000-8000-000000000623",
    ca: "eeeeeeee-0000-4000-8000-000000000624",
    ontario: "eeeeeeee-0000-4000-8000-000000000625",
  };
  const SENS_TOKEN = "lifer_test_share_routes_owner_612";
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const captureAt: Record<string, string> = {};
  let shareToken: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { albumShareRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [SENS_OWNER]);
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [`sensitive_species:${SENS_OWNER}`]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'share-sensitive@test', 'x')`, [
      SENS_OWNER,
    ]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(SENS_TOKEN),
      SENS_OWNER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910612, 'Bucephala clangula', 'Common Goldeneye', 'aves') ON CONFLICT (id) DO NOTHING`,
      [GOLDENEYE],
    );
    await db.query(
      `INSERT INTO regions (id, name, parent_id, ebird_region_code, external_codes) VALUES
         ($1, 'Test United Kingdom', NULL, 'GB', '{GBR}'), ($2, 'England', $1, NULL, '{}'),
         ($3, 'Kent', $2, 'GB-KEN', '{}'), ($4, 'Test Canada', NULL, 'CA', '{CAN}'), ($5, 'Ontario', $4, 'CA-ON', '{}')
       ON CONFLICT (id) DO NOTHING`,
      [R.gb, R.england, R.kent, R.ca, R.ontario],
    );
    const album = await db.query<{ id: string }>(
      `INSERT INTO albums (user_id, name) VALUES ($1, 'Ducks') RETURNING id`,
      [SENS_OWNER],
    );
    for (const [where, region] of [
      ["Kent", R.kent],
      ["Ontario", R.ontario],
      ["Unknown", null],
    ] as const) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, region_id, location_label, lat, lon)
         VALUES ($1, $2, $3, $4, $5, 51.1, 1.1) RETURNING id`,
        [SENS_OWNER, GOLDENEYE, `share-sensitive-${where}`, region, `${where} Marsh`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2)`, [
        album.rows[0].id,
        c.rows[0].id,
      ]);
      captureAt[where] = c.rows[0].id;
    }
    app = Fastify();
    await app.register(cookie);
    await app.register(albumShareRoutes, { prefix: "/api" });
    await app.ready();
    const share = await app.inject({
      method: "POST",
      url: `/api/albums/${album.rows[0].id}/shares`,
      payload: { showExactLocations: true },
      cookies: { [cookieName]: SENS_TOKEN },
    });
    shareToken = share.json().token;
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [SENS_OWNER]);
      await db.query(`DELETE FROM users WHERE id = $1`, [SENS_OWNER]);
      await db.query(`DELETE FROM regions WHERE id = ANY($1::uuid[])`, [[R.kent, R.ontario, R.england, R.gb, R.ca]]);
      await db.query(`DELETE FROM species WHERE id = $1`, [GOLDENEYE]);
      await db.end();
    }
  });

  it("names the place only where eBird doesn't list it, and never sends coordinates", async () => {
    const res = await app.inject({ method: "GET", url: `/api/share/${shareToken}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/51\.1|"lat"|"lon"/);
    const placeOf = (where: string) =>
      (res.json().items as Array<{ captureId: string; location: { place: string | null } }>).find(
        (i) => i.captureId === captureAt[where],
      )!.location.place;
    expect(placeOf("Kent")).toBeNull();
    expect(placeOf("Ontario")).toBe("Ontario Marsh");
    expect(placeOf("Unknown")).toBeNull();
  });
});
