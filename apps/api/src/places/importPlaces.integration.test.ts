// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// POST /places/apply: the places staged on the import screen, applied to the imported photos in one
// transaction and one undo step.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000a11";
const SPECIES = "eeeeeeee-0000-4000-8000-000000000a12";
const REGION = "eeeeeeee-0000-4000-8000-000000000a13";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "import-places@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const square = (w: number, s: number, e: number, n: number) =>
  JSON.stringify({
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  });

type Row = {
  id: string;
  lat: number | null;
  lon: number | null;
  region_id: string | null;
  location_label: string | null;
  location_source: string | null;
  location_accuracy_m: number | null;
};

describe.skipIf(!url)("import places", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const ids: Record<string, string> = {};

  const call = (method: "GET" | "POST", route: string, payload?: object) =>
    app.inject({ method, url: `/api${route}`, payload });
  const read = async () => {
    const res = await db.query<Row>(
      `SELECT id, lat::float8 AS lat, lon::float8 AS lon, region_id, location_label, location_source,
              location_accuracy_m::float8 AS location_accuracy_m
       FROM captures WHERE user_id = $1`,
      [USER],
    );
    return Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, res.rows.find((r) => r.id === id)!]));
  };

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { savedSpotRoutes } = await import("./savedSpots.js");
    const { locationRoutes } = await import("../captures/locationHistory.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'import-places@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 915912, 'Importia alba', 'Import Bird', 'aves')`,
      [SPECIES],
    );
    await db.query(`INSERT INTO regions (id, name, boundary_geojson) VALUES ($1, 'Importland', $2)`, [
      REGION,
      square(-125, 48, -120, 55),
    ]);
    // As the import leaves them: camera GPS where the file had it, the typed label, nothing else.
    const photos: Array<[string, number | null, number | null, string | null]> = [
      ["pondPlain1", null, null, null],
      ["pondPlain2", null, null, "North shore"],
      ["pondGps", 49.3, -123.2, null],
      ["regionOnly", null, null, null],
      ["sessionPlain", null, null, null],
      ["sessionGps", 49.28, -123.12, null],
      ["unplacedGps", 49.2, -123.0, null],
      ["unplaced", null, null, null],
    ];
    for (const [key, lat, lon, label] of photos) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, lat, lon, location_label)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [USER, SPECIES, `import-place-${key}`, lat, lon, label],
      );
      ids[key] = c.rows[0].id;
    }
    app = Fastify();
    await app.register(savedSpotRoutes, { prefix: "/api" });
    await app.register(locationRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await cleanup();
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("applies three groups' places as one step, and one undo puts back exactly those photos", async () => {
    const spot = await call("POST", "/saved-spots", {
      name: "King Fisher Pond",
      lat: 49.1,
      lon: -123.1,
      radiusM: 500,
      geoprivacy: "obscured",
    });
    expect(spot.statusCode, spot.body).toBe(200);
    const spotId = spot.json().id;
    // An earlier change, which the import's undo must leave alone.
    const { applyLocation } = await import("../captures/locationHistory.js");
    expect(await applyLocation(USER, [ids.unplacedGps], { lat: 49.25, lon: -123.05, source: "map" })).toBe(1);
    const before = await read();

    const res = await call("POST", "/places/apply", {
      places: [
        { captureIds: [ids.pondPlain1, ids.pondGps], spotId },
        { captureIds: [ids.pondPlain2], spotId, label: "North shore" },
        { captureIds: [ids.regionOnly], regionId: REGION },
        { captureIds: [ids.sessionPlain, ids.sessionGps], lat: 49.28, lon: -123.12, regionId: REGION },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ applied: 6 });

    const after = await read();
    // A spot with a privacy radius: photos without a point take its centre and radius.
    expect(after.pondPlain1).toMatchObject({
      lat: 49.1,
      lon: -123.1,
      location_label: "King Fisher Pond",
      location_source: "spot",
      location_accuracy_m: 500,
    });
    // The typed label stays.
    expect(after.pondPlain2).toMatchObject({ lat: 49.1, location_label: "North shore", location_source: "spot" });
    // Camera GPS keeps its own point and takes the name.
    expect(after.pondGps).toMatchObject({
      lat: 49.3,
      lon: -123.2,
      location_label: "King Fisher Pond",
      location_source: null,
      location_accuracy_m: null,
    });
    // Region only: no point, so it still waits in Needs placing.
    expect(after.regionOnly).toMatchObject({ lat: null, lon: null, region_id: REGION, location_label: null });
    // Another group's camera point: the photo without GPS takes it, the one with GPS keeps its own.
    expect(after.sessionPlain).toMatchObject({ lat: 49.28, lon: -123.12, location_source: "map", region_id: REGION });
    expect(after.sessionGps).toMatchObject({ lat: 49.28, lon: -123.12, location_source: null });
    // Not in the request: untouched.
    expect(after.unplaced).toEqual(before.unplaced);
    expect(after.unplacedGps).toEqual(before.unplacedGps);
    expect((await call("GET", "/saved-spots")).json().spots[0].lastUsedAt).toEqual(expect.any(String));

    const undo = await call("POST", "/captures/location/undo");
    // The earlier coordinates are still one step back.
    expect(undo.json()).toEqual({ restored: 6, canUndo: true });
    expect(await read()).toEqual(before);
  });

  it("refuses an entry with no place and half a point, changing nothing", async () => {
    const before = await read();
    expect((await call("POST", "/places/apply", { places: [{ captureIds: [ids.unplaced] }] })).statusCode).toBe(400);
    expect((await call("POST", "/places/apply", { places: [{ captureIds: [ids.unplaced], lat: 1 }] })).statusCode).toBe(
      400,
    );
    expect(
      (
        await call("POST", "/places/apply", {
          places: [{ captureIds: [ids.unplaced], spotId: "eeeeeeee-0000-4000-8000-0000000000ff" }],
        })
      ).statusCode,
    ).toBe(404);
    expect(await read()).toEqual(before);
  });

  it("rolls the whole batch back when one entry fails", async () => {
    const before = await read();
    const res = await call("POST", "/places/apply", {
      places: [
        { captureIds: [ids.unplaced], regionId: REGION },
        // A region that doesn't exist breaks the foreign key part way through.
        { captureIds: [ids.regionOnly], regionId: "eeeeeeee-0000-4000-8000-0000000000fe" },
      ],
    });
    expect(res.statusCode).toBe(500);
    expect(await read()).toEqual(before);
  });
});
