// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The statement trigger that stamps user_species.photos_changed_at when a capture moves, is
// re-dated, hidden or trashed, and its speed on a bulk update after small ones on one connection.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000901";
const [A, B, EXTRA] = ["a1", "b1", "c1"].map((s) => `cccccccc-0000-4000-8000-0000000009${s}`);

describe.skipIf(!url)("captures_all species photos trigger", () => {
  // One client, so every statement shares the connection and its cached plans.
  let db: pg.Client;

  const stamped = async () =>
    (
      await db.query<{ species_id: string }>(
        `SELECT species_id FROM user_species WHERE user_id = $1 AND photos_changed_at IS NOT NULL ORDER BY species_id`,
        [USER],
      )
    ).rows.map((r) => r.species_id);
  const reset = () => db.query(`UPDATE user_species SET photos_changed_at = NULL WHERE user_id = $1`, [USER]);
  const add = async (species: string) =>
    (
      await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at)
         VALUES ($1, $2, gen_random_uuid()::text, now()) RETURNING id`,
        [USER, species],
      )
    ).rows[0].id;

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[A, B, EXTRA]]);
  }

  beforeAll(async () => {
    db = new pg.Client({ connectionString: url });
    await db.connect();
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'trigger@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 970901, 'Triggerus a', 'Trigger A', 'aves'), ($2, 970902, 'Triggerus b', 'Trigger B', 'aves'),
              ($3, 970903, 'Triggerus c', 'Trigger C', 'aves')`,
      [A, B, EXTRA],
    );
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state) SELECT $1, s, 'collected' FROM unnest($2::uuid[]) s`,
      [USER, [A, B, EXTRA]],
    );
  }, 120_000);

  afterAll(async () => {
    if (!db) return;
    await cleanup();
    await db.end();
  }, 120_000);

  it("stamps only the species whose photos changed", async () => {
    const onA = await add(A);
    const withExtra = await add(B);
    await db.query(`INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $2)`, [withExtra, EXTRA]);

    await reset();
    await db.query(`UPDATE captures_all SET quality_rating = 4 WHERE id = $1`, [onA]);
    expect(await stamped()).toEqual([]);

    await db.query(`UPDATE captures_all SET taken_at = taken_at - interval '1 day' WHERE id = $1`, [onA]);
    expect(await stamped()).toEqual([A]);

    await reset();
    await db.query(`UPDATE captures_all SET species_id = $2 WHERE id = $1`, [onA, B]);
    expect(await stamped()).toEqual([A, B]);

    await reset();
    await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [withExtra]);
    expect(await stamped()).toEqual([B, EXTRA]);

    await reset();
    await db.query(`UPDATE captures_all SET deleted_at = now() WHERE id = $1`, [onA]);
    expect(await stamped()).toEqual([B]);
  });

  it("runs a bulk update quickly after small ones on the same connection", { timeout: 120_000 }, async () => {
    await db.query(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at)
       SELECT $1, $2, 'trigger-bench-' || g, now() - g * interval '1 minute' FROM generate_series(1, 60000) g`,
      [USER, A],
    );
    await db.query(`ANALYZE captures_all`);
    const one = await add(A);
    for (let i = 0; i < 6; i++)
      await db.query(`UPDATE captures_all SET hidden_at = ${i % 2 ? "NULL" : "now()"} WHERE id = $1`, [one]);

    const started = Date.now();
    const res = await db.query(`UPDATE captures_all SET hidden_at = now() WHERE user_id = $1 AND species_id = $2`, [
      USER,
      A,
    ]);
    expect(res.rowCount).toBeGreaterThanOrEqual(60_000);
    expect(Date.now() - started).toBeLessThan(30_000);
  });
});
