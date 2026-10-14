// Integration test (real Postgres required, the scratch TEST_DATABASE_URL): a seed gives a new
// species an unrated placeholder and never touches a tier the tiers stage already wrote. Runs
// inside a transaction that's always rolled back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { insertSeedRarity } from "./load-seed.js";

let client: PoolClient;
let speciesId: string;

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  const res = await client.query(
    `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class)
     VALUES (999999999, 'Testus regressionus', 'Test Species', 'mammalia')
     RETURNING id`,
  );
  speciesId = res.rows[0].id;
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

describe("insertSeedRarity", () => {
  it("starts a species new to the catalog as unrated, with the tiers stage's no-data reason", async () => {
    await insertSeedRarity(client, speciesId);

    const res = await client.query(`SELECT tier, tier_reason, tier_explain FROM species_rarity WHERE species_id = $1`, [
      speciesId,
    ]);
    expect(res.rows[0]).toEqual({ tier: "unrated", tier_reason: "no_data", tier_explain: null });
  });

  it("leaves a tier the tiers stage already wrote untouched on a reseed", async () => {
    await client.query(
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier, tier_reason, tier_explain)
       VALUES ($1, 0, 0, 0, 'uncommon', 'rated', '{"v":1}')`,
      [speciesId],
    );

    await insertSeedRarity(client, speciesId);

    const res = await client.query(`SELECT tier, tier_reason, tier_explain FROM species_rarity WHERE species_id = $1`, [
      speciesId,
    ]);
    expect(res.rows[0]).toEqual({ tier: "uncommon", tier_reason: "rated", tier_explain: { v: 1 } });
  });
});
