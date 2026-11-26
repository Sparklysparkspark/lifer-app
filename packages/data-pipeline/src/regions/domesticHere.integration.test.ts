// Integration test (real Postgres required, the scratch TEST_DATABASE_URL): a domestic breed is
// domestic where its wild species is introduced, wild in its native country, and a farm animal is
// domestic everywhere. Runs inside a transaction that's always rolled back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { domesticSpeciesIn } from "./domesticHere.js";

let client: PoolClient;
const ids: Record<string, string> = {};

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  const species = async (key: number, name: string, domestic: boolean) => {
    const res = await client.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, taxon_class) VALUES ($1, $2, 'aves') RETURNING id`,
      [key, name],
    );
    await client.query(
      `INSERT INTO species_traits (species_id, domestic, source_attribution) VALUES ($1, $2, 'test')`,
      [res.rows[0].id, domestic],
    );
    return res.rows[0].id;
  };
  ids.chicken = await species(999999981, "Testus gallus", false);
  ids.cow = await species(999999982, "Testus bos", true);
  ids.wild = await species(999999983, "Testus ferus", false);
  const region = async (name: string, parent: string | null, codes: string[], group: string | null) =>
    (
      await client.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, sovereignty_group) VALUES ($1, $2, $3, $4) RETURNING id`,
        [name, parent, codes, group],
      )
    ).rows[0].id;
  ids.farmland = await region("Testfarmland", null, ["ZZF"], "ZZF");
  ids.province = await region("Testfarm Province", ids.farmland, ["ZZF-P"], null);
  ids.homeland = await region("Testhomeland", null, ["ZZH"], "ZZH");
  // The chicken's wild species is introduced in Farmland only; the wild bird is introduced there too.
  await client.query(
    `INSERT INTO species_nonnative_countries (species_id, country_iso3) VALUES ($1, 'ZZF'), ($2, 'ZZF')`,
    [ids.chicken, ids.wild],
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

describe("domesticSpeciesIn", () => {
  const breeds = ["Testus gallus"];

  it("counts a breed as domestic in a country, and its provinces, where it's introduced", async () => {
    for (const region of [ids.farmland, ids.province]) {
      const { ids: here } = await domesticSpeciesIn(client, region, breeds);
      expect(here.has(ids.chicken)).toBe(true);
      expect(here.has(ids.cow)).toBe(true);
      // Introduced, but not a domestic breed: stays wild.
      expect(here.has(ids.wild)).toBe(false);
    }
  });

  it("keeps the breed wild in its native country, while a farm animal is domestic everywhere", async () => {
    const { ids: here, gbifKeys } = await domesticSpeciesIn(client, ids.homeland, breeds);
    expect(here.has(ids.chicken)).toBe(false);
    expect(here.has(ids.cow)).toBe(true);
    expect(gbifKeys.has(999999982)).toBe(true);
  });
});
