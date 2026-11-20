// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Folder imports for connected apps, through the desktop gate as the app runs it.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PLUGIN = "com.example.folder-import";
const HOST = { host: "127.0.0.1:4310", "x-lifer-client": "1" };

describe.skipIf(!url)("folder imports for connected apps", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let outside: string;
  let userId: string;
  let writeKey: string;
  let readKey: string;

  const post = (payload: object, key = writeKey) =>
    app.inject({ method: "POST", url: "/api/imports/v1/folders", payload, headers: { ...HOST, "x-api-key": key } });
  const job = (id: string, key = writeKey) =>
    app.inject({ method: "GET", url: `/api/imports/v1/jobs/${id}`, headers: { ...HOST, "x-api-key": key } });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-folder-import-"));
    outside = mkdtempSync(path.join(tmpdir(), "lifer-folder-outside-"));
    writeFileSync(path.join(outside, "notes.txt"), "not a photo");
    mkdirSync(path.join(outside, "empty"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = "folder-import-test-launch-token";
    db = new pg.Pool({ connectionString: url });
    const { getOrCreateLocalUser } = await import("../auth/session.js");
    userId = (await getOrCreateLocalUser()).id;
    const { issuePluginKey } = await import("../plugins/pairing.js");
    writeKey = await issuePluginKey(userId, PLUGIN, "Folder App", ["imports.write"]);
    readKey = await issuePluginKey(userId, `${PLUGIN}.read`, "Reader", ["userdata.read"]);
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    const { desktopRequestGate } = await import("../auth/desktopGate.js");
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    app.addHook("onRequest", desktopRequestGate(4310));
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db?.query(`DELETE FROM api_keys WHERE plugin_id LIKE $1`, [`${PLUGIN}%`]);
    await db?.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("refuses a key without imports.write and bad paths", async () => {
    expect((await post({ path: outside, mode: "copy" }, readKey)).statusCode).toBe(401);
    expect((await post({ path: "relative/dir", mode: "copy" })).statusCode).toBe(400);
    expect((await post({ path: path.join(outside, "missing"), mode: "copy" })).statusCode).toBe(400);
    expect((await post({ path: outside, mode: "move" })).statusCode).toBe(400);
  });

  it("copies a folder Lifer doesn't know, even when in-place was asked, and reports progress", async () => {
    const res = await post({ path: path.join(outside, "empty"), mode: "in-place" });
    expect(res.statusCode).toBe(202);
    const { id, mode } = res.json() as { id: string; mode: string };
    expect(mode).toBe("copy");
    let status = (await job(id)).json() as { running: boolean; total: number; error?: string | null };
    for (let i = 0; i < 100 && status.running; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await job(id)).json();
    }
    expect(status).toMatchObject({ running: false, total: 0, imported: 0 });
    expect((await job("0")).statusCode).toBe(404);
  });

  it("leaves files in place inside the Lifer library", async () => {
    const inside = path.join(dataDir, "Photos from a card");
    mkdirSync(inside, { recursive: true });
    const res = await post({ path: inside, mode: "in-place" });
    expect(res.statusCode === 202 || res.statusCode === 409).toBe(true);
    if (res.statusCode === 202) expect(res.json()).toMatchObject({ mode: "in-place" });
  });
});
