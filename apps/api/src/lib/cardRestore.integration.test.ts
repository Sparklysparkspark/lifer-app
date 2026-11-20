// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Card covers and
// crops survive a reinstall: saved in the library's record, then put back after a reimport,
// finding the cover by its file's hash or, when Lifer rewrote the file's tags, by its path.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000910";
const SP = ["ffffffff-0000-4000-8000-0000000009a1", "ffffffff-0000-4000-8000-0000000009a2"];

describe.skipIf(!url)("card covers and crops in the library record", () => {
  let db: pg.Pool;
  let dataDir: string;
  let saveCollectionState: typeof import("./collectionState.js").saveCollectionState;
  let restoreCards: typeof import("./collectionState.js").restoreCards;

  async function capture(speciesId: string, fingerprint: string, file: string) {
    const c = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
      [USER, speciesId, fingerprint],
    );
    const p = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/x/d.webp', '/x/t.webp') RETURNING id`,
      [c.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    await db.query(
      `INSERT INTO originals (user_id, capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, $2, 'jpeg', 'path', $3, true, $4, 1)`,
      [USER, c.rows[0].id, path.join(dataDir, file), fingerprint],
    );
    return p.rows[0].id;
  }

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-cards-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(tmpdir(), `lifer-cards-app-${process.pid}`);
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'cards@test', 'x')`, [USER]);
    for (const [i, id] of SP.entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, 'Card Bird', 'aves')`,
        [id, 912000 + i, `Cardia species${i}`],
      );
    ({ saveCollectionState, restoreCards } = await import("./collectionState.js"));
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("saves each card's cover and crop, then restores them on the reimported photos", async () => {
    const cover0 = await capture(SP[0], "hash-a", "Birds/a.jpg");
    const cover1 = await capture(SP[1], "hash-b", "Birds/b.jpg");
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, card_crop_x, card_crop_y, card_crop_size)
       VALUES ($1, $2, 'collected', $3, 12, 34, 56), ($1, $4, 'collected', $5, 1, 2, 90)`,
      [USER, SP[0], cover0, SP[1], cover1],
    );
    await saveCollectionState(USER);
    const record = JSON.parse(readFileSync(path.join(dataDir, ".lifer", "collection-state.json"), "utf8"));
    expect(record.users["cards@test"].cards).toEqual([
      {
        species: "Cardia species0",
        coverFingerprint: "hash-a",
        coverPath: "Birds/a.jpg",
        cropX: 12,
        cropY: 34,
        cropSize: 56,
      },
      {
        species: "Cardia species1",
        coverFingerprint: "hash-b",
        coverPath: "Birds/b.jpg",
        cropX: 1,
        cropY: 2,
        cropSize: 90,
      },
    ]);

    // A reinstall and reimport: new rows, default crops; b.jpg's tags were rewritten, so its hash changed.
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM originals WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    const again0 = await capture(SP[0], "hash-a", "Birds/a.jpg");
    const again1 = await capture(SP[1], "hash-b-rewritten", "Birds/b.jpg");
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, card_crop_x, card_crop_y, card_crop_size)
       VALUES ($1, $2, 'collected', $3, 50, 50, 100)`,
      [USER, SP[0], again0],
    );

    expect(await restoreCards(USER)).toBe(2);
    const rows = (
      await db.query(
        `SELECT species_id, cover_photo_id, card_crop_x::float AS x, card_crop_y::float AS y, card_crop_size::float AS size
           FROM user_species WHERE user_id = $1 ORDER BY species_id`,
        [USER],
      )
    ).rows;
    expect(rows).toEqual([
      { species_id: SP[0], cover_photo_id: again0, x: 12, y: 34, size: 56 },
      { species_id: SP[1], cover_photo_id: again1, x: 1, y: 2, size: 90 },
    ]);
  });
});
