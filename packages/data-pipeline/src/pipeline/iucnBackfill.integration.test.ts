// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database. The Red List is a
// small synthetic one and GBIF is faked: nothing goes online.
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { IucnRedList } from "./iucnRedList.js";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const id = (n: number) => `99999999-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const S = {
  exact: id(1),
  synonym: id(2),
  parent: id(3),
  split: id(4),
  nudibranch: id(5),
  birdMiss: id(6),
  birdGbifNe: id(7),
  wikidataKept: id(8),
  noTraits: id(9),
  otherTaxa: id(10),
};
const ALL = Object.values(S);
const REGION = "Zziucn Land";

const redList: IucnRedList = {
  citation: "test",
  accepted: [
    { taxonId: 101, name: "Zziucn exacta", className: "AVES", code: "VU" },
    { taxonId: 102, name: "Zziucn renamed", className: "AVES", code: "EN" },
    { taxonId: 103, name: "Zziucn kirkii", className: "MAMMALIA", code: "LC" },
    { taxonId: 104, name: "Zziucn traitless", className: "AVES", code: "NT" },
  ],
  synonyms: [
    { name: "Zziucnold renamed", acceptedTaxonId: 102, infraEpithet: null },
    { name: "Zziucn damarensis", acceptedTaxonId: 103, infraEpithet: null },
  ],
};

describe.skipIf(!url)("backfillIucnStatus", async () => {
  const db = new pg.Pool({ connectionString: url });
  const { backfillIucnStatus } = await import("./iucnBackfill.js");
  const { pool } = await import("@lifer/core/db.js");

  async function cleanUp() {
    await db.query(`DELETE FROM regions WHERE name = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [ALL]);
  }

  afterAll(async () => {
    await cleanUp();
    await db.end();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanUp();
    const rows: Array<[string, string, string, boolean]> = [
      [S.exact, "Zziucn exacta", "aves", false],
      [S.synonym, "Zziucnold renamed", "aves", false],
      [S.parent, "Zziucn kirkii", "mammalia", false],
      [S.split, "Zziucn damarensis", "mammalia", false],
      [S.nudibranch, "Zziucn nudibranchus", "nudibranchs", false],
      [S.birdMiss, "Zziucn missing", "aves", false],
      [S.birdGbifNe, "Zziucn novus", "aves", false],
      [S.wikidataKept, "Zziucn wikidatus", "nudibranchs", false],
      [S.noTraits, "Zziucn traitless", "aves", false],
      [S.otherTaxa, "Zziucn exacta-other", "insecta", true],
    ];
    for (const [i, [speciesId, name, cls, other]] of rows.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, is_other_taxa) VALUES ($1, $2, $3, $4, $5)`,
        [speciesId, 9_990_000 + i, name, cls, other],
      );
      if (speciesId !== S.noTraits) {
        await db.query(`INSERT INTO species_traits (species_id, source_attribution) VALUES ($1, 'test')`, [speciesId]);
      }
    }
    // A wrong Wikidata copy the Red List corrects, one it can't check, and an iNaturalist one.
    await db.query(`UPDATE species_traits SET iucn_status = 'LC', iucn_source = 'wikidata' WHERE species_id = $1`, [
      S.split,
    ]);
    await db.query(`UPDATE species_traits SET iucn_status = 'DD', iucn_source = 'wikidata' WHERE species_id = $1`, [
      S.wikidataKept,
    ]);
    await db.query(`UPDATE species_traits SET iucn_status = 'CR', iucn_source = 'inaturalist' WHERE species_id = $1`, [
      S.otherTaxa,
    ]);
    const region = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [REGION]))
      .rows[0].id;
    for (const speciesId of ALL)
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [region, speciesId]);
  });

  async function traits() {
    const res = await db.query<{
      species_id: string;
      iucn_status: string | null;
      iucn_source: string | null;
      iucn_note: string | null;
      iucn_taxon_id: string | null;
      checked: boolean;
    }>(
      `SELECT species_id, iucn_status, iucn_source, iucn_note, iucn_taxon_id, iucn_checked_at IS NOT NULL AS checked
       FROM species_traits WHERE species_id = ANY($1)`,
      [ALL],
    );
    return new Map(res.rows.map((r) => [r.species_id, r]));
  }

  const lookupGbif = vi.fn(async (gbifKey: number) => ({ taxonId: null, notEvaluated: gbifKey === 9_990_006 }));

  it("reports without writing unless asked to apply", async () => {
    const result = await backfillIucnStatus(pool, redList, { apply: false, onlySpeciesIds: ALL, lookupGbif });
    expect(result.changed).toBeGreaterThan(0);
    expect([...(await traits()).values()].every((t) => !t.checked)).toBe(true);
  });

  it("writes codes, splits as Not Evaluated, and stamps every catalog species", async () => {
    lookupGbif.mockClear();
    const result = await backfillIucnStatus(pool, redList, { apply: true, onlySpeciesIds: ALL, lookupGbif });
    const t = await traits();
    expect(t.get(S.exact)).toMatchObject({
      iucn_status: "VU",
      iucn_source: "iucn_red_list",
      iucn_taxon_id: "101",
      checked: true,
    });
    expect(t.get(S.synonym)).toMatchObject({ iucn_status: "EN", iucn_taxon_id: "102" });
    expect(t.get(S.parent)).toMatchObject({ iucn_status: "LC" });
    // The split doesn't keep (or inherit) the parent's Least Concern.
    expect(t.get(S.split)).toMatchObject({ iucn_status: "NE", iucn_taxon_id: "103" });
    expect(t.get(S.split)!.iucn_note).toMatch(/includes it in Zziucn kirkii/);
    expect(t.get(S.nudibranch)).toMatchObject({
      iucn_status: "NE",
      iucn_source: "iucn_red_list",
      iucn_note: null,
      checked: true,
    });
    // A bird miss stays undecided; one GBIF also has no assessment for is Not Evaluated.
    expect(t.get(S.birdMiss)).toMatchObject({ iucn_status: null, checked: true });
    expect(t.get(S.birdMiss)!.iucn_note).toMatch(/No IUCN assessment found/);
    expect(t.get(S.birdGbifNe)).toMatchObject({ iucn_status: "NE", checked: true });
    expect(t.get(S.wikidataKept)).toMatchObject({ iucn_status: "DD", iucn_source: "wikidata" });
    // A catalog species without a traits row gets one.
    expect(t.get(S.noTraits)).toMatchObject({ iucn_status: "NT", checked: true });
    // Other Taxa keep their iNaturalist status, unstamped.
    expect(t.get(S.otherTaxa)).toMatchObject({ iucn_status: "CR", iucn_source: "inaturalist", checked: false });
    // GBIF is only asked about listed misses in comprehensively assessed groups.
    expect(lookupGbif.mock.calls.map(([k]) => k).sort()).toEqual([9_990_005, 9_990_006]);
    expect(result.byGroup.aves.listedStillMissing).toBe(1);

    // A second run changes nothing.
    const again = await backfillIucnStatus(pool, redList, { apply: true, onlySpeciesIds: ALL, lookupGbif });
    expect(again.changed).toBe(0);
  });

  it("is refused a status the CHECK constraint doesn't know", async () => {
    await expect(
      db.query(`UPDATE species_traits SET iucn_status = 'least concern' WHERE species_id = $1`, [S.exact]),
    ).rejects.toThrow(/species_traits_iucn_status_code/);
  });
});
