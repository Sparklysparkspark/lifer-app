// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The desktop-only routes (drives, migrating to a server, deleting the local library), run in
// desktop mode: each checks its input against its schema before the handler runs.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const LOCAL_EMAIL = "local@lifer.app";
const PLATFORM_ID = "lifer-test-volume-741";
const MISSING = "eeeeeeee-0000-4000-8000-0000000007ff";
const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("desktop-only storage and migration routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let createdLocalUser = false;
  let volumeId: string;

  const call = (method: "POST" | "PUT" | "DELETE", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object });
  const label = async () =>
    (await db.query(`SELECT label FROM storage_volumes WHERE id = $1`, [volumeId])).rows[0]?.label;

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-desktop-routes-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    db = new pg.Pool({ connectionString: url });
    createdLocalUser = (await db.query(`SELECT 1 FROM users WHERE email = $1`, [LOCAL_EMAIL])).rowCount === 0;
    const { storageVolumesRoutes } = await import("./routes.js");
    const { migrateToServerRoutes } = await import("../settings/migrateToServer.js");

    app = Fastify();
    await app.register(storageVolumesRoutes, { prefix: "/api" });
    await app.register(migrateToServerRoutes, { prefix: "/api" });
    await app.ready();

    // Desktop mode signs every request in as the local user, created on first use.
    expect((await app.inject({ method: "GET", url: "/api/storage-volumes" })).statusCode).toBe(200);
    const user = await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [LOCAL_EMAIL]);
    await db.query(`DELETE FROM storage_volumes WHERE platform_volume_id = $1`, [PLATFORM_ID]);
    volumeId = (
      await db.query<{ id: string }>(
        `INSERT INTO storage_volumes (user_id, label, platform_volume_id, last_known_mount_path)
         VALUES ($1, 'Field drive', $2, '/Volumes/LiferTest741') RETURNING id`,
        [user.rows[0].id, PLATFORM_ID],
      )
    ).rows[0].id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM storage_volumes WHERE platform_volume_id = $1`, [PLATFORM_ID]);
    if (createdLocalUser) await db.query(`DELETE FROM users WHERE email = $1`, [LOCAL_EMAIL]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("renames a drive, trimming the label", async () => {
    const res = await call("PUT", `/api/storage-volumes/${volumeId}`, { label: "  Card 2  " });
    expect([res.statusCode, res.json()]).toEqual([200, { ok: true }]);
    expect(await label()).toBe("Card 2");
  });

  it.each([
    ["a blank label", { label: "   " }, /^Invalid body: label must match pattern/],
    ["a number for a label", { label: 7 }, /^Invalid body: label must be string$/],
    ["no label", {}, /^Invalid body: label is required$/],
    ["an unknown field", { label: "x", path: "/y" }, /^Invalid body: unexpected field path$/],
  ])("refuses %s when renaming a drive", async (_name, payload, error) => {
    const res = await call("PUT", `/api/storage-volumes/${volumeId}`, payload);
    expect([res.statusCode, res.json()]).toEqual([400, invalid(error)]);
    expect(await label()).toBe("Card 2");
  });

  it("answers a malformed drive id like an unknown one", async () => {
    for (const [method, suffix, payload] of [
      ["PUT", "", { label: "x" }],
      ["PUT", "/default", {}],
      ["DELETE", "", undefined],
    ] as const) {
      for (const id of ["nope", MISSING]) {
        const res = await call(method, `/api/storage-volumes/${id}${suffix}`, payload);
        // DELETE answers ok for an unknown well-formed id: unregistering is idempotent.
        if (method === "DELETE" && id === MISSING) expect(res.statusCode).toBe(200);
        else
          expect([method, suffix, id, res.statusCode, res.json()]).toEqual([
            method,
            suffix,
            id,
            404,
            { error: "Drive not found" },
          ]);
      }
    }
  });

  it.each([
    ["no path", { label: "x" }, /^Invalid body: path is required$/],
    ["a path that isn't text", { path: ["/Volumes/x"], label: "x" }, /^Invalid body: path must be string$/],
    ["a blank label", { path: "/Volumes/x", label: "" }, /^Invalid body: label must match pattern/],
  ])("refuses %s when registering a drive", async (_name, payload, error) => {
    const res = await call("POST", "/api/storage-volumes", payload);
    expect([res.statusCode, res.json()]).toEqual([400, invalid(error)]);
  });

  it("keeps the absolute-path check for a new drive in the handler", async () => {
    const res = await call("POST", "/api/storage-volumes", { path: "relative/folder", label: "x" });
    expect([res.statusCode, res.json()]).toEqual([400, { error: "path must be an absolute folder path" }]);
  });

  it.each([
    ["no password", { serverUrl: "https://lifer.example", email: "a@b.c" }, /^Invalid body: password is required$/],
    ["an empty email", { serverUrl: "https://lifer.example", email: "", password: "p" }, /^Invalid body: email /],
    [
      "a number for the URL",
      { serverUrl: 8080, email: "a@b.c", password: "p" },
      /^Invalid body: serverUrl must be string$/,
    ],
    [
      "an unknown field",
      { serverUrl: "https://lifer.example", email: "a@b.c", password: "p", token: "t" },
      /^Invalid body: unexpected field token$/,
    ],
  ])("refuses %s when migrating to a server", async (_name, payload, error) => {
    const res = await call("POST", "/api/settings/migrate-to-server", payload);
    expect([res.statusCode, res.json()]).toEqual([400, invalid(error)]);
  });

  it("still refuses a loopback or link-local server address in the handler, without reaching out", async () => {
    // A name is refused by what it resolves to, not how it's spelled (lib/outboundGuard.ts).
    for (const serverUrl of ["http://127.0.0.1:9", "http://localhost:9", "http://169.254.169.254", "http://[::1]:9"]) {
      const res = await call("POST", "/api/settings/migrate-to-server", { serverUrl, email: "a@b.c", password: "p" });
      expect([serverUrl, res.statusCode, res.json()]).toEqual([
        serverUrl,
        400,
        { error: "Refusing to migrate to a loopback or link-local address" },
      ]);
    }
  });

  it("needs confirm: true to delete the local library, and then still the migration gate", async () => {
    for (const payload of [{}, { confirm: false }, { confirm: "true" }, { confirm: true, all: true }]) {
      const res = await call("POST", "/api/settings/delete-local-library", payload);
      expect([payload, res.statusCode, res.json().code]).toEqual([payload, 400, "invalid_request"]);
    }
    const gated = await call("POST", "/api/settings/delete-local-library", { confirm: true });
    expect([gated.statusCode, gated.json()]).toEqual([
      409,
      { error: "Local files can only be deleted right after a migration to a server." },
    ]);
  });
});
