// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Adding a watched folder: the same folder, one inside a watched folder or inside the library is
// not added twice, and a parent of watched folders replaces them only when asked to merge.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LAUNCH = "watched-folders-test-launch-token";

describe.skipIf(!url)("watched folder routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let root = "";
  let parent = "";
  let child = "";
  let library = "";

  const call = (method: "GET" | "POST", route: string, payload?: object) =>
    app.inject({
      method,
      url: `/api${route}`,
      payload,
      headers: { "x-lifer-client": "1", "x-lifer-launch-token": LAUNCH },
    });
  const watched = async () =>
    ((await call("GET", "/library/watched-folders")).json().folders as Array<{ path: string }>).map((f) => f.path);

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "lifer-watched-")));
    parent = path.join(root, "cards");
    child = path.join(parent, "2026");
    library = path.join(root, "library");
    await mkdir(child, { recursive: true });
    await mkdir(path.join(library, "inside"), { recursive: true });
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH;
    // The library folder is a scratch one, never the user's.
    process.env.DATA_DIR = library;
    process.env.APP_DATA_DIR = path.join(root, "app-data");
    db = new pg.Pool({ connectionString: url });
    const { installSchemas } = await import("../lib/schema.js");
    const { watchedFoldersRoutes } = await import("./watchedFoldersRoutes.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(watchedFoldersRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  beforeEach(() => db.query(`DELETE FROM install_settings WHERE key = 'watched_folders'`));

  afterAll(async () => {
    await app?.close();
    await db?.query(`DELETE FROM install_settings WHERE key = 'watched_folders'`);
    await db?.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    await rm(root, { recursive: true, force: true });
  });

  it("says a folder is already covered instead of adding it twice", async () => {
    expect((await call("POST", "/library/watched-folders", { path: parent })).json()).toEqual({
      added: true,
      coveredBy: null,
      contains: [],
    });
    for (const p of [parent, child]) {
      expect((await call("POST", "/library/watched-folders", { path: p })).json()).toEqual({
        added: false,
        coveredBy: parent,
        contains: [],
      });
    }
    expect(await watched()).toEqual([parent]);
  });

  it("won't watch a folder inside the library", async () => {
    const res = (await call("POST", "/library/watched-folders", { path: path.join(library, "inside") })).json();
    expect(res).toMatchObject({ added: false, coveredBy: library });
    expect(await watched()).toEqual([]);
  });

  it("replaces watched folders inside a new parent only when asked to merge", async () => {
    await call("POST", "/library/watched-folders", { path: child });
    expect((await call("POST", "/library/watched-folders", { path: parent })).json()).toEqual({
      added: false,
      coveredBy: null,
      contains: [child],
    });
    expect(await watched()).toEqual([child]);
    expect((await call("POST", "/library/watched-folders", { path: parent, merge: true })).json()).toEqual({
      added: true,
      coveredBy: null,
      contains: [child],
    });
    expect(await watched()).toEqual([parent]);
  });
});
