// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Each test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyGazetteer, assignRegions, loadRegionRows, parseCities, verifyGazetteer } from "./gazetteer.js";

const url = process.env.TEST_DATABASE_URL;
const line = (id: number, name: string, lat: number, lon: number, pop: number, alts = "") =>
  [id, name, name, alts, lat, lon, "P", "PPL", "CA", "", "02", "", "", "", pop, "", "", "", "2026-01-01"].join("\t");

describe.skipIf(!url)("gazetteer load", () => {
  const db = new pg.Pool({ connectionString: url });
  let client: pg.PoolClient;

  beforeEach(async () => {
    client = await db.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM gazetteer_places");
    await client.query("DELETE FROM regions");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  afterAll(async () => {
    await db.end();
  });

  it("stores towns with their regions, writes nothing on a rerun and drops towns the source lost", async () => {
    const insert = async (name: string, parent: string | null, code: string | null, boundary: unknown = null) =>
      (
        await client.query<{ id: string }>(
          `INSERT INTO regions (name, parent_id, external_codes, boundary_geojson) VALUES ($1, $2, $3, $4) RETURNING id`,
          [name, parent, code ? [code] : [], boundary && JSON.stringify(boundary)],
        )
      ).rows[0].id;
    const world = await insert("World", null, null);
    const na = await insert("North America", world, null);
    const ca = await insert("Canada", na, "CAN");
    const ring = [
      [-139, 48],
      [-114, 48],
      [-114, 60],
      [-139, 60],
      [-139, 48],
    ];
    const bc = await insert("British Columbia", ca, "CAN.2_1", { geometry: { type: "Polygon", coordinates: [ring] } });
    const text = [
      line(6113335, "Prince George", 53.9166, -122.753, 78943),
      line(6173331, "Vancouver", 49.2497, -123.1193, 631486, "Vankuver,YVR"),
    ].join("\n");
    const places = assignRegions(await loadRegionRows(client), parseCities(text), new Map([["CA", "CAN"]]));

    expect(await applyGazetteer(client, places)).toEqual({ written: 2, removed: 0, total: 2 });
    const row = (
      await client.query(
        `SELECT country_region_id, province_region_id, search_text FROM gazetteer_places WHERE geoname_id = 6173331`,
      )
    ).rows[0];
    expect(row).toEqual({
      country_region_id: ca,
      province_region_id: bc,
      search_text: "|vancouver|vancouver|vankuver|",
    });
    expect(await applyGazetteer(client, places)).toEqual({ written: 0, removed: 0, total: 2 });
    expect(await applyGazetteer(client, places.slice(0, 1))).toEqual({ written: 0, removed: 1, total: 1 });

    const report = await verifyGazetteer(client);
    expect(report[0]).toMatch(/^1 places in 1 countries; 1 with a province/);
    expect(report).toContain("Prince George: Prince George, British Columbia, Canada (78943)");
    expect(report).toContain("Tofino: not in this set");
  });
});
