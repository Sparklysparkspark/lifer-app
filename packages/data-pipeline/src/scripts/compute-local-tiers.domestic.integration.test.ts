// Integration test (real Postgres required, the scratch TEST_DATABASE_URL): writing a domestic
// tier clears the vagrant flag an earlier step set (a chicken in Belize), and leaves others alone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import { writeTiers, type ComputedTier } from "./compute-local-tiers.js";

const ids: { region?: string; chicken?: string; stray?: string } = {};

beforeAll(async () => {
  ids.region = (
    await pool.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Testcoop') RETURNING id`)
  ).rows[0].id;
  const species = async (key: number, name: string) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO species (gbif_key, scientific_name, taxon_class) VALUES ($1, $2, 'aves') RETURNING id`,
        [key, name],
      )
    ).rows[0].id;
  ids.chicken = await species(999999971, "Testus pullus");
  ids.stray = await species(999999972, "Testus errans");
  await pool.query(
    `INSERT INTO region_species (region_id, species_id, is_vagrant) VALUES ($1, $2, true), ($1, $3, true)`,
    [ids.region, ids.chicken, ids.stray],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM region_species WHERE region_id = $1`, [ids.region]);
  await pool.query(`DELETE FROM species WHERE id = ANY($1)`, [[ids.chicken, ids.stray]]);
  await pool.query(`DELETE FROM regions WHERE id = $1`, [ids.region]);
  await pool.end();
});

describe("writeTiers", () => {
  it("clears the vagrant flag on a domestic row only", async () => {
    const row = (speciesId: string, reason: ComputedTier["reason"]): ComputedTier =>
      ({
        regionId: ids.region!,
        speciesId,
        name: "x",
        commonName: null,
        tier: null,
        reason,
        explain: null,
      }) as ComputedTier;
    await writeTiers([row(ids.chicken!, "domestic"), row(ids.stray!, "vagrant")]);
    const res = await pool.query<{ species_id: string; is_vagrant: boolean }>(
      `SELECT species_id, is_vagrant FROM region_species WHERE region_id = $1`,
      [ids.region],
    );
    const flag = new Map(res.rows.map((r) => [r.species_id, r.is_vagrant]));
    expect(flag.get(ids.chicken!)).toBe(false);
    expect(flag.get(ids.stray!)).toBe(true);
  });
});
