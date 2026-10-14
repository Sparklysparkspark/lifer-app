// Integration test (real Postgres required, the scratch TEST_DATABASE_URL): a hand-checked
// correction overrides what the catalog and IUCN steps wrote, keeps the old name searchable, and
// is safe to apply again. Runs inside a transaction that's always rolled back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { applySpeciesCorrections, loadSpeciesCorrections } from "./speciesCorrections.js";

let client: PoolClient;
let speciesId: string;

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  const res = await client.query(
    `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class)
     VALUES (999999998, 'Chelonoidis niger', 'Floreana Giant Tortoise', 'testudines')
     RETURNING id`,
  );
  speciesId = res.rows[0].id;
  await client.query(
    `INSERT INTO species_traits (species_id, iucn_status, iucn_source, fully_extinct, source_attribution)
     VALUES ($1, 'EX', 'iucn_red_list', true, 'test')`,
    [speciesId],
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

describe("applySpeciesCorrections", () => {
  it("gives the shipped tortoise correction its expected name, no Red List status and alive", async () => {
    const tortoise = loadSpeciesCorrections().filter((c) => c.scientificName === "Chelonoidis niger");
    expect(await applySpeciesCorrections(client, tortoise)).toEqual([]);

    const s = await client.query(`SELECT common_name, common_name_aliases FROM species WHERE id = $1`, [speciesId]);
    expect(s.rows[0]).toEqual({
      common_name: "Galápagos Giant Tortoise",
      common_name_aliases: ["Floreana Giant Tortoise"],
    });
    const t = await client.query(
      `SELECT iucn_status, iucn_source, iucn_note, fully_extinct FROM species_traits WHERE species_id = $1`,
      [speciesId],
    );
    expect(t.rows[0]).toMatchObject({ iucn_status: null, iucn_source: null, fully_extinct: false });
    expect(t.rows[0].iucn_note).toMatch(/each island/);
  });

  it("is safe to apply again and leaves fields a correction doesn't mention alone", async () => {
    const corrections = [
      { scientificName: "Chelonoidis niger", reason: "test", commonName: "Galápagos Giant Tortoise" },
    ];
    await applySpeciesCorrections(client, corrections);
    await applySpeciesCorrections(client, corrections);

    const s = await client.query(`SELECT common_name_aliases FROM species WHERE id = $1`, [speciesId]);
    expect(s.rows[0].common_name_aliases).toEqual(["Floreana Giant Tortoise"]);
    const t = await client.query(`SELECT iucn_status, fully_extinct FROM species_traits WHERE species_id = $1`, [
      speciesId,
    ]);
    expect(t.rows[0]).toEqual({ iucn_status: "EX", fully_extinct: true });
  });

  it("reports a correction whose species isn't in the catalog", async () => {
    expect(await applySpeciesCorrections(client, [{ scientificName: "Nonexistus nullus", reason: "test" }])).toEqual([
      "Nonexistus nullus",
    ]);
  });
});
