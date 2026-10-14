// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer npx vitest run compute-local-tiers
// A regional group is rated from its provinces the way its country is and is itself a candidate
// for the country's tier, and a province with too little data takes its group's tier.
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
const id = (n: number) => `14014000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [WORLD, CONTINENT, COUNTRY, GROUP, BUSY, QUIET, OTHER] = [1, 2, 3, 4, 5, 6, 7].map(id);
const BIRDS = [10, 11, 12, 13, 14, 15].map(id);
const COUNTRY_NAME = "Tieria";

describe.skipIf(!url)("compute-local-tiers with regional groups", () => {
  const db = new pg.Pool({ connectionString: url });
  const cleanup = async () => {
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[OTHER, QUIET, BUSY, GROUP, COUNTRY, CONTINENT, WORLD]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [BIRDS]);
  };

  beforeAll(async () => {
    await cleanup();
    await db.query(
      `INSERT INTO regions (id, name, parent_id, has_children) VALUES
         ($1, 'Tier World', NULL, true), ($2, 'Tier Continent', $1, true), ($3, $8, $2, true),
         ($4, 'Tier Group', $3, true), ($5, 'Tier Busy', $4, false), ($6, 'Tier Quiet', $4, false),
         ($7, 'Tier Other', $3, false)`,
      [WORLD, CONTINENT, COUNTRY, GROUP, BUSY, QUIET, OTHER, COUNTRY_NAME],
    );
    for (const [i, bird] of BIRDS.entries()) {
      await db.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'aves')`, [
        bird,
        140140 + i,
        `Tieria avis${i}`,
      ]);
    }
    // Busy is well birded: five everyday birds and a scarce one. Quiet has too few bird records
    // to rate anything; Other is busy too but lacks the scarce bird.
    const rows: Array<[string, string, number]> = [];
    for (const place of [BUSY, OTHER])
      for (const bird of BIRDS.slice(0, 5)) rows.push([place, bird, place === BUSY ? 5000 : 4000]);
    rows.push([BUSY, BIRDS[5], 20], [QUIET, BIRDS[5], 1], [QUIET, BIRDS[0], 2]);
    for (const [place, bird, records] of rows) {
      await db.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, live_recent_records, recent_distinct_years)
         VALUES ($1, $2, $3::int, $3::int, 10)`,
        [place, bird, records],
      );
    }
    // The group and the country list what their provinces list (build-country-checklists.ts).
    for (const place of [GROUP, COUNTRY]) {
      await db.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency, live_recent_records)
         SELECT $1, species_id, sum(local_frequency), sum(live_recent_records) FROM region_species
         WHERE region_id = ANY($2) GROUP BY species_id`,
        [place, place === GROUP ? [BUSY, QUIET] : [BUSY, QUIET, OTHER]],
      );
    }
    await db.query(
      `INSERT INTO region_group_effort (region_id, species_group, live_recent_records, all_records) VALUES
         ($1, 'birds', 50000, 50000), ($2, 'birds', 3, 3), ($3, 'birds', 40000, 40000), ($4, 'birds', 50003, 50003),
         ($5, 'birds', 90003, 90003)`,
      [BUSY, QUIET, OTHER, GROUP, COUNTRY],
    );
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  it("rates a group from its provinces and lets a thin province inherit the group's tier", async () => {
    const { loadCountries, computeCountryTiers } = await import("./compute-local-tiers.js");
    const [country] = await loadCountries([COUNTRY_NAME]);
    expect(country.groups).toEqual([{ id: GROUP, name: "Tier Group", provinceIds: [BUSY, QUIET] }]);
    expect(country.provinces.map((p) => p.id).sort()).toEqual([BUSY, OTHER, QUIET].sort());

    const tiers = await computeCountryTiers(country);
    const tier = (region: string, bird: string) => tiers.find((t) => t.regionId === region && t.speciesId === bird);
    const scarce = BIRDS[5];
    const busy = tier(BUSY, scarce)!;
    expect(busy.reason).toBe("rated");
    // The group and the country take their easiest province's tier for the scarce bird.
    expect(tier(GROUP, scarce)).toMatchObject({ tier: busy.tier, reason: "rated" });
    expect(tier(GROUP, scarce)!.explain?.easiestIn).toBe("Tier Busy");
    expect(tier(COUNTRY, scarce)).toMatchObject({ tier: busy.tier, reason: "rated" });
    // Quiet can't rate it on its own, so it takes its group's tier.
    expect(tier(QUIET, scarce)).toMatchObject({ tier: busy.tier, reason: "inherited" });
    // Every row of the country, the group and the provinces is rated exactly once.
    expect(tiers).toHaveLength(6 + 6 + 6 + 2 + 5);
  });
});

