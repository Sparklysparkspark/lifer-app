// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// What a paired phone gets for albums and reference photos, by device key.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.SINGLE_USER_MODE = "0";
});

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000971";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000097a";
const BARE = "eeeeeeee-0000-4000-8000-00000000097b";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000973";
const REMOTE = "eeeeeeee-0000-4000-8000-000000000975";
const MANUAL = "eeeeeeee-0000-4000-8000-000000000974";
const SMART = "eeeeeeee-0000-4000-8000-000000000976";
const DEVICE = "lifer_test_device_971";

describe.skipIf(!url)("phone albums and reference photos", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let dir: string;

  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, BARE]]);
  }

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-phone-library-"));
    const thumb = path.join(dir, "t.webp");
    writeFileSync(thumb, "webp");
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { syncRoutes } = await import("../sync/routes.js");
    const { phoneLibraryRoutes } = await import("./phoneLibrary.js");
    const { installSchemas } = await import("../lib/schema.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'lib971@test', 'x')`, [USER]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'Test phone (ios)', $2, '{companion}')`, [USER, hashApiKey(DEVICE)]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key, reference_photo, reference_thumb_path, reference_display_path, reference_credit, reference_license) VALUES
         ($1, 'Zzlib alpha', 'Lib Bird', 'aves', 980971, 'https://example.invalid/a.jpg', $3, $3, 'Jane Doe', 'CC BY 4.0'),
         ($2, 'Zzlib beta', 'Bare Bird', 'aves', 980972, NULL, NULL, NULL, NULL, NULL)`,
      [SPECIES, BARE, thumb],
    );
    // A capture mirrored from a server: its own id differs from the server's (remote_id).
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint, taken_at, tags, remote_id) VALUES ($1, $2, $3, 'lib-1', now(), '{kept}', $4)`,
      [CAPTURE, USER, SPECIES, REMOTE],
    );
    const photo = (await db.query(`INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, $2, $2) RETURNING id`, [CAPTURE, thumb])).rows[0].id;
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [photo, CAPTURE]);
    await db.query(`INSERT INTO albums (id, user_id, name) VALUES ($1, $2, 'Hand picked')`, [MANUAL, USER]);
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2)`, [MANUAL, CAPTURE]);
    await db.query(`INSERT INTO albums (id, user_id, name, rules) VALUES ($1, $2, 'Kept ones', $3)`, [SMART, USER, JSON.stringify({ version: 2, query: { tag: ["kept"] } })]);
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(syncRoutes, { prefix: "/api" });
    await app.register(phoneLibraryRoutes, { prefix: "/api" });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    rmSync(dir, { recursive: true, force: true });
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  const get = (u: string, key: string | null = DEVICE) =>
    app.inject({ method: "GET", url: `/api${u}`, headers: key ? { "x-api-key": key } : {} });

  it("names a mirrored capture in album membership by the id the phone's capture feed uses", async () => {
    expect((await get("/sync/changes")).json().items.map((i: { id: string }) => i.id)).toContain(CAPTURE);
    expect((await get("/sync/album-captures")).json().items).toMatchObject([{ albumId: MANUAL, captureId: CAPTURE }]);
    expect((await get("/sync/albums")).json().items.map((a: { id: string }) => a.id).sort()).toEqual([MANUAL, SMART].sort());
  });

  it("lists a smart album's photos for the phone, minus its exclusions", async () => {
    expect((await get("/companion/v1/albums/smart")).json()).toEqual({ albums: [{ id: SMART, captureIds: [CAPTURE] }] });
    await db.query(`INSERT INTO album_exclusions (album_id, capture_id) VALUES ($1, $2)`, [SMART, CAPTURE]);
    expect((await get("/companion/v1/albums/smart")).json()).toEqual({ albums: [{ id: SMART, captureIds: [] }] });
  });

  it("serves a species' reference photo and credit by name, 404 when there is none", async () => {
    expect((await get("/companion/v1/reference/Zzlib_alpha")).json()).toEqual({ credit: "Jane Doe", license: "CC BY 4.0" });
    for (const kind of ["thumb", "display"]) {
      const res = await get(`/companion/v1/reference/Zzlib_alpha/${kind}`);
      expect(res.statusCode).toBe(200);
    }
    expect((await get("/companion/v1/reference/Zzlib_beta")).statusCode).toBe(404);
    expect((await get("/companion/v1/reference/Zzlib_beta/thumb")).statusCode).toBe(404);
  });

  it("refuses requests with no key", async () => {
    for (const u of ["/companion/v1/albums/smart", "/companion/v1/reference/Zzlib_alpha", "/companion/v1/reference/Zzlib_alpha/thumb"])
      expect((await get(u, null)).statusCode, u).toBe(401);
  });
});
