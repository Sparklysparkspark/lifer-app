// Integration test (real Postgres required, the scratch TEST_DATABASE_URL): the names, ranges,
// flags and classes passes change what they should, keep user data and are safe to run twice.
// Runs inside a transaction that's always rolled back.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import type { EbirdRow } from "./add-missing-species.js";
import {
  additionsPass,
  birdNamesPass,
  classesPass,
  extinctPass,
  flagsPass,
  namesPass,
  rangesPass,
  residentMammalsPass,
  unlistedBirdsPass,
  type Decision,
  type Fixes,
} from "./fix-catalog-audit.js";

let client: PoolClient;
const ids: Record<string, string> = {};
const regions: Record<string, string> = {};

const fixes: Fixes = {
  merges: [],
  renames: [{ from: "Testfixus oldus", to: "Testfixus novus", reason: "test rename" }],
  wrongCommonNames: [{ scientificName: "Testfixus wrongus", commonName: "Round Testray", reason: "test" }],
  replacedNames: [{ scientificName: "Testfixus splitus", replacedBy: "Testfixus successor", reason: "test split" }],
  rangeExclusions: [{ scientificName: "Testfixus wrongus", keepCountries: ["ZZB"], reason: "test range" }],
  flagOverrides: [{ scientificName: "Testfixus batus", country: "ZZA", isVagrant: false, reason: "test resident" }],
  basinAllow: [],
  seaLinks: [],
  additions: [{ scientificName: "Testfixus successor", country: "ZZC", source: "test list", reason: "test add" }],
};

async function addSpecies(name: string, extra: Record<string, unknown> = {}) {
  const fields: Record<string, unknown> = { taxon_class: "actinopterygii", ...extra };
  const cols = ["gbif_key", "scientific_name", ...Object.keys(fields)];
  const vals = [Math.floor(900000000 + Math.random() * 99999999), name, ...Object.values(fields)];
  const res = await client.query<{ id: string }>(
    `INSERT INTO species (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING id`,
    vals,
  );
  ids[name] = res.rows[0].id;
}

async function addRegion(key: string, name: string, code: string, parent: string | null) {
  const res = await client.query<{ id: string }>(
    `INSERT INTO regions (name, external_codes, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [name, [code], parent],
  );
  regions[key] = res.rows[0].id;
}

const list = (region: string, species: string, extra = "false, null") =>
  client.query(
    `INSERT INTO region_species (region_id, species_id, is_vagrant, inat_rg_count) VALUES ($1, $2, ${extra})`,
    [regions[region], ids[species]],
  );

beforeEach(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
  await addRegion("a", "Testland A", "ZZA", null);
  await addRegion("a1", "Testland A North", "ZZ-AN", regions.a);
  await addRegion("b", "Testland B", "ZZB", null);
  await addRegion("c", "Testland C", "ZZC", null);
  await addSpecies("Testfixus oldus");
  await client.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Testfixus novus')`, [
    ids["Testfixus oldus"],
  ]);
  await addSpecies("Testfixus wrongus", { common_name: "Round Testray" });
  await addSpecies("Testfixus splitus");
  await addSpecies("Testfixus successor");
  await addSpecies("Testfixus batus", { taxon_class: "mammalia" });
  for (const r of ["a", "a1", "b"]) await list(r, "Testfixus wrongus");
  await list("a", "Testfixus splitus", "false, 0");
  await list("b", "Testfixus splitus", "false, 4");
  await list("a", "Testfixus successor");
  await list("b", "Testfixus successor");
  await list("a", "Testfixus batus", "true, 0");
  await list("a1", "Testfixus batus", "true, 0");
  // A user's mark on the renamed species must survive.
  const user = await client.query<{ id: string }>(
    `INSERT INTO users (email, password_hash) VALUES ('catfix-test@example.invalid', 'x') RETURNING id`,
  );
  await client.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [
    user.rows[0].id,
    ids["Testfixus oldus"],
  ]);
});

afterEach(async () => {
  await client.query("ROLLBACK");
  client.release();
});

async function runAll(): Promise<Decision[]> {
  const out: Decision[] = [];
  await namesPass(client, fixes, out);
  await rangesPass(client, fixes, out, async () => {});
  await flagsPass(client, fixes, out);
  return out;
}