// A second country: a group of thinly birded provinces, and photo-rated mammals in provinces with
// very different effort.
const T = (n: number) => id(100 + n);
const [W2, C2, COUNTRY2, PAIR, THIN_A, THIN_B, WELL, MAMMAL_GROUP, BIG_1, BIG_2, BIG_3, MODEST] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
].map(T);
const PAIR_BIRD = T(20);
const WELL_BIRDS = [21, 22, 23, 24, 25].map(T);
const SHY = T(30);
const MAMMALS = [31, 32, 33, 34, 35].map(T);
const COUNTRY2_NAME = "Tieria Two";

describe.skipIf(!url)("compute-local-tiers: groups as candidates for the country's tier", () => {
  const db = new pg.Pool({ connectionString: url });
  const regionIds = [MODEST, BIG_3, BIG_2, BIG_1, MAMMAL_GROUP, WELL, THIN_B, THIN_A, PAIR, COUNTRY2, C2, W2];
  const speciesIds = [PAIR_BIRD, ...WELL_BIRDS, SHY, ...MAMMALS];
  const cleanup = async () => {
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [regionIds]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [speciesIds]);
  };
  const list = (region: string, species: string, values: { records?: number; photos?: number }) =>
    db.query(
      `INSERT INTO region_species (region_id, species_id, local_frequency, live_recent_records, recent_distinct_years, inat_rg_count)
       VALUES ($1, $2, $3::int, $3::int, 10, $4::int)`,
      [region, species, values.records ?? null, values.photos ?? null],
    );
  const effort = (region: string, group: string, records: number, photos: number | null = null) =>
    db.query(
      `INSERT INTO region_group_effort (region_id, species_group, live_recent_records, all_records, inat_rg_records)
       VALUES ($1, $2, $3, $3, $4)`,
      [region, group, records, photos],
    );
  // A group's and the country's list and inputs are their provinces' summed.
  const sumInto = async (place: string, from: string[]) => {
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_frequency, live_recent_records, recent_distinct_years, inat_rg_count)
       SELECT $1, species_id, sum(local_frequency), sum(live_recent_records), max(recent_distinct_years), sum(inat_rg_count)
       FROM region_species WHERE region_id = ANY($2) GROUP BY species_id`,
      [place, from],
    );
    await db.query(
      `INSERT INTO region_group_effort (region_id, species_group, live_recent_records, all_records, inat_rg_records)
       SELECT $1, species_group, sum(live_recent_records), sum(all_records), sum(inat_rg_records)
       FROM region_group_effort WHERE region_id = ANY($2) GROUP BY species_group`,
      [place, from],
    );
  };

  beforeAll(async () => {
    await cleanup();
    await db.query(
      `INSERT INTO regions (id, name, parent_id, has_children) VALUES
         ($1, 'Tier World 2', NULL, true), ($2, 'Tier Continent 2', $1, true), ($3, $13, $2, true),
         ($4, 'Tier Pair', $3, true), ($5, 'Tier Thin A', $4, false), ($6, 'Tier Thin B', $4, false),
         ($7, 'Tier Well', $3, false), ($8, 'Tier Mammal Group', $3, true), ($9, 'Tier Big 1', $8, false),
         ($10, 'Tier Big 2', $8, false), ($11, 'Tier Big 3', $8, false), ($12, 'Tier Modest', $8, false)`,
      [W2, C2, COUNTRY2, PAIR, THIN_A, THIN_B, WELL, MAMMAL_GROUP, BIG_1, BIG_2, BIG_3, MODEST, COUNTRY2_NAME],
    );
    for (const [i, s] of [PAIR_BIRD, ...WELL_BIRDS].entries())
      await db.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'aves')`, [
        s,
        141000 + i,
        `Tieria duo avis${i}`,
      ]);
    for (const [i, s] of [SHY, ...MAMMALS].entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, $2, $3, 'mammalia')`,
        [s, 142000 + i, `Tieria duo mammalis${i}`],
      );

    // A well-known animal, so a handful of photos reads as hard to find rather than overlooked.
    await db.query(
      `INSERT INTO species_traits (species_id, wiki_pageviews_12mo, source_attribution) VALUES ($1, 500000, 'test')`,
      [SHY],
    );

    // Birds: each Thin province has too few bird records to rate anything (under 2,000), but the
    // pair together has enough. Well is well birded and lacks the pair's bird.
    for (const p of [THIN_A, THIN_B]) {
      await list(p, PAIR_BIRD, { records: 150 });
      await effort(p, "birds", 1500);
    }
    for (const b of WELL_BIRDS) await list(WELL, b, { records: 4000 });
    await effort(WELL, "birds", 40000);

    // Mammals, rated on photos: three heavily photographed provinces where the shy mammal is
    // barely photographed, and a modest one (a sixth of the best province's photos, under a tenth
    // of the group's sum) where it's photographed as much as the commonest mammals.
    for (const p of [BIG_1, BIG_2, BIG_3]) {
      for (const m of MAMMALS) await list(p, m, { photos: 2000 });
      await list(p, SHY, { photos: 3 });
      await effort(p, "mammals", 0, 10000);
    }
    for (const m of MAMMALS) await list(MODEST, m, { photos: 300 });
    await list(MODEST, SHY, { photos: 300 });
    await effort(MODEST, "mammals", 0, 1700);

    await sumInto(PAIR, [THIN_A, THIN_B]);
    await sumInto(MAMMAL_GROUP, [BIG_1, BIG_2, BIG_3, MODEST]);
    await sumInto(COUNTRY2, [THIN_A, THIN_B, WELL, BIG_1, BIG_2, BIG_3, MODEST]);
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
  });

  const run = async () => {
    const { loadCountries, computeCountryTiers } = await import("./compute-local-tiers.js");
    const [country] = await loadCountries([COUNTRY2_NAME]);
    const tiers = await computeCountryTiers(country);
    return (region: string, species: string) => tiers.find((t) => t.regionId === region && t.speciesId === species)!;
  };

  it("rates a species from its group's summed records when no single province can", async () => {
    const tier = await run();
    const pair = tier(PAIR, PAIR_BIRD);
    expect(pair).toMatchObject({ reason: "rated" });
    expect(pair.tier).not.toBeNull();
    // The country takes the group's tier and says where it's easiest; the thin provinces inherit it.
    expect(tier(COUNTRY2, PAIR_BIRD)).toMatchObject({ tier: pair.tier, reason: "rated" });
    expect(tier(COUNTRY2, PAIR_BIRD).explain?.easiestIn).toBe("Tier Pair");
    expect(tier(THIN_A, PAIR_BIRD)).toMatchObject({ tier: pair.tier, reason: "inherited" });
    expect(tier(THIN_B, PAIR_BIRD)).toMatchObject({ tier: pair.tier, reason: "inherited" });
  });

  it("keeps the well-surveyed bar at the best province's effort, not the group's sum", async () => {
    const tier = await run();
    const modest = tier(MODEST, SHY);
    const big = tier(BIG_1, SHY);
    expect([modest.reason, big.reason]).toEqual(["rated", "rated"]);
    expect(TIER_RANK(modest.tier) < TIER_RANK(big.tier)).toBe(true);
    // Modest counts as well surveyed (1,700 photos against a best province's 10,000), so the
    // easier tier there is the country's; against the group's 31,700 it wouldn't count.
    expect(tier(COUNTRY2, SHY)).toMatchObject({ tier: modest.tier, reason: "rated" });
    expect(tier(COUNTRY2, SHY).explain?.easiestIn).toBe("Tier Modest");
    expect(tier(MAMMAL_GROUP, SHY)).toMatchObject({ tier: modest.tier });
  });
});

const TIER_RANK = (tier: string | null) =>
  ["common", "occasional", "uncommon", "rare", "legendary"].indexOf(tier ?? "");
