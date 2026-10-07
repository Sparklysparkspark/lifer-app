// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run trips/symlinkedDataDir
// DATA_DIR reached through a symlink, as on macOS (/tmp -> /private/tmp) or a symlinked NAS mount.
// The allowed-path check hands back realpaths, and a trip's default destination is built from one,
// so it must still be allowed; a symlink leading out of DATA_DIR must still be refused.
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000642";
const TOKEN = "lifer_test_trip_symlinked_data_dir_642";

describe.skipIf(!url)("trips with a symlinked DATA_DIR", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let tmp: string;
  let realData: string;
  let linkedData: string;
  let outside: string;
  let cookieName: string;

  const call = (method: "POST" | "PATCH", route: string, payload?: unknown) =>
    app.inject({ method, url: route, payload: payload as object, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [OWNER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
  }

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "lifer-trip-symlink-")));
    realData = path.join(tmp, "real-data");
    linkedData = path.join(tmp, "linked-data");
    outside = path.join(tmp, "outside");
    mkdirSync(path.join(realData, "Costa Rica"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(realData, linkedData);
    symlinkSync(outside, path.join(realData, "escape"));

    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = linkedData;
    process.env.APP_DATA_DIR = path.join(tmp, "app-data");
    process.env.SINGLE_USER_MODE = "0";
    delete process.env.LIFER_LIBRARY_ROOTS;
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { tripsRoutes } = await import("./routes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'trip-symlink@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(tripsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("creates a trip without destinationFolder, defaulting to a Wildlife folder inside the source", async () => {
    const res = await call("POST", "/api/trips", {
      name: "Costa Rica",
      sourceFolder: path.join(linkedData, "Costa Rica"),
    });
    expect(res.statusCode).toBe(201);
    const destination = path.join(realData, "Costa Rica", "Wildlife");
    expect(res.json()).toEqual({ id: expect.any(String), destinationFolder: destination });
    expect(existsSync(destination)).toBe(true);
    const row = await db.query(`SELECT source_folder FROM trips WHERE id = $1`, [res.json().id]);
    expect(row.rows[0].source_folder).toBe(path.join(realData, "Costa Rica"));
  });

  it("accepts the folders spelled either way: through the symlink or as the real path", async () => {
    const real = await call("POST", "/api/trips", { sourceFolder: path.join(realData, "Costa Rica") });
    expect(real.statusCode).toBe(201);
    const linked = await call("POST", "/api/trips", {
      sourceFolder: path.join(linkedData, "Costa Rica"),
      destinationFolder: path.join(linkedData, "Out"),
    });
    expect(linked.statusCode).toBe(201);
    expect(linked.json().destinationFolder).toBe(path.join(realData, "Out"));
    const patched = await call("PATCH", `/api/trips/${real.json().id}`, {
      destinationFolder: path.join(realData, "Costa Rica", "Picked"),
    });
    expect(patched.statusCode).toBe(200);
  });

  it("still refuses a folder outside DATA_DIR, through a symlink or with ..", async () => {
    mkdirSync(path.join(outside, "Trip"), { recursive: true });
    const forbidden = [
      { sourceFolder: path.join(realData, "escape", "Trip") },
      { sourceFolder: path.join(linkedData, "escape", "Trip") },
      { sourceFolder: outside },
      { sourceFolder: path.join(linkedData, "..", "outside") },
      { sourceFolder: path.join(realData, "Costa Rica"), destinationFolder: path.join(realData, "escape", "Out") },
      { sourceFolder: path.join(realData, "Costa Rica"), destinationFolder: path.join(outside, "Out") },
    ];
    for (const body of forbidden) {
      const res = await call("POST", "/api/trips", body);
      expect([JSON.stringify(body), res.statusCode]).toEqual([JSON.stringify(body), 403]);
    }
    expect(existsSync(path.join(outside, "Out"))).toBe(false);
  });
});
