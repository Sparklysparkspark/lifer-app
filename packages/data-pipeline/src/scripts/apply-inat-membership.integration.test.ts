// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:54329/lifer_test npx vitest run apply-inat-membership
// One province's list goes by its iNaturalist place: membership from research-grade observations,
// the vagrant flag from their spread over years, GBIF's flag only where iNaturalist is unsure.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const PLACE = 990001;
const WINDOW = [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025];
// taxon id -> years with observations. Taxa 100+ are fillers that make birds well observed here.
const TAXA: Record<number, { name: string; count: number; years: number[] }> = {
  1: { name: "Inatia chased", count: 47, years: [2018] },
  2: { name: "Inatia scarce", count: 300, years: [2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025] },
  6: { name: "Inatia common", count: 5000, years: WINDOW },
  7: { name: "Inatia ranged", count: 10, years: [2024] },
  ...Object.fromEntries([100, 101, 102, 103].map((t) => [t, { name: `Filler ${t}`, count: 10_000, years: WINDOW }])),
};

vi.mock("../regions/inatChecklist.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cachedPlaceCounts: () =>
    new Map(Object.entries(TAXA).map(([id, t]) => [Number(id), { count: t.count, iconic: "Aves", name: t.name }])),
  refreshPlaceYearCounts: async () => true,
  cachedPlaceYearCounts: () => ({
    counts: new Map(
      Object.entries(TAXA).map(([id, t]) => [Number(id), new Map(t.years.map((y) => [y, 1] as [number, number]))]),
    ),
    asked: new Map(WINDOW.map((y) => [y, new Set(Object.keys(TAXA).map(Number))])),
  }),
  loadInatCurrentTaxonDiskCache: () => ({}),
}));

const url = process.env.TEST_DATABASE_URL;

afterAll(async () => {
  if (!url) return;
  const { pool } = await import("@lifer/core/db.js");
  await pool.end();
});

const id = (n: number) => `99000100-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PROVINCE = id(1);
const GROUP = id(2);
// A chased stray, a scarce regular, one iNaturalist lacks, one with no iNaturalist id, one kept by
// a hand-checked override, one only iNaturalist has, one a GBIF range checklist called native, and
// a fish iNaturalist lacks where it has almost no fish observations.
const [CHASED, SCARCE, ABSENT, NO_ID, OVERRIDDEN, COMMON, RANGED, FISH] = [11, 12, 13, 14, 15, 16, 17, 18].map(id);

describe.skipIf(!url)("apply-inat-membership", () => {
  const db = new pg.Pool({ connectionString: url });
  const cleanup = async () => {
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, GROUP]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [
      [CHASED, SCARCE, ABSENT, NO_ID, OVERRIDDEN, COMMON, RANGED, FISH],
    ]);
  };

  beforeAll(async () => {
    await cleanup();
    await db.query(`INSERT INTO regions (id, name) VALUES ($1, 'Inatia Group')`, [GROUP]);
    await db.query(`INSERT INTO regions (id, name, inat_place_id, parent_id) VALUES ($1, 'Inatia Province', $2, $3)`, [
      PROVINCE,
      PLACE,
      GROUP,
    ]);
    const species: Array<[string, string, number | null, string]> = [
      [CHASED, "Inatia chased", 1, "aves"],
      [SCARCE, "Inatia scarce", 2, "aves"],
      [ABSENT, "Inatia absent", 3, "aves"],
      [NO_ID, "Inatia unknown", null, "aves"],
      [OVERRIDDEN, "Inatia overridden", 5, "aves"],
      [COMMON, "Inatia common", 6, "aves"],
      [RANGED, "Inatia ranged", 7, "aves"],
      [FISH, "Inatia piscis", 8, "actinopterygii"],
    ];
    for (const [i, [sid, name, taxon, cls]] of species.entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, inat_taxon_id) VALUES ($1, $2, $3, $5, $4)`,
        [sid, 990100 + i, name, taxon, cls],
      );
    for (const [sid, vagrant] of [
      [CHASED, false],
      [SCARCE, true],
      [ABSENT, false],
      [NO_ID, false],
      [OVERRIDDEN, false],
      [RANGED, false],
      [FISH, false],
    ] as const)
      await db.query(
        `INSERT INTO region_species (region_id, species_id, is_vagrant, local_frequency) VALUES ($1, $2, $3, 400)`,
        [PROVINCE, sid, vagrant],
      );
    await db.query(
      `INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, source) VALUES
         ($1, $2, false, 'checked by hand'), ($1, $3, false, 'gbif-distributions:native-realm')`,
      [PROVINCE, OVERRIDDEN, RANGED],
    );
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("lists what iNaturalist has, flags strays by their years and keeps GBIF's statistics", async () => {
    const { loadCatalogIndex, planRegion, applyPlan } = await import("./apply-inat-membership.js");
    const plan = await planRegion(
      { id: PROVINCE, name: "Inatia Province", inat_place_id: PLACE },
      await loadCatalogIndex(),
      WINDOW,
    );
    expect(plan).not.toBeNull();
    await applyPlan(plan!);

    const rows = await db.query<{ species_id: string; is_vagrant: boolean; local_frequency: string | null }>(
      `SELECT species_id, is_vagrant, local_frequency FROM region_species WHERE region_id = $1`,
      [PROVINCE],
    );
    const byId = new Map(rows.rows.map((r) => [r.species_id, r]));
    // Missing from iNaturalist where it covers birds: kept, flagged as a stray.
    expect(byId.get(ABSENT)?.is_vagrant).toBe(true);
    expect(byId.get(NO_ID)?.is_vagrant).toBe(false);
    expect(byId.get(OVERRIDDEN)?.is_vagrant).toBe(false);
    expect(byId.get(CHASED)?.is_vagrant).toBe(true);
    expect(byId.get(CHASED)?.local_frequency).toBe("400");
    expect(byId.get(SCARCE)?.is_vagrant).toBe(false);
    expect(byId.get(COMMON)?.is_vagrant).toBe(false);
    expect(byId.get(RANGED)?.is_vagrant).toBe(true);
    expect(plan!.keptUnknown).toBe(1);
    expect(plan!.keptOverride).toBe(1);
    expect(byId.has(FISH)).toBe(true);
    expect(plan!.keptThin).toBe(1);

    // A rerun finds nothing left to change.
    const again = await planRegion(
      { id: PROVINCE, name: "Inatia Province", inat_place_id: PLACE },
      await loadCatalogIndex(),
      WINDOW,
    );
    expect(again!.changes).toEqual([]);
  });

  it("confirms the listings iNaturalist has, in the province and its placeless group", async () => {
    const { inatConfirmedListings } = await import("./apply-inat-membership.js");
    const confirmed = await inatConfirmedListings(undefined, undefined, [GROUP]);
    expect(confirmed.has(`${PROVINCE}|${CHASED}`)).toBe(true);
    expect(confirmed.has(`${GROUP}|${CHASED}`)).toBe(true);
    expect(confirmed.has(`${PROVINCE}|${ABSENT}`)).toBe(false);
  });
});
