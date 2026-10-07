// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55473/lifer npx vitest run offlinePacks/remove
// Removing a pack deletes its species' reference photo files only once the database change has
// committed, so a failed removal never leaves rows pointing at deleted files.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000571";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000057a";
const SHARED_SPECIES = "eeeeeeee-0000-4000-8000-00000000057b";
const PACK = "zz-remove-test-pack";
const TOKEN = "lifer_test_pack_remove_571";

describe.skipIf(!url)("removing a pack", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  let dir: string;
  let files: Record<"display" | "thumb" | "galleryDisplay" | "galleryThumb" | "reused", string>;

  async function cleanup() {
    await db.query(`DROP TRIGGER IF EXISTS zz_fail_pack_removal ON downloaded_packs`);
    await db.query(`DROP FUNCTION IF EXISTS zz_fail_pack_removal()`);
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, SHARED_SPECIES]]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { offlinePacksRoutes } = await import("./routes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'pack-remove@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);

    dir = mkdtempSync(path.join(tmpdir(), "lifer-pack-remove-"));
    files = {
      display: path.join(dir, "display.webp"),
      thumb: path.join(dir, "thumb.webp"),
      galleryDisplay: path.join(dir, "gallery-display.webp"),
      galleryThumb: path.join(dir, "gallery-thumb.webp"),
      // Pointed at by another species too (reinstalled meanwhile), so it must survive.
      reused: path.join(dir, "reused.webp"),
    };
    for (const f of Object.values(files)) writeFileSync(f, "webp");

    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, reference_display_path, reference_thumb_path)
       VALUES ($1, 915710, 'Removea packii', 'aves', $2, $3), ($4, 915711, 'Removea sharedii', 'aves', $5, NULL)`,
      [SPECIES, files.display, files.reused, SHARED_SPECIES, files.reused],
    );
    await db.query(
      `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, display_path, thumb_path)
       VALUES ($1, 'https://example.test/p.jpg', 'someone', 'cc-by', $2, $3)`,
      [SPECIES, files.galleryDisplay, files.galleryThumb],
    );
    await db.query(`INSERT INTO downloaded_packs (pack_id, species_count) VALUES ($1, 1)`, [PACK]);
    // The shared species is another pack's: only SPECIES goes when this pack does.
    await db.query(`INSERT INTO pack_species (pack_id, species_id) VALUES ($1, $2)`, [PACK, SPECIES]);
    // thumb gets its own file again, so the earlier shared path stays only on SHARED_SPECIES.
    await db.query(`UPDATE species SET reference_thumb_path = $1 WHERE id = $2`, [files.thumb, SPECIES]);

    app = Fastify();
    await app.register(cookie);
    await app.register(offlinePacksRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  const remove = () =>
    app.inject({ method: "DELETE", url: `/api/offline-packs/${PACK}`, cookies: { [cookieName]: TOKEN } });

  it("keeps every file when the removal rolls back", async () => {
    await db.query(`CREATE FUNCTION zz_fail_pack_removal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'simulated failure'; END $$`);
    await db.query(`CREATE TRIGGER zz_fail_pack_removal BEFORE DELETE ON downloaded_packs
      FOR EACH ROW WHEN (OLD.pack_id = '${PACK}') EXECUTE FUNCTION zz_fail_pack_removal()`);
    const res = await remove();
    expect(res.statusCode).toBe(500);
    const row = await db.query(`SELECT reference_display_path FROM species WHERE id = $1`, [SPECIES]);
    expect(row.rows[0].reference_display_path).toBe(files.display);
    for (const f of Object.values(files)) expect([f, existsSync(f)]).toEqual([f, true]);
    await db.query(`DROP TRIGGER zz_fail_pack_removal ON downloaded_packs`);
    await db.query(`DROP FUNCTION zz_fail_pack_removal()`);
  });

  it("deletes the files after the removal commits, but never one another row still uses", async () => {
    await db.query(`UPDATE species SET reference_display_path = $1 WHERE id = $2`, [files.display, SPECIES]);
    // A species in no pack still pointing at the gallery's display file, as a reinstall would.
    await db.query(`UPDATE species SET reference_thumb_path = $1 WHERE id = $2`, [
      files.galleryDisplay,
      SHARED_SPECIES,
    ]);
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, species_count) VALUES ('zz-remove-other', 1) ON CONFLICT DO NOTHING`,
    );
    await db.query(
      `INSERT INTO pack_species (pack_id, species_id) VALUES ('zz-remove-other', $1) ON CONFLICT DO NOTHING`,
      [SHARED_SPECIES],
    );
    try {
      const res = await remove();
      expect(res.statusCode).toBe(200);
      expect(existsSync(files.display)).toBe(false);
      expect(existsSync(files.thumb)).toBe(false);
      expect(existsSync(files.galleryThumb)).toBe(false);
      expect(existsSync(files.galleryDisplay)).toBe(true);
      expect(existsSync(files.reused)).toBe(true);
      const row = await db.query(`SELECT reference_display_path FROM species WHERE id = $1`, [SPECIES]);
      expect(row.rows[0].reference_display_path).toBeNull();
    } finally {
      await db.query(`DELETE FROM downloaded_packs WHERE pack_id = 'zz-remove-other'`);
    }
  });
});
