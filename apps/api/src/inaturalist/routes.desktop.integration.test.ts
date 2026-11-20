// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// iNaturalist connect in desktop mode: the relay sends the sign-in back to the loopback API.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Reading observations back from iNaturalist (the existing-observations check) never leaves the test.
vi.mock("./observationSync.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchObservationPages: vi.fn(async () => 0),
  fetchDeletedObservationIds: vi.fn(async () => []),
  fetchPreview: vi.fn(async () => {
    throw new Error("no network in tests");
  }),
}));

const url = process.env.TEST_DATABASE_URL;
const LOCAL_EMAIL = "local@lifer.app";
const LAUNCH_TOKEN = "inat-desktop-test-launch-token";
const RELAY = "https://liferwildlife.com/inat-callback/";

describe.skipIf(!url)("iNaturalist connect on the desktop", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let localUserExisted = false;
  let savedConfig: Array<{ client_id: string | null; redirect_uri: string | null }> = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-inat-desktop-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.PORT = "4310";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH_TOKEN;
    process.env.LIFER_ALLOW_UNTOKENED_DESKTOP = "0";
    process.env.INAT_CLIENT_ID = "test-client";
    process.env.INAT_REDIRECT_URI = RELAY;
    db = new pg.Pool({ connectionString: url });
    localUserExisted = (await db.query(`SELECT 1 FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows.length > 0;
    savedConfig = (await db.query(`SELECT client_id, redirect_uri FROM inat_server_config`)).rows;
    await db.query(`DELETE FROM inat_server_config`);
    const { inaturalistRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(inaturalistRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!localUserExisted) await db.query(`DELETE FROM users WHERE email = $1`, [LOCAL_EMAIL]);
      for (const row of savedConfig) {
        await db.query(`INSERT INTO inat_server_config (id, client_id, redirect_uri) VALUES (true, $1, $2)`, [
          row.client_id,
          row.redirect_uri,
        ]);
      }
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("signs in straight on the loopback address, never through the relay", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/inaturalist/connect",
      headers: { "x-lifer-launch-token": LAUNCH_TOKEN, host: "tauri.localhost" },
    });
    expect(res.statusCode).toBe(200);
    const params = new URL(res.json().authorizeUrl).searchParams;
    expect(params.get("redirect_uri")).toBe("http://127.0.0.1:4310/api/inaturalist/callback");
    expect(params.get("redirect_uri")).not.toBe(RELAY);
    expect(params.get("state")).not.toContain(".");
  });
});
