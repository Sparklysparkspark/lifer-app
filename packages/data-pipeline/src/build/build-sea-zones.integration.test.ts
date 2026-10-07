// Integration test (real Postgres required, same local DB as `npm run migrate`): replacing
// MEOW-style zones with a new set removes the old zones and everything hanging off them, keeps an
// unchanged zone's checklist, and relinks regions. Runs inside a transaction that's always rolled
// back, but it rewrites every region's nearby_sea_zone_ids inside it, so point DATABASE_URL at a
// scratch database.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { replaceSeaZones } from "./build-sea-zones.js";
import { ringBoundingBox, ringToWktPolygon, type Point } from "@lifer/core/lib/geometry.js";
import type { SeaZone } from "../fetch/fetch-iho-sea-areas.js";

function box(minLon: number, minLat: number, maxLon: number, maxLat: number): Point[] {
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ];
}

function zone(name: string, ring: Point[]): SeaZone {
  return { name, wkt: ringToWktPolygon(ring), bbox: ringBoundingBox(ring), outline: ring };
}

function boundary(ring: Point[]) {
  const b = ringBoundingBox(ring);
  return JSON.stringify({ type: "Feature", properties: {}, bbox: [b.minLon, b.minLat, b.maxLon, b.maxLat], geometry: { type: "Polygon", coordinates: [ring] } });
}

const NORTH_SEA = box(0, 50, 10, 60);
const KEPT_SEA = box(20, 50, 30, 60);
const NEW_ZONES = [zone("North Sea", NORTH_SEA), zone("Kept Sea", KEPT_SEA), zone("Far Sea", box(100, -10, 110, 0))];

let client: PoolClient;
let speciesId: string;
const ids: Record<string, string> = {};