describe("fix-catalog-audit passes", () => {
  it("renames, clears a wrong name, trims ranges and old split names, and pins resident flags", async () => {
    const out = await runAll();

    const renamed = await client.query(`SELECT scientific_name FROM species WHERE id = $1`, [ids["Testfixus oldus"]]);
    expect(renamed.rows[0].scientific_name).toBe("Testfixus novus");
    const syn = await client.query(`SELECT synonym_name FROM species_synonyms WHERE species_id = $1`, [
      ids["Testfixus oldus"],
    ]);
    expect(syn.rows.map((r) => r.synonym_name)).toEqual(["Testfixus oldus"]);
    const seen = await client.query(`SELECT count(*)::int AS n FROM user_species WHERE species_id = $1`, [
      ids["Testfixus oldus"],
    ]);
    expect(seen.rows[0].n).toBe(1);

    const wrong = await client.query(`SELECT common_name FROM species WHERE id = $1`, [ids["Testfixus wrongus"]]);
    expect(wrong.rows[0].common_name).toBeNull();
    const listed = async (species: string) =>
      (
        await client.query<{ name: string }>(
          `SELECT r.name FROM region_species rs JOIN regions r ON r.id = rs.region_id WHERE rs.species_id = $1 ORDER BY 1`,
          [ids[species]],
        )
      ).rows.map((r) => r.name);
    // Only country ZZB keeps it; the province follows its country.
    expect(await listed("Testfixus wrongus")).toEqual(["Testland B"]);
    // Gone where the successor is listed and it has no records of its own; kept where it has some.
    expect(await listed("Testfixus splitus")).toEqual(["Testland B"]);

    const bats = await client.query(
      `SELECT rs.is_vagrant, o.is_vagrant AS pinned, o.is_invasive FROM region_species rs
       JOIN region_species_manual_overrides o ON o.region_id = rs.region_id AND o.species_id = rs.species_id
       WHERE rs.species_id = $1`,
      [ids["Testfixus batus"]],
    );
    expect(bats.rows).toEqual([
      { is_vagrant: false, pinned: false, is_invasive: null },
      { is_vagrant: false, pinned: false, is_invasive: null },
    ]);
    expect(out.filter((d) => d.pass === "ranges")).toHaveLength(3);

    // A second run finds nothing left to do.
    expect(
      (await runAll()).filter((d) => d.speciesId in Object.fromEntries(Object.values(ids).map((i) => [i, 1]))),
    ).toEqual([]);
  });

  it("moves a species filed under the wrong class to the class of the rest of its order", async () => {
    await client.query(
      `UPDATE species SET taxon_order = 'Testfixiformes', taxon_class = 'mammalia' WHERE id = ANY($1)`,
      [[ids["Testfixus batus"], ids["Testfixus splitus"], ids["Testfixus successor"]]],
    );
    await client.query(`UPDATE species SET taxon_class = 'actinopterygii' WHERE id = $1`, [ids["Testfixus splitus"]]);
    const out: Decision[] = [];
    await classesPass(client, out);
    expect(out.filter((d) => d.speciesId === ids["Testfixus splitus"]).map((d) => d.detail)).toEqual([
      "actinopterygii to mammalia",
    ]);
    const again: Decision[] = [];
    await classesPass(client, again);
    expect(again.filter((d) => d.name.startsWith("Testfixus"))).toEqual([]);
  });
});

