// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The background search-name rebuild after a first catalog load runs while the user is already in
// the app: a pack apply, a capture and a rename landing meanwhile must neither deadlock nor fail.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool as appPool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { lockReferenceData } from "@lifer/core/lib/referenceDataLock.js";
import { ensureSpeciesSearchNames, whenSpeciesSearchReady } from "./search.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "a0000000-0000-4000-8000-0000000000a1";
const A = "a0000000-0000-4000-8000-00000000000a";
const B = "a0000000-0000-4000-8000-00000000000b";
const C = "a0000000-0000-4000-8000-00000000000c";
const D = "a0000000-0000-4000-8000-00000000000d";
const IDS = [A, B, C, D];

describe.skipIf(!url)("species search rebuild under concurrent writes (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });

  const cleanup = async () => {
    await pool.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await pool.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await pool.query(`DELETE FROM species WHERE id = ANY($1)`, [IDS]);
  };
  beforeAll(async () => {
    await cleanup();
    await pool.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'rebuild@test', 'x')`, [USER]);
    // B, C and D's search names sit before A's, so a whole-table rebuild reaches them first.
    for (const [id, name, gbif] of [
      [B, "Rebuild Bee", 990000002],
      [C, "Rebuild Sea", 990000003],
      [D, "Rebuild Dee", 990000004],
      [A, "Rebuild Ay", 990000001],
    ] as const) {
      await pool.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $3, 'Aves')`,
        [id, gbif, name],
      );
    }
  });
  afterAll(async () => {
    await whenSpeciesSearchReady();
    await cleanup();
    await pool.end();
    await appPool.end();
  });

  it("lets a pack apply, a capture insert and a rename run while the rebuild does", async () => {
    const errors = vi.spyOn(log, "error");
    const pack = await pool.connect();
    try {
      // A pack apply: one transaction under the reference-data lock, touching names statement by statement.
      await pack.query("BEGIN");
      await lockReferenceData(pack);
      await pack.query(`UPDATE species SET common_name = 'Renamed Ay' WHERE id = $1`, [A]);

      const rebuild = ensureSpeciesSearchNames(true);
      // Let the rebuild get going and queue behind the pack.
      for (let i = 0; i < 50; i++) {
        const waiting = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> $1`,
          [(await pack.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0].pid],
        );
        if (waiting.rowCount) break;
        await new Promise((r) => setTimeout(r, 20));
      }

      const capture = pool.query(`INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, 'rebuild-fp')`, [
        USER,
        B,
      ]);
      const rename = pool.query(`UPDATE species SET common_name = 'Renamed Dee' WHERE id = $1`, [D]);
      await pack.query(`UPDATE species SET common_name = 'Renamed Bee' WHERE id = $1`, [B]);
      await pack.query(`DELETE FROM species WHERE id = $1`, [C]);
      await pack.query("COMMIT");
      await Promise.all([capture, rename, rebuild]);
    } finally {
      pack.release();
    }

    expect(errors).not.toHaveBeenCalled();
    const names = await pool.query<{ species_id: string; name: string }>(
      `SELECT species_id, name FROM species_search_names WHERE species_id = ANY($1) AND kind = 'common' ORDER BY name`,
      [IDS],
    );
    expect(names.rows).toEqual([
      { species_id: A, name: "Renamed Ay" },
      { species_id: B, name: "Renamed Bee" },
      { species_id: D, name: "Renamed Dee" },
    ]);
  });
});
