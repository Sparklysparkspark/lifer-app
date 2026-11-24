// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. Each test rolls back.
import pg from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyAliases } from "./regionAliases.js";
import { applyPlaces, type Place } from "./places.js";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("places and aliases stored on regions", () => {
  const db = new pg.Pool({ connectionString: url });
  let client: pg.PoolClient;

  beforeEach(async () => {
    client = await db.connect();
    await client.query("BEGIN");
    await client.query("DELETE FROM regions");
  });
  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });
  afterAll(async () => {
    await db.end();
  });

  const insert = async (name: string, parent: string | null, code: string | null = null) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes) VALUES ($1, $2, $3) RETURNING id`,
        [name, parent, code ? [code] : []],
      )
    ).rows[0].id;

  it("writes the example city, the populous child and the aliases, then changes nothing on a rerun", async () => {
    const world = await insert("World", null);
    const europe = await insert("Europe", world);
    const nl = await insert("Netherlands", europe, "NLD");
    const utrecht = await insert("Utrecht", nl);
    const places: Place[] = [
      {
        name: "Amsterdam",
        capital: true,
        national: true,
        population: 900,
        iso3: "NLD",
        iso2: "NL",
        adm1Name: null,
        point: [0, 0],
      },
      {
        name: "Utrecht",
        capital: false,
        national: false,
        population: 350,
        iso3: "NLD",
        iso2: "NL",
        adm1Name: "Utrecht",
        point: [0, 0],
      },
    ];
    const first = await applyPlaces(client, places);
    expect(first.changed).toBeGreaterThan(0);
    const row = (await client.query(`SELECT example_city, populous_child_id FROM regions WHERE id = $1`, [nl])).rows[0];
    expect(row).toEqual({ example_city: "Amsterdam", populous_child_id: utrecht });
    expect((await applyPlaces(client, places)).changed).toBe(0);

    expect((await applyAliases(client)).written).toBe(1);
    expect((await client.query(`SELECT aliases FROM regions WHERE id = $1`, [nl])).rows[0].aliases).toContain(
      "Holland",
    );
    expect((await applyAliases(client)).written).toBe(0);
  });
});
