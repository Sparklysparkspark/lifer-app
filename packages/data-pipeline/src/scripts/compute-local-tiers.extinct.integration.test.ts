// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer npx vitest run compute-local-tiers.extinct
// Extinct species come off the checklists, unless a province still records them alive year after
// year: then the extinct flag is wrong (the extinct half of a split) and is cleared instead.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;

afterAll(async () => {
  if (!url) return;
  const { pool } = await import("@lifer/core/db.js");
  await pool.end();
});

const id = (n: number) => `14015000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [WORLD, CONTINENT, COUNTRY, SOUTH, ISLAND, MARSH] = [1, 2, 3, 4, 5, 6].map(id);
const [BETTONG, WHITE_EYE, CURLEW, AUK, EDGE, LORIKEET] = [10, 11, 12, 13, 14, 15].map(id);
const COUNTRY_NAME = "Extinctia";

// [species, name, Red List status, province, live records in the last 15 years, distinct years among them]
const LISTINGS: Array<[string, string, string, string, number, number]> = [
  // The province partitions' real figures: South Australia's Woylies and Saipan's white-eyes.
  [BETTONG, "Bettongia penicillata", "EX", SOUTH, 1171, 11],
  [WHITE_EYE, "Zosterops conspicillatus", "EX", ISLAND, 1192, 14],
  // A truly extinct bird with a few claimed sightings, and one known only from old specimens.
  [CURLEW, "Numenius tenuirostris", "EX", MARSH, 3, 2],
  [AUK, "Pinguinus impennis", "EX", SOUTH, 0, 0],
  // Plenty of records, but crammed into a few years: not a population that lives on.
  [EDGE, "Extinctia burstus", "EX", MARSH, 400, 3],
  // Flagged extinct though the Red List rates it Least Concern: a few records are enough.
  [LORIKEET, "Charmosyna margarethae", "LC", ISLAND, 36, 7],
];

describe.skipIf(!url)("compute-local-tiers: extinct species", () => {
  const db = new pg.Pool({ connectionString: url });
  const speciesIds = LISTINGS.map((l) => l[0]);
  const cleanup = async () => {
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[MARSH, ISLAND, SOUTH, COUNTRY, CONTINENT, WORLD]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [speciesIds]);
  };

  beforeAll(async () => {
    await cleanup();
    await db.query(
      `INSERT INTO regions (id, name, parent_id, has_children) VALUES
         ($1, 'Extinct World', NULL, true), ($2, 'Extinct Continent', $1, true), ($3, $7, $2, true),
         ($4, 'Extinct South', $3, false), ($5, 'Extinct Island', $3, false), ($6, 'Extinct Marsh', $3, false)`,
      [WORLD, CONTINENT, COUNTRY, SOUTH, ISLAND, MARSH, COUNTRY_NAME],
    );
    for (const [i, [species, name, iucn, province, live, years]] of LISTINGS.entries()) {
      await db.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'aves')`, [
        species,
        140150 + i,
        name,
      ]);
      await db.query(
        `INSERT INTO species_traits (species_id, fully_extinct, iucn_status, source_attribution) VALUES ($1, true, $2, 'test')`,
        [species, iucn],
      );
      for (const region of [province, COUNTRY]) {
        await db.query(
          `INSERT INTO region_species (region_id, species_id, local_frequency, live_recent_records, recent_distinct_years)
           VALUES ($1, $2, $3::int, $3::int, $4)`,
          [region, species, live, years],
        );
      }
    }
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  const listed = async (species: string) =>
    (
      await db.query<{ region_id: string }>(`SELECT region_id FROM region_species WHERE species_id = $1`, [species])
    ).rows
      .map((r) => r.region_id)
      .sort();
  const extinct = async (species: string) =>
    (
      await db.query<{ fully_extinct: boolean }>(`SELECT fully_extinct FROM species_traits WHERE species_id = $1`, [
        species,
      ])
    ).rows[0].fully_extinct;

  it("previews without writing anything", async () => {
    const { loadCountries, reviveRecordedAlive, removeExtinct } = await import("./compute-local-tiers.js");
    const [country] = await loadCountries([COUNTRY_NAME]);
    expect((await reviveRecordedAlive(country, false)).map((r) => r.species).sort()).toEqual([
      "Bettongia penicillata",
      "Charmosyna margarethae",
      "Zosterops conspicillatus",
    ]);
    expect(new Set((await removeExtinct(country, false)).map((r) => r.species))).toEqual(
      new Set(["Numenius tenuirostris", "Pinguinus impennis", "Extinctia burstus"]),
    );
    expect(await extinct(BETTONG)).toBe(true);
    expect(await listed(CURLEW)).toEqual([COUNTRY, MARSH].sort());
  });

  it("clears the flag of species a province records alive and keeps their listings", async () => {
    const { loadCountries, reviveRecordedAlive, removeExtinct } = await import("./compute-local-tiers.js");
    const [country] = await loadCountries([COUNTRY_NAME]);
    await reviveRecordedAlive(country, true);
    await removeExtinct(country, true);

    // Brush-tailed Bettong (Woylie) and Bridled White-eye (Saipan White-eye) live on.
    expect(await extinct(BETTONG)).toBe(false);
    expect(await extinct(WHITE_EYE)).toBe(false);
    expect(await listed(BETTONG)).toEqual([COUNTRY, SOUTH].sort());
    expect(await listed(WHITE_EYE)).toEqual([COUNTRY, ISLAND].sort());
    expect(await extinct(LORIKEET)).toBe(false);
    expect(await listed(LORIKEET)).toEqual([COUNTRY, ISLAND].sort());

    // Genuinely extinct species still come off every list and stay flagged.
    for (const gone of [CURLEW, AUK, EDGE]) {
      expect(await extinct(gone)).toBe(true);
      expect(await listed(gone)).toEqual([]);
    }
  });
});