async function insertZone(name: string, wkt: string): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat, occurrence_computed_at)
     VALUES ($1, $2, 0, 0, 1, 1, now()) RETURNING id`,
    [name, wkt],
  );
  await client.query(`INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $2, 7)`, [res.rows[0].id, speciesId]);
  return res.rows[0].id;
}

async function insertRegion(name: string, ring: Point[] | null, nearby: string[] | null = null): Promise<string> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO regions (name, boundary_geojson, nearby_sea_zone_ids) VALUES ($1, $2, $3) RETURNING id`,
    [name, ring ? boundary(ring) : null, nearby],
  );
  return res.rows[0].id;
}

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  // Whatever zones the database already has would count as removed too; start from none.
  await client.query(`DELETE FROM sea_zones`);
  speciesId = (
    await client.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class) VALUES (999999998, 'Testus marinus', 'Test Fish', 'actinopterygii') RETURNING id`,
    )
  ).rows[0].id;
  // MEOW-like zones, one with the same name as a new zone but another shape, and one zone that is
  // already exactly what the new set has.
  ids.puget = await insertZone("Puget Trough/Georgia Basin", ringToWktPolygon(box(-125, 47, -122, 50)));
  ids.oldNorthSea = await insertZone("North Sea", ringToWktPolygon(box(-1, 51, 9, 59)));
  ids.kept = await insertZone("Kept Sea", ringToWktPolygon(KEPT_SEA));
  await client.query(`INSERT INTO downloaded_packs (pack_id, region) VALUES ('seazone-puget_trough_georgia_basin', 'Puget Trough/Georgia Basin'), ('seazone-kept_sea', 'Kept Sea')`);
  await client.query(`INSERT INTO pack_species (pack_id, species_id) VALUES ('seazone-puget_trough_georgia_basin', $1)`, [speciesId]);

  ids.coastal = await insertRegion("Test Coastal Province", box(-2, 55, 0, 57), [ids.puget]);
  ids.twoSeas = await insertRegion("Test Isthmus", box(10, 54, 20, 56));
  ids.inland = await insertRegion("Test Inland Province", box(40, 40, 42, 42), [ids.oldNorthSea]);
  ids.noBoundary = await insertRegion("Test Boundaryless", null, [ids.puget]);
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

describe("replaceSeaZones", () => {
  it("removes old zones with their species and pack rows, keeps an unchanged zone, inserts the rest", async () => {
    const result = await replaceSeaZones(client, NEW_ZONES);
    expect(result.removed.sort()).toEqual(["North Sea", "Puget Trough/Georgia Basin"]);
    expect(result.inserted.sort()).toEqual(["Far Sea", "North Sea"]);
    expect(result.kept).toBe(1);
    expect(result.speciesRowsRemoved).toBe(2);
    expect(result.downloadedPacksRemoved).toEqual(["seazone-puget_trough_georgia_basin"]);

    const zones = await client.query<{ id: string; name: string; occurrence_computed_at: Date | null }>(`SELECT id, name, occurrence_computed_at FROM sea_zones ORDER BY name`);
    expect(zones.rows.map((z) => z.name)).toEqual(["Far Sea", "Kept Sea", "North Sea"]);
    const northSea = zones.rows.find((z) => z.name === "North Sea")!;
    // A new id, so installs drop the old shape's row and checklist on their next catalog update.
    expect(northSea.id).not.toBe(ids.oldNorthSea);
    expect(northSea.occurrence_computed_at).toBeNull();
    const kept = zones.rows.find((z) => z.name === "Kept Sea")!;
    expect(kept.id).toBe(ids.kept);
    expect(kept.occurrence_computed_at).not.toBeNull();

    const species = await client.query<{ sea_zone_id: string }>(`SELECT sea_zone_id FROM sea_zone_species WHERE species_id = $1`, [speciesId]);
    expect(species.rows.map((r) => r.sea_zone_id)).toEqual([ids.kept]);
    const packs = await client.query<{ pack_id: string }>(`SELECT pack_id FROM downloaded_packs WHERE pack_id LIKE 'seazone-%' ORDER BY pack_id`);
    expect(packs.rows.map((r) => r.pack_id)).toEqual(["seazone-kept_sea"]);
    const packSpecies = await client.query(`SELECT 1 FROM pack_species WHERE species_id = $1`, [speciesId]);
    expect(packSpecies.rowCount).toBe(0);
  });

  it("relinks every region: coastal ones to their zones, inland ones to none, boundaryless ones to NULL", async () => {
    const result = await replaceSeaZones(client, NEW_ZONES);
    const zoneId = async (name: string) => (await client.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [name])).rows[0].id;
    const nearby = async (regionId: string) =>
      (await client.query<{ nearby_sea_zone_ids: string[] | null }>(`SELECT nearby_sea_zone_ids FROM regions WHERE id = $1`, [regionId])).rows[0].nearby_sea_zone_ids;
    expect(await nearby(ids.coastal)).toEqual([await zoneId("North Sea")]);
    expect((await nearby(ids.twoSeas))?.sort()).toEqual([await zoneId("North Sea"), await zoneId("Kept Sea")].sort());
    expect(await nearby(ids.inland)).toEqual([]);
    expect(await nearby(ids.noBoundary)).toBeNull();
    expect(result.regionsWithZones).toBeGreaterThanOrEqual(2);
  });

  it("changes nothing on a second run with the same zones", async () => {
    await replaceSeaZones(client, NEW_ZONES);
    const before = await client.query(`SELECT id, name FROM sea_zones ORDER BY name`);
    const again = await replaceSeaZones(client, NEW_ZONES);
    expect(again.removed).toEqual([]);
    expect(again.inserted).toEqual([]);
    expect(again.kept).toBe(3);
    const after = await client.query(`SELECT id, name FROM sea_zones ORDER BY name`);
    expect(after.rows).toEqual(before.rows);
  });

  it("refuses two zones with the same name", async () => {
    await expect(replaceSeaZones(client, [zone("Twin Sea", NORTH_SEA), zone("Twin Sea", KEPT_SEA)])).rejects.toThrow(/Twin Sea/);
  });
});
