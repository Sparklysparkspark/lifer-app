// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// Finding the region at a point reads each outline's stored boxes (migration 200), which the
// database keeps in step with the outline.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const REGION = "eeeeeeee-0000-4000-8000-000000000a01";
const BROKEN = "eeeeeeee-0000-4000-8000-000000000a02";

// Two islands in the far south Pacific, where no real region lies, wrapped as a Feature.
const islands = (shift: number) => ({
  type: "Feature",
  geometry: {
    type: "MultiPolygon",
    coordinates: [
      [
        [
          [-150 + shift, -60],
          [-149 + shift, -60],
          [-149 + shift, -59],
          [-150 + shift, -59],
          [-150 + shift, -60],
        ],
      ],
      [
        [
          [-140, -60],
          [-139, -60],
          [-139, -58],
          [-140, -58],
          [-140, -60],
        ],
      ],
    ],
  },
});

describe.skipIf(!url)("region at a point", () => {
  let db: pg.Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM regions WHERE id = ANY($1::uuid[])`, [[REGION, BROKEN]]);
  });

  afterAll(async () => {
    if (db) {
      await db.query(`DELETE FROM regions WHERE id = ANY($1::uuid[])`, [[REGION, BROKEN]]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("stores a box per outer ring and keeps it in step with the outline", async () => {
    await db.query(`INSERT INTO regions (id, name, boundary_geojson) VALUES ($1, 'Zzislands', $2)`, [
      REGION,
      JSON.stringify(islands(0)),
    ]);
    const boxes = async () =>
      (await db.query(`SELECT outline_boxes FROM regions WHERE id = $1`, [REGION])).rows[0].outline_boxes;
    expect(await boxes()).toEqual([
      [-150, -60, -149, -59],
      [-140, -60, -139, -58],
    ]);
    await db.query(`UPDATE regions SET boundary_geojson = $2 WHERE id = $1`, [REGION, JSON.stringify(islands(5))]);
    expect((await boxes())[0]).toEqual([-145, -60, -144, -59]);
  });

  it("finds the region from its boxes, in either island", async () => {
    const { regionAt } = await import("./regionAt.js");
    expect(await regionAt(-59.5, -144.5)).toEqual({ id: REGION, name: "Zzislands" });
    expect(await regionAt(-59, -139.5)).toEqual({ id: REGION, name: "Zzislands" });
    // Where the first island was before it moved.
    expect(await regionAt(-59.5, -149.5)).toBeNull();
  });

  it("saves a malformed outline with no boxes instead of failing", async () => {
    await db.query(`INSERT INTO regions (id, name, boundary_geojson) VALUES ($1, 'Zzbroken', $2)`, [
      BROKEN,
      JSON.stringify({ type: "Polygon", coordinates: [[["a", "b"]]] }),
    ]);
    const res = await db.query(`SELECT outline_boxes FROM regions WHERE id = $1`, [BROKEN]);
    expect(res.rows[0].outline_boxes).toBeNull();
  });
});
