// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Applies a hand-built change set, then undoes it: Lifer's own values survive, and undo restores.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Group } from "./plan.js";
import type { ChangeSet, PhotoChange } from "./types.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000931";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000932";
const ALL: Group[] = ["ratings", "flags", "keywords", "locations", "albums", "smartAlbums"];

describe.skipIf(!url)("applyChangeSet", () => {
  let db: pg.Pool;
  let dir: string;
  let mod: typeof import("./apply.js");
  let a: string;
  let b: string;
  const ctx = { signal: new AbortController().signal, update: () => {}, throwIfCancelled: () => {} };

  const photo = (captureId: string, over: Partial<PhotoChange>): PhotoChange => ({
    captureId,
    path: `/p/${captureId}.jpg`,
    rating: null,
    flag: null,
    label: null,
    keywords: [],
    keywordPaths: [],
    caption: null,
    lat: null,
    lon: null,
    takenAt: null,
    current: { rating: null, flag: null, lat: null, lon: null, tags: [] },
    ...over,
  });
  const row = async (id: string) =>
    (await db.query(`SELECT quality_rating, cull_verdict, tags, lat::float8 AS lat FROM captures WHERE id = $1`, [id]))
      .rows[0];

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "lifer-lr-apply-"));
    process.env.DATABASE_URL = url;
    process.env.APP_DATA_DIR = dir;
    db = new pg.Pool({ connectionString: url });
    mod = await import("./apply.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'lrapply@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915931, 'Lrapplia alba', 'Apply Heron', 'aves')`,
      [SPECIES],
    );
    const insert = async (fp: string, rating: number | null) =>
      (
        await db.query<{ id: string }>(
          `INSERT INTO captures_all (user_id, species_id, fingerprint, quality_rating, tags) VALUES ($1, $2, $3, $4, '{pond}') RETURNING id`,
          [USER, SPECIES, fp, rating],
        )
      ).rows[0].id;
    a = await insert("lra-1", null);
    b = await insert("lra-2", 2);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes new values, keeps Lifer's own, makes albums, and undoes it all", async () => {
    const cs: ChangeSet = {
      photos: [
        photo(a, {
          rating: 4,
          flag: "pick",
          keywords: ["Heron", "Pond"],
          lat: 49.1,
          lon: -123.1,
          current: { rating: null, flag: null, lat: null, lon: null, tags: ["pond"] },
        }),
        photo(b, { rating: 5, current: { rating: 2, flag: null, lat: null, lon: null, tags: ["pond"] } }),
      ],
      albums: [
        { name: "Herons", path: [], captureIds: [a, b], missing: 0, rules: null },
        { name: "Good", path: [], captureIds: [], missing: 0, rules: { version: 2, query: { ratingMin: "4" } } },
      ],
      unmapped: [],
      notInLifer: [],
      total: 2,
    };
    const result = await mod.applyChangeSet(ctx, USER, cs, new Set(ALL), false);
    expect(result).toEqual({ photos: 1, albums: 2 });
    expect(await row(a)).toMatchObject({ quality_rating: 4, cull_verdict: "pick", tags: ["pond", "Heron"], lat: 49.1 });
    expect((await row(b)).quality_rating).toBe(2);
    const albums = await db.query(`SELECT name FROM albums WHERE user_id = $1 ORDER BY name`, [USER]);
    expect(albums.rows.map((r) => r.name)).toEqual(["Good", "Herons"]);
    expect(await mod.undoSummary(USER)).toMatchObject({ photos: 1, albums: 2 });

    expect(await mod.undoImport(USER)).toBe(true);
    expect(await row(a)).toMatchObject({ quality_rating: null, cull_verdict: null, tags: ["pond"], lat: null });
    expect((await db.query(`SELECT 1 FROM albums WHERE user_id = $1`, [USER])).rowCount).toBe(0);
    expect(await mod.undoImport(USER)).toBe(false);
  });

  it("lets Lightroom win a conflict when asked", async () => {
    const cs: ChangeSet = {
      photos: [photo(b, { rating: 5, current: { rating: 2, flag: null, lat: null, lon: null, tags: ["pond"] } })],
      albums: [],
      unmapped: [],
      notInLifer: [],
      total: 1,
    };
    await mod.applyChangeSet(ctx, USER, cs, new Set<Group>(["ratings"]), true);
    expect((await row(b)).quality_rating).toBe(5);
    await mod.undoImport(USER);
    expect((await row(b)).quality_rating).toBe(2);
  });
});
