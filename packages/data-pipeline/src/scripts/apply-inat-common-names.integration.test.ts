// Integration test (real Postgres required, the scratch TEST_DATABASE_URL): a rename writes the new
// name and the old one as an alias, search finds both, and the stale text embedding goes.
import { afterAll, describe, expect, it } from "vitest";
import { pool } from "../db.js";
import { planNames, writeNames, type NameRow } from "./apply-inat-common-names.js";

const SCI = "Testnamus baudinii";

afterAll(async () => {
  await pool.query(`DELETE FROM species WHERE scientific_name LIKE 'Testnamus %'`);
  await pool.end();
});

describe("writeNames", () => {
  it("renames, keeps the old name searchable and drops the text embedding", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, common_name, common_name_aliases, taxon_class, inat_taxon_id)
       VALUES (-987654321, $1, 'Mexican Testlisca', ARRAY['Baudin''s Testfrog'], 'amphibia', 987654321) RETURNING id`,
      [SCI],
    );
    const id = rows[0].id;
    await pool.query(
      `INSERT INTO species_text_embeddings (species_id, embedding, model_version) VALUES ($1, ARRAY[0.1]::real[], 'test')`,
      [id],
    );
    const current = await pool.query<NameRow>(
      `SELECT id, scientific_name, common_name, common_name_aliases, taxon_class, inat_taxon_id FROM species WHERE id = $1`,
      [id],
    );
    const plan = planNames(current.rows, new Map([[987654321, { name: "mexican testfrog", active: true }]]));
    await writeNames(plan);
    const reread = await pool.query<NameRow>(
      `SELECT id, scientific_name, common_name, common_name_aliases, taxon_class, inat_taxon_id FROM species WHERE id = $1`,
      [id],
    );
    const rerun = planNames(reread.rows, new Map([[987654321, { name: "mexican testfrog", active: true }]]));
    expect(rerun[0].outcome).toBe("kept");

    const after = await pool.query(`SELECT common_name, common_name_aliases FROM species WHERE id = $1`, [id]);
    expect(after.rows[0]).toEqual({
      common_name: "Mexican Testfrog",
      common_name_aliases: ["Baudin's Testfrog", "Mexican Testlisca"],
    });
    const search = await pool.query<{ name: string; kind: string }>(
      `SELECT name, kind FROM species_search_names WHERE species_id = $1 AND kind <> 'scientific' ORDER BY name`,
      [id],
    );
    expect(search.rows).toEqual([
      { name: "Baudin's Testfrog", kind: "alias" },
      { name: "Mexican Testfrog", kind: "common" },
      { name: "Mexican Testlisca", kind: "alias" },
    ]);
    const emb = await pool.query(`SELECT 1 FROM species_text_embeddings WHERE species_id = $1`, [id]);
    expect(emb.rowCount).toBe(0);
  });
});
