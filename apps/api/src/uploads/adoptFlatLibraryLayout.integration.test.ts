// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run adoptFlatLibraryLayout
// A library flattened by hand ("Lifer Photos/Birds/..." moved up to "Birds/...") gets its stored
// paths updated on the next start, but only for files that really are at the new location.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000109";
const SPECIES = "eeeeeeee-0000-4000-8000-00000000000a";

describe.skipIf(!url)("adoptFlatLibraryLayout", () => {
  let db: pg.Pool;
  let dataDir: string;
  const refs = { moved: "", notMoved: "", elsewhere: "" };
  const captureIds: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "lifer-flatten-"));
    process.env.DATABASE_URL = url;
    process.env.DATA_DIR = dataDir;
    process.env.APP_DATA_DIR = path.join(tmpdir(), `lifer-flatten-app-${process.pid}`);
    db = new pg.Pool({ connectionString: url });
    const legacy = path.join(dataDir, "Lifer Photos");
    refs.moved = path.join(legacy, "Birds", "Osprey", "Adjusted", "IMG_0001.jpg");
    refs.notMoved = path.join(legacy, "Birds", "Osprey", "Adjusted", "IMG_0002.jpg");
    refs.elsewhere = "/Volumes/Card/IMG_0003.jpg";
    // The user moved IMG_0001 up a level; IMG_0002 was never found at either place.
    mkdirSync(path.join(dataDir, "Birds", "Osprey", "Adjusted"), { recursive: true });
    writeFileSync(path.join(dataDir, "Birds", "Osprey", "Adjusted", "IMG_0001.jpg"), "x");

    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'flatten@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910901, 'Testus flatus', 'Test Osprey', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    for (const [i, ref] of [refs.moved, refs.notMoved, refs.elsewhere].entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
        [USER, SPECIES, `flatten-${i}`],
      );
      captureIds.push(c.rows[0].id);
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', $2, $3, 'h', 1)`,
        [c.rows[0].id, ref, ref !== refs.elsewhere],
      );
    }
  });

  afterAll(async () => {
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("../db.js");
    await pool.end();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("repoints only the files that moved", async () => {
    const { ORIGINALS_DIR } = await import("../config.js");
    expect(ORIGINALS_DIR).toBe(dataDir);
    const { adoptFlatLibraryLayout } = await import("./adoptFlatLibraryLayout.js");
    await adoptFlatLibraryLayout();
    await adoptFlatLibraryLayout(); // a second start changes nothing

    const rows = await db.query<{ capture_id: string; ref: string }>(`SELECT capture_id, ref FROM originals WHERE capture_id = ANY($1::uuid[])`, [
      captureIds,
    ]);
    const refOf = (i: number) => rows.rows.find((r) => r.capture_id === captureIds[i])!.ref;
    expect(refOf(0)).toBe(path.join(dataDir, "Birds", "Osprey", "Adjusted", "IMG_0001.jpg"));
    expect(refOf(1)).toBe(refs.notMoved);
    expect(refOf(2)).toBe(refs.elsewhere);
  });
});