describe("fix-catalog-audit list passes", () => {
  it("adds a listed species to its country once, with list evidence", async () => {
    const out: Decision[] = [];
    await additionsPass(client, fixes, out);
    await additionsPass(client, fixes, out);
    expect(out.map((d) => [d.name, d.where])).toEqual([["Testfixus successor", "Testland C"]]);
    const row = await client.query(`SELECT evidence_source, is_vagrant FROM region_species WHERE region_id = $1`, [
      regions.c,
    ]);
    expect(row.rows).toEqual([{ evidence_source: "list", is_vagrant: false }]);
  });

  it("drops a thin bird listing eBird never had there, and keeps listed or well-recorded ones", async () => {
    // Real countries and provinces sit under World > continent; eBird lists are per province.
    const world = await client.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Testworld') RETURNING id`);
    const cont = await client.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id) VALUES ('Testcontinent', $1) RETURNING id`,
      [world.rows[0].id],
    );
    await client.query(`UPDATE regions SET parent_id = $1 WHERE id = $2`, [cont.rows[0].id, regions.a]);
    await client.query(`UPDATE regions SET ebird_region_code = 'ZZ-AN' WHERE id = $1`, [regions.a1]);
    for (const [name, code] of [
      ["Testavis escapus", "tstesc"],
      ["Testavis listedus", "tstlis"],
      ["Testavis commonus", "tstcom"],
    ]) {
      await addSpecies(name, { taxon_class: "aves", ebird_code: code });
      await list("a1", name, "false, 1");
    }
    await client.query(`UPDATE region_species SET local_frequency = 40 WHERE species_id = $1`, [
      ids["Testavis commonus"],
    ]);
    const ebird = new Map([
      ["ZZ-AN", ["tstlis", "tstcom"]],
      ["YY-XX", ["tstesc"]],
    ]);
    const out: Decision[] = [];
    await unlistedBirdsPass(client, out, ebird, new Set(), 1);
    expect(out.filter((d) => d.name.startsWith("Testavis")).map((d) => [d.name, d.where])).toEqual([
      ["Testavis escapus", "Testland A North (ZZ-AN)"],
    ]);
  });

  it("clears the vagrant flag on a native bat resident next door, not on one far from any resident", async ({
    skip,
  }) => {
    // This pass needs PostGIS, which only the development database has.
    if (!(await client.query(`SELECT 1 FROM pg_extension WHERE extname = 'postgis'`)).rowCount) skip();
    await client.query(`UPDATE species SET taxon_order = 'Chiroptera' WHERE id = $1`, [ids["Testfixus batus"]]);
    const square = (lon: number) =>
      JSON.stringify({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: [
            [
              [lon, 0],
              [lon + 1, 0],
              [lon + 1, 1],
              [lon, 1],
              [lon, 0],
            ],
          ],
        },
      });
    await addRegion("a2", "Testland A South", "ZZ-AS", regions.a);
    await addRegion("a3", "Testland A Far", "ZZ-AF", regions.a);
    await client.query(`UPDATE regions SET boundary_geojson = $2 WHERE id = $1`, [regions.a1, square(0)]);
    await client.query(`UPDATE regions SET boundary_geojson = $2 WHERE id = $1`, [regions.a2, square(1)]);
    await client.query(`UPDATE regions SET boundary_geojson = $2 WHERE id = $1`, [regions.a3, square(40)]);
    await addRegion("a4", "Testland A Chain", "ZZ-AC", regions.a);
    await client.query(`UPDATE regions SET boundary_geojson = $2 WHERE id = $1`, [regions.a4, square(-3)]);
    await list("a2", "Testfixus batus", "false, 3");
    await list("a3", "Testfixus batus", "true, 0");
    // Next to North only: cleared once North is, and a second run finds nothing.
    await list("a4", "Testfixus batus", "true, 0");
    await client.query(`UPDATE regions SET boundary_geojson = $2 WHERE id = $1`, [regions.a2, square(2.5)]);
    const out: Decision[] = [];
    await residentMammalsPass(client, out);
    expect(out.filter((d) => d.speciesId === ids["Testfixus batus"]).map((d) => d.where)).toEqual([
      "Testland A North",
      "Testland A Chain",
    ]);
    const again: Decision[] = [];
    await residentMammalsPass(client, again);
    expect(again.filter((d) => d.speciesId === ids["Testfixus batus"])).toEqual([]);
  });
});

describe("bird-names and extinct passes", () => {
  it("names a bird from its eBird code and hides only unlisted dead taxa, once", async () => {
    await addSpecies("Testavis vivus", { taxon_class: "aves", ebird_code: "tstviv1" });
    await addSpecies("Testavis fossilis", { taxon_class: "aves" });
    await addSpecies("Testavis listedus", { taxon_class: "aves" });
    await addSpecies("Testavis extinctus", { taxon_class: "aves", common_name: "Lost Testbird" });
    const names = ["Testavis vivus", "Testavis fossilis", "Testavis listedus", "Testavis extinctus"];
    for (const n of names)
      await client.query(`INSERT INTO species_traits (species_id, source_attribution) VALUES ($1, 'test')`, [ids[n]]);
    await list("a", "Testavis listedus");
    const row = (sci: string, common: string, code: string, extinct: boolean): EbirdRow => ({
      sci,
      common,
      code,
      category: "species",
      family: "",
      order: "",
      extinct,
      reportAs: "",
    });
    const ebird = [
      row("Testavis vivus", "Gray-headed Testbird", "tstviv1", false),
      row("Testavis extinctus", "Lost Testbird", "tstext1", true),
    ];
    const ev = {
      ebirdByName: new Map(ebird.map((r) => [r.sci, r])),
      ebirdByCode: new Map(ebird.map((r) => [r.code, r])),
      profile: () => null,
      recent: () => null,
    };

    const out: Decision[] = [];
    await birdNamesPass(client, out, ebird);
    await extinctPass(client, out, ev);
    const named = await client.query(`SELECT common_name FROM species WHERE id = $1`, [ids["Testavis vivus"]]);
    expect(named.rows[0].common_name).toBe("Gray-Headed Testbird");
    const flagged = await client.query<{ scientific_name: string }>(
      `SELECT s.scientific_name FROM species s JOIN species_traits t ON t.species_id = s.id
       WHERE t.fully_extinct AND s.id = ANY($1) ORDER BY 1`,
      [names.map((n) => ids[n])],
    );
    expect(flagged.rows.map((r) => r.scientific_name)).toEqual(["Testavis extinctus", "Testavis fossilis"]);

    const again: Decision[] = [];
    await birdNamesPass(client, again, ebird);
    await extinctPass(client, again, ev);
    expect(again.filter((d) => names.includes(d.name))).toEqual([]);
  });
});
