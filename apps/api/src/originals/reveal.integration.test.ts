// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// POST /originals/reveal in desktop mode, where it does run: the body is checked before the
// handler, and a well-formed path still reaches the ownership check. "Open in" an editor opens the
// version on screen.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  it("opens the shown version's file, or one version's own by its photo", async () => {
    const SPECIES = "eeeeeeee-0000-4000-8000-000000000a71";
    const userId = (await db.query<{ id: string }>(`SELECT id FROM users WHERE email = $1`, [LOCAL_EMAIL])).rows[0].id;
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 922971, 'Alces editorus', 'Editor Moose', 'mammalia')`,
      [SPECIES],
    );
    const add = async (key: string) => {
      const file = path.join(dataDir, `${key}.jpg`);
      writeFileSync(file, key);
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [userId, SPECIES, `editor-${key}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/x/d.webp', '/x/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, 'jpeg', 'path', $3, false, $4, 1)`,
        [userId, c.rows[0].id, file, `editor-hash-${key}`],
      );
      return { capture: c.rows[0].id, photo: p.rows[0].id, file };
    };
    const editorPaths = async (body: object) =>
      (
        await app.inject({
          method: "POST",
          url: "/api/originals/editor-paths",
          headers: { "x-lifer-launch-token": LAUNCH_TOKEN },
          payload: body,
        })
      ).json().paths;
    try {
      const group = await add("original");
      const print = await add("print");
      const { pool } = await import("@lifer/core/db.js");
      const { linkVersionTx, showVersionTx } = await import("../uploads/versionGrouping.js");
      const client = await pool.connect();
      try {
        await linkVersionTx(client, userId, print.capture, group.capture, "manual", { covers: [], recrop: [] });
        await showVersionTx(client, group.capture, print.capture, []);
      } finally {
        client.release();
      }
      expect(await editorPaths({ captureIds: [group.capture] })).toEqual([print.file]);
      expect(await editorPaths({ photoIds: [group.photo] })).toEqual([group.file]);
      expect(await editorPaths({ photoIds: [print.photo] })).toEqual([print.file]);

      // A RAW and its edit: the RAW, unless the edited file is asked for.
      const solo = await add("solo");
      const raw = path.join(dataDir, "solo.cr3");
      writeFileSync(raw, "raw");
      await db.query(
        `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, 'raw', 'path', $3, false, 'editor-hash-solo-raw', 1)`,
        [userId, solo.capture, raw],
      );
      expect(await editorPaths({ captureIds: [solo.capture] })).toEqual([raw]);
      expect(await editorPaths({ captureIds: [solo.capture], edited: true })).toEqual([solo.file]);
    } finally {
      await db.query(`UPDATE captures_all SET current_photo_id = NULL WHERE species_id = $1`, [SPECIES]);
      await db.query(`DELETE FROM captures_all WHERE species_id = $1`, [SPECIES]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    }
  });
});
