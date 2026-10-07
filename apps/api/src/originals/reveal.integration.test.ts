// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// POST /originals/reveal in desktop mode, where it does run: the body is checked before the
// handler, and a well-formed path still reaches the ownership check.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
// Desktop mode's auto-provisioned user (auth/session.ts).
const LOCAL_EMAIL = "local@lifer.app";
// Desktop mode answers only the app's own window, which presents the per-launch secret.
const LAUNCH_TOKEN = "reveal-test-launch-token";

describe.skipIf(!url)("revealing an original on the desktop", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dataDir: string;
  let localUserExisted = false;

  const reveal = (payload: unknown) =>
    app.inject({
      method: "POST",
      url: "/api/originals/reveal",
      headers: { "x-lifer-launch-token": LAUNCH_TOKEN },
      payload: payload as object,
    });

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-reveal-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(dataDir, "app-data");
    process.env.SINGLE_USER_MODE = "1";
    process.env.LIFER_LAUNCH_TOKEN = LAUNCH_TOKEN;
    // A developer's .env may switch the launch secret off; these tests check the real path.
    process.env.LIFER_ALLOW_UNTOKENED_DESKTOP = "0";
    db = new pg.Pool({ connectionString: url });
    localUserExisted = (await db.query(`SELECT 1 FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows.length > 0;
    const { originalsRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(originalsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      if (!localUserExisted) await db.query(`DELETE FROM users WHERE email = $1`, [LOCAL_EMAIL]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("refuses a missing, empty or non-string path and unexpected fields", async () => {
    const cases: Array<[unknown, RegExp]> = [
      [{}, /^Invalid body: path is required$/],
      [{ path: 5 }, /^Invalid body: path must be string$/],
      [{ path: "" }, /^Invalid body: path /],
      [{ path: "/x", recursive: true }, /^Invalid body: unexpected field recursive$/],
    ];
    for (const [body, message] of cases) {
      const res = await reveal(body);
      expect([res.statusCode, res.json()]).toEqual([
        400,
        { error: expect.stringMatching(message), code: "invalid_request" },
      ]);
    }
  });

  it("still checks that a well-formed path is one of your originals", async () => {
    const res = await reveal({ path: "/somewhere/not/yours.jpg" });
    expect([res.statusCode, res.json()]).toEqual([403, { error: "Not your file" }]);
  });
});
