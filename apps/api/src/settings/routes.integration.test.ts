// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Settings routes on a server install: each one checks its input against its schema before the
// handler runs, and valid input still saves.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000731";
const TOKEN = "lifer_test_settings_routes_731";
const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("settings routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let cookieName: string;

  const call = (method: "GET" | "POST" | "PUT", route: string, payload?: unknown, signedIn = true) =>
    app.inject({ method, url: route, payload: payload as object, cookies: signedIn ? { [cookieName]: TOKEN } : {} });
  const userRow = async () =>
    (
      await db.query(
        `SELECT hide_obscure_species, technical_diving, species_naming_styles, tips_seen, locale FROM users WHERE id = $1`,
        [USER],
      )
    ).rows[0];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-settings-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { settingsRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [`species_name_display:${USER}`]);
    await db.query(
      `INSERT INTO users (id, email, password_hash, hide_obscure_species, species_naming_styles)
       VALUES ($1, 'settings-routes@test', 'x', true, '{common}')`,
      [USER],
    );
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(settingsRoutes, { prefix: "/api" });
    await app.ready();
    // Over the default 10 seconds at times: the settings routes import the catalog and model modules.
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM install_settings WHERE key = $1`, [`species_name_display:${USER}`]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("asks for a sign-in before it looks at the input", async () => {
    const res = await call("PUT", "/api/settings/hide-obscure-species", { enabled: "nope" }, false);
    expect(res.statusCode).toBe(401);
  });

  it("saves an on/off setting and answers with the saved value", async () => {
    const res = await call("PUT", "/api/settings/hide-obscure-species", { enabled: false });
    expect([res.statusCode, res.json()]).toEqual([200, { hideObscureSpecies: false }]);
    expect((await userRow()).hide_obscure_species).toBe(false);
  });

  it.each([
    ["a missing value", {}, /^Invalid body: enabled is required$/],
    ["a string for a boolean", { enabled: "true" }, /^Invalid body: enabled must be boolean$/],
    ["a number for a boolean", { enabled: 1 }, /^Invalid body: enabled must be boolean$/],
    ["an unknown field", { enabled: true, other: 1 }, /^Invalid body: unexpected field other$/],
  ])("refuses %s for an on/off setting, saving nothing", async (_name, payload, error) => {
    const res = await call("PUT", "/api/settings/technical-diving", payload);
    expect([res.statusCode, res.json()]).toEqual([400, invalid(error)]);
    expect((await userRow()).technical_diving).toBe(false);
  });

  it("refuses an on/off setting with no body at all", async () => {
    const res = await call("PUT", "/api/settings/technical-diving");
    expect(res.statusCode).toBe(400);
  });

  it("records each tip seen once, and Show tips again clears them", async () => {
    for (const id of ["import-keys", "viewer-keys", "import-keys"]) {
      expect((await call("POST", "/api/settings/tips/seen", { id })).statusCode).toBe(200);
    }
    expect((await call("GET", "/api/settings")).json()).toMatchObject({
      tipsEnabled: true,
      tipsSeen: ["import-keys", "viewer-keys"],
    });
    expect((await call("PUT", "/api/settings/tips", { enabled: false })).json()).toEqual({ tipsEnabled: false });
    const reset = await call("POST", "/api/settings/tips/reset");
    expect(reset.json()).toEqual({ tipsSeen: [], tipsEnabled: true });
    expect((await userRow()).tips_seen).toEqual([]);
  });

  it("refuses a tip id that isn't a plain slug", async () => {
    const res = await call("POST", "/api/settings/tips/seen", { id: "Bad Id!" });
    expect(res.statusCode).toBe(400);
  });

  it("saves species naming styles in order, without repeats", async () => {
    const res = await call("PUT", "/api/settings/species-naming-style", { styles: ["latin", "common", "latin"] });
    expect([res.statusCode, res.json()]).toEqual([200, { speciesNamingStyles: ["latin", "common"] }]);
    expect((await userRow()).species_naming_styles).toEqual(["latin", "common"]);
    expect((await call("PUT", "/api/settings/species-naming-style", { styles: [] })).statusCode).toBe(200);
  });

  it.each([
    ["an unknown style", { styles: ["common", "klingon"] }, /^Invalid body: styles\.1 must be one of common, latin/],
    ["a single style not in a list", { styles: "common" }, /^Invalid body: styles must be array$/],
    ["no styles", {}, /^Invalid body: styles is required$/],
  ])("refuses %s as naming styles", async (_name, payload, error) => {
    await call("PUT", "/api/settings/species-naming-style", { styles: ["common"] });
    const res = await call("PUT", "/api/settings/species-naming-style", payload);
    expect([res.statusCode, res.json()]).toEqual([400, invalid(error)]);
    expect((await userRow()).species_naming_styles).toEqual(["common"]);
  });

  it("saves a folder layout in order, without repeats, and reads it back", async () => {
    const res = await call("PUT", "/api/settings/folder-layout", { layout: ["trip", "group", "species", "trip"] });
    expect([res.statusCode, res.json()]).toEqual([200, { folderLayout: ["trip", "group", "species"] }]);
    expect((await call("GET", "/api/settings")).json().folderLayout).toEqual(["trip", "group", "species"]);
    await call("PUT", "/api/settings/folder-layout", { layout: ["group", "species"] });
  });

  it.each([
    ["an unknown level", { layout: ["group", "camera"] }, /^Invalid body: layout\.1 must be one of /],
    ["no levels", { layout: [] }, /^Invalid body: layout must /],
    ["no layout", {}, /^Invalid body: layout is required$/],
  ])("refuses %s as a folder layout", async (_name, payload, error) => {
    const res = await call("PUT", "/api/settings/folder-layout", payload);
    expect([res.statusCode, res.json()]).toEqual([400, invalid(error)]);
    expect((await call("GET", "/api/settings")).json().folderLayout).toEqual(["group", "species"]);
  });

  it("shows a layout's example on a sample photo before there are any, and refuses unknown levels", async () => {
    const res = await call("GET", "/api/settings/folder-layout/example?layout=country,province,place,group,species");
    expect(res.json()).toEqual({
      path: path.join("Canada", "Alberta", "Pigeon Lake", "Birds", "American Robin", "Adjusted", "IMG_4411.jpg"),
      sample: true,
    });
    expect((await call("GET", "/api/settings/folder-layout/example?layout=year,date")).json().path).toBe(
      path.join("2025", "2025-06-14", "Adjusted", "IMG_4411.jpg"),
    );
    expect((await call("GET", "/api/settings/folder-layout/example?layout=group,camera")).statusCode).toBe(400);
  });

  it("still refuses aba_code when no pack has ABA codes, in the handler", async () => {
    const res = await call("PUT", "/api/settings/species-naming-style", { styles: ["aba_code"] });
    expect([res.statusCode, res.json()]).toEqual([
      400,
      { error: "No downloaded region has any ABA-coded species yet" },
    ]);
  });

  it("saves the View menu's species name choice in display order and reads it back", async () => {
    expect((await call("GET", "/api/settings")).json().speciesNameDisplay).toBeNull();
    const res = await call("PUT", "/api/settings/species-name-display", {
      main: "scientific",
      also: ["ebird", "other"],
    });
    const saved = { main: "scientific", also: ["other", "ebird"] };
    expect([res.statusCode, res.json()]).toEqual([200, { speciesNameDisplay: saved }]);
    expect((await call("GET", "/api/settings")).json().speciesNameDisplay).toEqual(saved);
    // Nothing below the main name is a choice too.
    const none = await call("PUT", "/api/settings/species-name-display", { main: "common", also: [] });
    expect(none.json()).toEqual({ speciesNameDisplay: { main: "common", also: [] } });
  });

  it.each([
    ["an unknown main name", { main: "latin", also: [] }],
    ["an unknown extra", { main: "common", also: ["klingon"] }],
    ["a repeated extra", { main: "common", also: ["aba", "aba"] }],
    ["a single extra not in a list", { main: "common", also: "aba" }],
    ["the earlier shape", { first: "common", second: "none" }],
    ["an extra field", { main: "common", also: [], font: "big" }],
  ])("refuses %s as the species name choice", async (_name, payload) => {
    const res = await call("PUT", "/api/settings/species-name-display", payload);
    expect([res.statusCode, res.json().code]).toEqual([400, "invalid_request"]);
    expect((await call("GET", "/api/settings")).json().speciesNameDisplay).toEqual({ main: "common", also: [] });
  });

  it("saves the interface language, null meaning automatic, and reads it back", async () => {
    expect((await call("GET", "/api/settings")).json().locale).toBeNull();
    const res = await call("PUT", "/api/settings/locale", { locale: "zh-Hans" });
    expect([res.statusCode, res.json()]).toEqual([200, { locale: "zh-Hans" }]);
    expect((await userRow()).locale).toBe("zh-Hans");
    expect((await call("GET", "/api/settings")).json().locale).toBe("zh-Hans");
    expect((await call("PUT", "/api/settings/locale", { locale: null })).json()).toEqual({ locale: null });
    expect((await userRow()).locale).toBeNull();
  });

  it.each([
    ["a malformed tag", { locale: "english please" }],
    ["a missing value", {}],
    ["a number", { locale: 7 }],
  ])("refuses %s as the interface language", async (_name, payload) => {
    const res = await call("PUT", "/api/settings/locale", payload);
    expect([res.statusCode, res.json().code]).toEqual([400, "invalid_request"]);
  });

  it("checks the folder browser's query, keeping its own path checks", async () => {
    const roots = await call("GET", "/api/settings/browse-directory");
    expect(roots.statusCode).toBe(200);
    expect(roots.json()).toMatchObject({ path: null, parent: null });
    // An empty value means no path, like leaving it out.
    expect((await call("GET", "/api/settings/browse-directory?path=")).json()).toMatchObject({ path: null });
    const relative = await call("GET", "/api/settings/browse-directory?path=relative");
    expect([relative.statusCode, relative.json()]).toEqual([400, { error: "path must be absolute" }]);
    const twice = await call("GET", "/api/settings/browse-directory?path=/a&path=/b");
    expect([twice.statusCode, twice.json()]).toEqual([400, invalid(/^Invalid query: path must be string$/)]);
    // Outside the allowed roots is still refused by lib/allowedPaths.ts.
    expect((await call("GET", "/api/settings/browse-directory?path=/etc")).statusCode).toBe(403);
  });

  it("makes a new folder for the folder picker, only inside an allowed one", async () => {
    const res = await call("POST", "/api/settings/browse-directory/new-folder", { parent: dataDir, name: "Wildlife" });
    expect(res.statusCode).toBe(200);
    expect(existsSync(res.json().path)).toBe(true);
    // Already there: it's simply used.
    const again = await call("POST", "/api/settings/browse-directory/new-folder", {
      parent: dataDir,
      name: "Wildlife",
    });
    expect(again.json()).toEqual(res.json());
    for (const name of ["..", "a/b", "a\\b"]) {
      const bad = await call("POST", "/api/settings/browse-directory/new-folder", { parent: dataDir, name });
      expect(bad.statusCode).toBe(400);
    }
    const outside = await call("POST", "/api/settings/browse-directory/new-folder", { parent: "/etc", name: "x" });
    expect(outside.statusCode).toBe(403);
  });

  it("refuses a background value other than 1 for reorganizing", async () => {
    const res = await call("POST", "/api/settings/reorganize-originals?background=true");
    expect([res.statusCode, res.json()]).toEqual([400, invalid(/^Invalid query: background must be 1$/)]);
  });

  it("answers desktop-only routes with 404 on a server, whatever the body", async () => {
    for (const [route, payload] of [["/api/settings/delete-local-library", { confirm: "yes" }]] as const) {
      const res = await call("POST", route, payload);
      expect([res.statusCode, res.json().code]).toEqual([404, "desktop_only"]);
    }
  });

  it("answers the asset routes, which take no input", async () => {
    const res = await call("GET", "/api/settings/map/status");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ downloaded: false });
    expect((await call("POST", "/api/settings/map/download/cancel", {})).json()).toEqual({ cancelled: false });
  });
});
