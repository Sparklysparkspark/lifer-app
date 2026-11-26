// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:<pw>@127.0.0.1:5432/lifer_e2e_marine npx vitest run marine-widening
// The marine widening's writes: new species once, OBIS country rows with their own provenance
// beside other sources, and 6c flagging an OBIS row iNaturalist lacks instead of removing it.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { NewSpecies } from "./add-missing-species.js";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const PLACE = 990201;
// iNaturalist covers molluscs well here (taxon 100) and has one of the OBIS species (taxon 2).
vi.mock("../regions/inatChecklist.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cachedPlaceCounts: () =>
    new Map([
      [2, { count: 40, iconic: "Mollusca", name: "Obisia photographed" }],
      [100, { count: 50_000, iconic: "Mollusca", name: "Filler mollusc" }],
    ]),
  refreshPlaceYearCounts: async () => true,
  cachedPlaceYearCounts: () => ({ counts: new Map(), asked: new Map() }),
  loadInatCurrentTaxonDiskCache: () => ({}),
}));

const url = process.env.TEST_DATABASE_URL;
const id = (n: number) => `99000200-0000-4000-8000-${String(n).padStart(12, "0")}`;
const COUNTRY = id(1);
const [FROM_INAT, ABSENT, PHOTOGRAPHED, NON_NATIVE] = [11, 12, 13, 14].map(id);

afterAll(async () => {
  if (!url) return;
  const { pool } = await import("@lifer/core/db.js");
  await pool.end();
});

describe.skipIf(!url)("marine widening on a scratch database", () => {
  const db = new pg.Pool({ connectionString: url });
  const newSpecies: NewSpecies = {
    scientificName: "Widenia bivalvis",
    commonName: "Widened Clam",
    taxonClass: "marine_mollusks",
    clade: "Bivalvia",
    inatTaxonId: 990299,
    ebirdCode: null,
    family: "Veneridae",
    order: "Venerida",
    gbifKey: -990299,
    source: "inat",
    places: 2,
    inatObservations: 30,
  };
  const cleanup = async () => {
    await db.query(`DELETE FROM regions WHERE id = $1`, [COUNTRY]);
    await db.query(`DELETE FROM species WHERE id = ANY($1) OR gbif_key = $2`, [
      [FROM_INAT, ABSENT, PHOTOGRAPHED, NON_NATIVE],
      newSpecies.gbifKey,
    ]);
  };

  beforeAll(async () => {
    await cleanup();
    await db.query(`INSERT INTO regions (id, name, inat_place_id, external_codes) VALUES ($1, 'Obisia', $2, '{OBI}')`, [
      COUNTRY,
      PLACE,
    ]);
    for (const [i, [sid, name, taxon]] of (
      [
        [FROM_INAT, "Obisia inaturalisti", 1],
        [ABSENT, "Obisia absent", 3],
        [PHOTOGRAPHED, "Obisia photographed", 2],
        [NON_NATIVE, "Obisia invader", 4],
      ] as const
    ).entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, inat_taxon_id) VALUES ($1, $2, $3, 'marine_mollusks', $4)`,
        [sid, 990200 + i, name, taxon],
      );
    await db.query(`INSERT INTO species_nonnative_countries (species_id, country_iso3) VALUES ($1, 'OBI')`, [
      NON_NATIVE,
    ]);
    await db.query(
      `INSERT INTO region_species (region_id, species_id, is_vagrant, evidence_source) VALUES ($1, $2, false, 'inat')`,
      [COUNTRY, FROM_INAT],
    );
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("adds a new species once, marked as iNaturalist-derived", async () => {
    const { insertMissingSpecies } = await import("./add-missing-species.js");
    expect(await insertMissingSpecies([newSpecies], [])).toBe(1);
    expect(await insertMissingSpecies([newSpecies], [])).toBe(0);
    const row = await db.query<{ gbif_key: string; source_attribution: string }>(
      `SELECT s.gbif_key, t.source_attribution FROM species s JOIN species_traits t ON t.species_id = s.id WHERE s.scientific_name = $1`,
      [newSpecies.scientificName],
    );
    expect(row.rows).toEqual([{ gbif_key: "-990299", source_attribution: "iNaturalist taxonomy" }]);
  });

  it("writes OBIS rows as 'obis', leaves other sources alone and replaces its own on a rerun", async () => {
    const { writeCountryRows } = await import("./build-country-marine-obis.js");
    const rows = async () =>
      (
        await db.query<{ species_id: string; evidence_source: string; is_vagrant: boolean }>(
          `SELECT species_id, evidence_source, is_vagrant FROM region_species WHERE region_id = $1 ORDER BY species_id`,
          [COUNTRY],
        )
      ).rows;
    // FROM_INAT is already listed from iNaturalist: it keeps that evidence.
    await writeCountryRows([{ id: COUNTRY, keep: [{ speciesId: FROM_INAT }, { speciesId: ABSENT }] }]);
    expect(await rows()).toEqual([
      { species_id: FROM_INAT, evidence_source: "inat", is_vagrant: false },
      { species_id: ABSENT, evidence_source: "obis", is_vagrant: false },
    ]);
    await writeCountryRows([
      { id: COUNTRY, keep: [{ speciesId: ABSENT }, { speciesId: PHOTOGRAPHED }, { speciesId: NON_NATIVE }] },
    ]);
    const again = await rows();
    await writeCountryRows([
      { id: COUNTRY, keep: [{ speciesId: ABSENT }, { speciesId: PHOTOGRAPHED }, { speciesId: NON_NATIVE }] },
    ]);
    expect(await rows()).toEqual(again);
    expect(again.find((r) => r.species_id === NON_NATIVE)).toEqual({
      species_id: NON_NATIVE,
      evidence_source: "obis",
      is_vagrant: true,
    });
    // A narrower rerun drops this step's rows only.
    await writeCountryRows([{ id: COUNTRY, keep: [{ speciesId: ABSENT }] }]);
    expect((await rows()).map((r) => r.species_id)).toEqual([FROM_INAT, ABSENT]);
    await writeCountryRows([
      { id: COUNTRY, keep: [{ speciesId: ABSENT }, { speciesId: PHOTOGRAPHED }, { speciesId: NON_NATIVE }] },
    ]);
  });

  it("6c flags an OBIS row iNaturalist lacks as vagrant, never removes it", async () => {
    const { loadCatalogIndex, planRegion, applyPlan } = await import("./apply-inat-membership.js");
    const plan = await planRegion({ id: COUNTRY, name: "Obisia", inat_place_id: PLACE }, await loadCatalogIndex(), []);
    await applyPlan(plan!);
    const byId = new Map(
      (
        await db.query<{ species_id: string; evidence_source: string; is_vagrant: boolean }>(
          `SELECT species_id, evidence_source, is_vagrant FROM region_species WHERE region_id = $1`,
          [COUNTRY],
        )
      ).rows.map((r) => [r.species_id, r]),
    );
    expect(byId.get(ABSENT)).toEqual({ species_id: ABSENT, evidence_source: "obis", is_vagrant: true });
    expect(byId.get(PHOTOGRAPHED)).toEqual({ species_id: PHOTOGRAPHED, evidence_source: "obis", is_vagrant: false });
    // Introduced, not a stray: 6c leaves its flag as the catalog set it.
    expect(byId.get(NON_NATIVE)?.evidence_source).toBe("obis");
  });
});
