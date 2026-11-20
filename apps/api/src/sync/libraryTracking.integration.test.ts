// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Migration 163:
// edits to albums, trips and their membership stamp updated_at, bookkeeping updates don't, and
// deletes write one tombstone each unless a sync is applying them or a parent removed them.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000901";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000090a";
const CAPTURE = "eeeeeeee-0000-4000-8000-000000000911";
const CAPTURE_2 = "eeeeeeee-0000-4000-8000-000000000912";
const ALBUM = "eeeeeeee-0000-4000-8000-000000000921";
const ALBUM_2 = "eeeeeeee-0000-4000-8000-000000000922";
const TRIP = "eeeeeeee-0000-4000-8000-000000000931";

describe.skipIf(!url)("library change tracking", () => {
  let db: pg.Pool;
  const tombs = async () =>
    (await db.query(`SELECT kind, ref FROM sync_tombstones WHERE user_id = $1 ORDER BY kind, ref`, [USER])).rows;
  const clear = () => db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
  const stamp = async (table: string, where: string, args: unknown[]) =>
    (await db.query(`SELECT updated_at::text AS u FROM ${table} WHERE ${where}`, args)).rows[0].u as string;
  async function cleanup() {
    await db.query(`DELETE FROM albums WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
  }
  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'track@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, scientific_name, common_name, taxon_class, gbif_key) VALUES ($1, 'Zztrack testus', 'Track Bird', 'aves', 980101)`,
      [SPECIES],
    );
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $3, $4, 'track-1'), ($2, $3, $4, 'track-2')`,
      [CAPTURE, CAPTURE_2, USER, SPECIES],
    );
    await db.query(`INSERT INTO albums (id, user_id, name) VALUES ($1, $3, 'A'), ($2, $3, 'B')`, [
      ALBUM,
      ALBUM_2,
      USER,
    ]);
    await db.query(
      `INSERT INTO trips (id, user_id, name, source_folder, destination_folder) VALUES ($1, $2, 'T', '/t', '/t/w')`,
      [TRIP, USER],
    );
    await db.query(`INSERT INTO album_captures (album_id, capture_id) VALUES ($1, $2), ($1, $3)`, [
      ALBUM,
      CAPTURE,
      CAPTURE_2,
    ]);
    await db.query(`INSERT INTO album_exclusions (album_id, capture_id) VALUES ($1, $2)`, [ALBUM, CAPTURE]);
    await db.query(`INSERT INTO species_split_kept (capture_id) VALUES ($1)`, [CAPTURE]);
  });
  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("stamps updated_at on an edit but not on a push bookkeeping update", async () => {
    for (const [table, id] of [
      ["albums", ALBUM],
      ["trips", TRIP],
    ] as const) {
      await db.query(`UPDATE ${table} SET updated_at = '2020-01-01' WHERE id = $1`, [id]);
      await db.query(`UPDATE ${table} SET pushed_at = now(), remote_updated_at = now() WHERE id = $1`, [id]);
      expect(await stamp(table, "id = $1", [id])).toMatch(/^2020-01-01/);
      await db.query(`UPDATE ${table} SET name = name || 'x' WHERE id = $1`, [id]);
      expect(await stamp(table, "id = $1", [id])).not.toMatch(/^2020-01-01/);
    }
    await db.query(`UPDATE album_captures SET updated_at = '2020-01-01' WHERE album_id = $1`, [ALBUM]);
    await db.query(`UPDATE album_captures SET pushed_at = now() WHERE album_id = $1`, [ALBUM]);
    expect(await stamp("album_captures", "album_id = $1 LIMIT 1", [ALBUM])).toMatch(/^2020-01-01/);
  });

  it("writes one tombstone per deleted row, with the membership ref", async () => {
    await clear();
    await db.query(`DELETE FROM album_captures WHERE album_id = $1 AND capture_id = $2`, [ALBUM, CAPTURE]);
    await db.query(`DELETE FROM album_exclusions WHERE album_id = $1`, [ALBUM]);
    await db.query(`DELETE FROM species_split_kept WHERE capture_id = $1`, [CAPTURE]);
    await db.query(`DELETE FROM trips WHERE id = $1`, [TRIP]);
    expect(await tombs()).toEqual([
      { kind: "album_capture", ref: `${ALBUM}:${CAPTURE}` },
      { kind: "album_exclusion", ref: `${ALBUM}:${CAPTURE}` },
      { kind: "species_split_kept", ref: CAPTURE },
      { kind: "trip", ref: TRIP },
    ]);
  });

  it("an album delete writes only the album tombstone, not its members", async () => {
    await clear();
    await db.query(`DELETE FROM albums WHERE id = $1`, [ALBUM]);
    expect(await tombs()).toEqual([{ kind: "album", ref: ALBUM }]);
  });

  it("deletes under lifer.sync_apply leave no tombstone", async () => {
    await clear();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT set_config('lifer.sync_apply', 'on', true)`);
      await client.query(`DELETE FROM albums WHERE id = $1`, [ALBUM_2]);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(await tombs()).toEqual([]);
  });
});
