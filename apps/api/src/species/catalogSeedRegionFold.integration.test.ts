// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run catalogSeedRegionFold
// An install on the 2026-10 catalog has provinces listed twice (under the country and under its
// group). A seed that keeps one copy must fold the other into it, with the user's data.
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { applyCatalogSeedFile } from "./catalogSeedUpdate.js";
import { whenSpeciesSearchReady } from "./search.js";

const url = process.env.TEST_DATABASE_URL;
const id = (n: number) => `f01df01d-0000-4000-8000-${String(n).padStart(12, "0")}`;
const [CONT, COUNTRY, GROUP, P_KEEP, P_DUP, Q_KEEP, Q_DUP, SG, SG_DUP, G_KEEP, G_DUP, DELTA] = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
].map(id);
const [SP1, SP2, SP3] = [101, 102, 103].map(id);
const USER = id(201);
const PACK = "zzfold-test-pack";
const noProgress = { update: () => {}, throwIfCancelled: () => {} };

// The new seed: Alpha re-parented into the group (its duplicate there is dropped), Beta kept in
// the group (its duplicate directly under the country is dropped), South Foldia moved under the
// country where its own duplicate (with a duplicate Gamma) already sits.
function seed(): string {
  const dump = [
    "COPY public.regions (id, name, parent_id, has_children) FROM stdin;",
    `${CONT}\tFoldia Continent\t\\N\tt`,
    `${COUNTRY}\tFoldia\t${CONT}\tt`,
    `${GROUP}\tNorth Foldia\t${COUNTRY}\tt`,
    `${P_KEEP}\tAlpha\t${GROUP}\tf`,
    `${Q_KEEP}\tBeta\t${GROUP}\tf`,
    `${SG}\tSouth Foldia\t${COUNTRY}\tt`,
    `${G_KEEP}\tGamma\t${SG}\tf`,
    "\\.",
    "",
    "COPY public.region_species (region_id, species_id, local_tier, is_vagrant, is_invasive) FROM stdin;",
    `${P_KEEP}\t${SP1}\tuncommon\tf\tf`,
    `${P_KEEP}\t${SP2}\trare\tf\tf`,
    "\\.",
    "",
  ].join("\n");
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-region-fold-")), "seed.sql.gz");
  writeFileSync(file, gzipSync(dump));
  return file;
}

describe.skipIf(!url)("catalog update folds dropped duplicate regions (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const cleanup = async () => {
    await q(`DELETE FROM users WHERE id = $1`, [USER]);
    await q(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    for (const r of [DELTA, G_DUP, G_KEEP, SG_DUP, SG, Q_DUP, Q_KEEP, P_DUP, P_KEEP, GROUP, COUNTRY, CONT])
      await q(`DELETE FROM regions WHERE id = $1`, [r]);
    await q(`DELETE FROM species WHERE id = ANY($1)`, [[SP1, SP2, SP3]]);
  };
  afterAll(async () => {
    await cleanup();
    await whenSpeciesSearchReady();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    await q(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES
         ($1, 990101, 'Folda prima', 'aves'), ($2, 990102, 'Folda secunda', 'aves'), ($3, 990103, 'Folda tertia', 'aves')`,
      [SP1, SP2, SP3],
    );
    // The published tree, duplicates and all.
    await q(
      `INSERT INTO regions (id, name, parent_id) VALUES
         ($1, 'Foldia Continent', NULL), ($2, 'Foldia', $1), ($3, 'North Foldia', $2),
         ($4, 'Alpha', $2), ($5, 'Alpha', $3), ($6, 'Beta', $3), ($7, 'Beta', $2),
         ($8, 'South Foldia', $1), ($9, 'South Foldia', $2), ($10, 'Gamma', $8), ($11, 'Gamma', $9), ($12, 'Delta', $9)`,
      [CONT, COUNTRY, GROUP, P_KEEP, P_DUP, Q_KEEP, Q_DUP, SG, SG_DUP, G_KEEP, G_DUP, DELTA],
    );
    await q(
      `INSERT INTO region_species (region_id, species_id, local_tier, tier_explain) VALUES
         ($1, $3, 'common', NULL), ($2, $3, 'common', '{"from":"pack"}'), ($2, $4, 'rare', NULL)`,
      [P_KEEP, P_DUP, SP1, SP2],
    );
    await q(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'region-fold@test', 'x')`, [USER]);
    await q(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, region_id) VALUES
         ($1, $2, 'zzfold-1', $3), ($1, $2, 'zzfold-2', $4), ($1, $2, 'zzfold-3', $5)`,
      [USER, SP1, P_DUP, Q_DUP, G_DUP],
    );
    await q(`INSERT INTO saved_spots (user_id, name, lat, lon, region_id) VALUES ($1, 'Fold spot', 1, 2, $2)`, [
      USER,
      P_DUP,
    ]);
    await q(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder, region_id) VALUES ($1, 'Fold trip', '/a', '/b', $2)`,
      [USER, Q_DUP],
    );
    await q(`INSERT INTO target_lists (user_id, name, region_id) VALUES ($1, 'Fold targets', $2)`, [USER, P_DUP]);
    await q(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3), ($1, $4, $3)`, [
      USER,
      P_DUP,
      SP2,
      Q_DUP,
    ]);
    // Added to both copies: one row survives.
    await q(
      `INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $4), ($1, $3, $4), ($1, $2, $5)`,
      [USER, P_DUP, P_KEEP, SP3, SP1],
    );
    // A tier set on both copies (the expression-keyed table): the kept region's stays.
    await q(
      `INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier) VALUES
         ($1, $2, $4, 'rare'), ($1, $3, $4, 'common'), ($1, $5, $6, 'legendary')`,
      [USER, P_DUP, P_KEEP, SP1, Q_DUP, SP2],
    );
    await q(
      `INSERT INTO region_species_hotspots (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km) VALUES
         ($1, $3, 1, 1, 3, 1), ($2, $3, 9, 9, 3, 1), ($2, $4, 2, 2, 3, 1)`,
      [P_KEEP, P_DUP, SP1, SP2],
    );
    await q(`INSERT INTO downloaded_packs (pack_id, applied_province_region_ids) VALUES ($1, $2::jsonb)`, [
      PACK,
      JSON.stringify([P_DUP, P_KEEP, Q_DUP]),
    ]);
    await q(`INSERT INTO albums (user_id, name, rules) VALUES ($1, 'Fold album', $2::jsonb)`, [
      USER,
      JSON.stringify({ version: 2, query: { regionId: [P_DUP, Q_KEEP], q: "heron" } }),
    ]);
    await q(`UPDATE regions SET home_country_id = $1 WHERE id = $2`, [Q_DUP, DELTA]);
  });

  const userCounts = async () =>
    (
      await q(
        `SELECT (SELECT count(*) FROM captures_all WHERE user_id = $1)::int AS captures,
                (SELECT count(*) FROM saved_spots WHERE user_id = $1)::int AS spots,
                (SELECT count(*) FROM trips WHERE user_id = $1)::int AS trips,
                (SELECT count(*) FROM target_lists WHERE user_id = $1)::int AS targets,
                (SELECT count(*) FROM albums WHERE user_id = $1)::int AS albums,
                (SELECT count(*) FROM region_species_hidden WHERE user_id = $1)::int AS hidden,
                (SELECT count(*) FROM downloaded_packs WHERE pack_id = $2)::int AS packs`,
        [USER, PACK],
      )
    ).rows[0];
  const version = async () => Number((await q(`SELECT last_value FROM region_checklist_version`)).rows[0].last_value);

  it("folds each dropped duplicate into the kept region, moving the user's data, and a re-run changes nothing", async () => {
    const before = await userCounts();
    const versionBefore = await version();
    const merged = await applyCatalogSeedFile(pool, seed(), null, noProgress);
    expect(merged.regionsFolded).toBe(4);
    expect(await version()).toBeGreaterThan(versionBefore);

    const regions = await q(`SELECT id, name, parent_id, home_country_id FROM regions WHERE id = ANY($1) ORDER BY id`, [
      [CONT, COUNTRY, GROUP, P_KEEP, P_DUP, Q_KEEP, Q_DUP, SG, SG_DUP, G_KEEP, G_DUP, DELTA],
    ]);
    expect(regions.rows).toEqual([
      { id: CONT, name: "Foldia Continent", parent_id: null, home_country_id: null },
      { id: COUNTRY, name: "Foldia", parent_id: CONT, home_country_id: null },
      { id: GROUP, name: "North Foldia", parent_id: COUNTRY, home_country_id: null },
      { id: P_KEEP, name: "Alpha", parent_id: GROUP, home_country_id: null },
      { id: Q_KEEP, name: "Beta", parent_id: GROUP, home_country_id: null },
      { id: SG, name: "South Foldia", parent_id: COUNTRY, home_country_id: null },
      { id: G_KEEP, name: "Gamma", parent_id: SG, home_country_id: null },
      // Local-only, no counterpart: moves under the kept group, its other pointer follows too.
      { id: DELTA, name: "Delta", parent_id: SG, home_country_id: Q_KEEP },
    ]);

    expect(await userCounts()).toEqual(before);
    const where = async (sql: string) => (await q(sql, [USER])).rows;
    expect(
      await where(`SELECT fingerprint, region_id FROM captures_all WHERE user_id = $1 ORDER BY fingerprint`),
    ).toEqual([
      { fingerprint: "zzfold-1", region_id: P_KEEP },
      { fingerprint: "zzfold-2", region_id: Q_KEEP },
      { fingerprint: "zzfold-3", region_id: G_KEEP },
    ]);
    expect(await where(`SELECT region_id FROM saved_spots WHERE user_id = $1`)).toEqual([{ region_id: P_KEEP }]);
    expect(await where(`SELECT region_id FROM trips WHERE user_id = $1`)).toEqual([{ region_id: Q_KEEP }]);
    expect(await where(`SELECT region_id FROM target_lists WHERE user_id = $1`)).toEqual([{ region_id: P_KEEP }]);
    expect(
      await where(`SELECT region_id, species_id FROM region_species_hidden WHERE user_id = $1 ORDER BY region_id`),
    ).toEqual([
      { region_id: P_KEEP, species_id: SP2 },
      { region_id: Q_KEEP, species_id: SP2 },
    ]);
    expect(
      await where(`SELECT region_id, species_id FROM region_species_user_added WHERE user_id = $1 ORDER BY species_id`),
    ).toEqual([
      { region_id: P_KEEP, species_id: SP1 },
      { region_id: P_KEEP, species_id: SP3 },
    ]);
    expect(
      await where(`SELECT region_id, species_id, tier FROM user_tier_overrides WHERE user_id = $1 ORDER BY tier`),
    ).toEqual([
      { region_id: P_KEEP, species_id: SP1, tier: "common" },
      { region_id: Q_KEEP, species_id: SP2, tier: "legendary" },
    ]);
    // The seed's checklist wins; a pack's explanation only the duplicate had is kept.
    const checklist = await q(
      `SELECT species_id, local_tier, tier_explain FROM region_species WHERE region_id = $1 ORDER BY species_id`,
      [P_KEEP],
    );
    expect(checklist.rows).toEqual([
      { species_id: SP1, local_tier: "uncommon", tier_explain: { from: "pack" } },
      { species_id: SP2, local_tier: "rare", tier_explain: null },
    ]);
    const hotspots = await q(
      `SELECT species_id, centroid_lat FROM region_species_hotspots WHERE region_id = $1 ORDER BY species_id`,
      [P_KEEP],
    );
    expect(hotspots.rows).toEqual([
      { species_id: SP1, centroid_lat: 1 },
      { species_id: SP2, centroid_lat: 2 },
    ]);
    const pack = await q(`SELECT applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    expect(pack.rows[0].applied_province_region_ids).toEqual([P_KEEP, Q_KEEP]);
    const album = await where(`SELECT rules FROM albums WHERE user_id = $1`);
    expect(album[0].rules).toEqual({ version: 2, query: { regionId: [P_KEEP, Q_KEEP], q: "heron" } });

    // The next update over the folded catalog has nothing left to fold.
    const snapshot = async () =>
      (
        await q(
          `SELECT (SELECT json_agg(r ORDER BY r.id) FROM (SELECT id, name, parent_id FROM regions WHERE id::text LIKE 'f01df01d%') r) AS regions,
                  (SELECT json_agg(c ORDER BY c.fingerprint) FROM (SELECT fingerprint, region_id FROM captures_all WHERE user_id = $1) c) AS captures,
                  (SELECT count(*) FROM region_species WHERE region_id = $2)::int AS checklist`,
          [USER, P_KEEP],
        )
      ).rows[0];
    const first = await snapshot();
    const again = await applyCatalogSeedFile(pool, seed(), null, noProgress);
    expect(again.regionsFolded).toBeUndefined();
    expect(await snapshot()).toEqual(first);
    expect(await userCounts()).toEqual(before);
  });

  it("rolls the whole fold back when the update fails later on", async () => {
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-region-fold-")), "seed.sql.gz");
    const dump = [
      "COPY public.regions (id, name, parent_id) FROM stdin;",
      `${CONT}\tFoldia Continent\t\\N`,
      `${COUNTRY}\tFoldia\t${CONT}`,
      `${GROUP}\tNorth Foldia\t${COUNTRY}`,
      `${P_KEEP}\tAlpha\t${GROUP}`,
      "\\.",
      "",
      "COPY public.region_species (region_id, species_id, is_vagrant, is_invasive) FROM stdin;",
      `${P_KEEP}\tnot-a-uuid\tf\tf`,
      "\\.",
      "",
    ].join("\n");
    writeFileSync(file, gzipSync(dump));
    await expect(applyCatalogSeedFile(pool, file, null, noProgress)).rejects.toThrow();
    const left = await q(`SELECT id FROM regions WHERE id = ANY($1)`, [[P_DUP, Q_DUP]]);
    expect(left.rowCount).toBe(2);
    const capture = await q(`SELECT region_id FROM captures_all WHERE fingerprint = 'zzfold-1'`);
    expect(capture.rows).toEqual([{ region_id: P_DUP }]);
  });
});

// A pack applied under a province that shares its country's name (Belize District in Belize)
// nested copies of that province and its neighbours under it, which no seed lists.
describe.skipIf(!url)("catalog update folds copies nested under a same-named province (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const nid = (n: number) => `b2b20000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const [CT, BZ, BZD, CAYO, G1, G2, G3] = [1, 2, 3, 4, 5, 6, 7].map(nid);
  const ALL = [CT, BZ, BZD, CAYO, G1, G2, G3];
  const [SP1, SP2] = [nid(101), nid(102)];
  const USER3 = nid(201);
  const row = (id: string, name: string, parent: string | null, code: string | null) =>
    `${id}\t${name}\t${parent ?? "\\N"}\t${code ?? "\\N"}`;

  function nestSeed(): string {
    const dump = [
      "COPY public.regions (id, name, parent_id, ebird_region_code) FROM stdin;",
      row(CT, "Nestia Continent", null, null),
      row(BZ, "Nestia", CT, null),
      row(BZD, "Nestia", BZ, "NZ-NZ"),
      row(CAYO, "Cayo", BZ, "NZ-CY"),
      "\\.",
      "",
      "COPY public.region_species (region_id, species_id, is_vagrant, is_invasive) FROM stdin;",
      `${BZD}\t${SP1}\tf\tf`,
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-region-nest-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    return file;
  }

  const cleanup = async () => {
    await q(`DELETE FROM users WHERE id = $1`, [USER3]);
    for (const r of [...ALL].reverse()) await q(`DELETE FROM regions WHERE id = $1`, [r]);
    await q(`DELETE FROM species WHERE id = ANY($1)`, [[SP1, SP2]]);
  };
  afterAll(async () => {
    await cleanup();
    await whenSpeciesSearchReady();
    await pool.end();
  });

  it("folds each nested copy into the region with its name and eBird code, with the user's photos", async () => {
    await cleanup();
    await q(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 990301, 'Nestia prima', 'aves'), ($2, 990302, 'Nestia secunda', 'aves')`,
      [SP1, SP2],
    );
    const local: Array<[string, string, string | null, string | null]> = [
      [CT, "Nestia Continent", null, null],
      [BZ, "Nestia", CT, null],
      [BZD, "Nestia", BZ, "NZ-NZ"],
      [CAYO, "Cayo", BZ, "NZ-CY"],
      [G1, "Nestia", BZD, "NZ-NZ"],
      [G2, "Nestia", G1, "NZ-NZ"],
      [G3, "Cayo", G1, "NZ-CY"],
    ];
    for (const [id, name, parent, code] of local)
      await q(`INSERT INTO regions (id, name, parent_id, ebird_region_code) VALUES ($1, $2, $3, $4)`, [
        id,
        name,
        parent,
        code,
      ]);
    // The country's whole list, applied to the copy.
    await q(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2), ($1, $3)`, [G1, SP1, SP2]);
    await q(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'region-nest@test', 'x')`, [USER3]);
    await q(
      `INSERT INTO captures_all (user_id, species_id, fingerprint, region_id) VALUES ($1, $2, 'zznest-1', $3), ($1, $2, 'zznest-2', $4)`,
      [USER3, SP1, G2, G3],
    );

    const merged = await applyCatalogSeedFile(pool, nestSeed(), null, noProgress);
    expect(merged.regionsFolded).toBe(3);
    const left = await q(`SELECT id FROM regions WHERE id = ANY($1) ORDER BY id`, [ALL]);
    expect(left.rows.map((r) => r.id)).toEqual([CT, BZ, BZD, CAYO]);
    const captures = await q(`SELECT fingerprint, region_id FROM captures_all WHERE user_id = $1 ORDER BY 1`, [USER3]);
    expect(captures.rows).toEqual([
      { fingerprint: "zznest-1", region_id: BZD },
      { fingerprint: "zznest-2", region_id: CAYO },
    ]);
    // The seed's list for the district wins over the copy's.
    const checklist = await q(`SELECT species_id FROM region_species WHERE region_id = $1`, [BZD]);
    expect(checklist.rows).toEqual([{ species_id: SP1 }]);

    const again = await applyCatalogSeedFile(pool, nestSeed(), null, noProgress);
    expect(again.regionsFolded).toBeUndefined();
  });
});

// Places that only look alike must never fold, and user data on both copies of a real duplicate
// (and on a dropped region's children) must all survive.
describe.skipIf(!url)("catalog update never folds look-alike regions (integration)", () => {
  const pool = new pg.Pool({ connectionString: url });
  const q = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const aid = (n: number) => `adad0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const [
    CT,
    XL,
    XG,
    VIC_K,
    VIC_D,
    YL,
    ZL,
    ZG,
    COR_K,
    COR_D,
    US,
    GEO_K,
    GEO_D,
    WL,
    WG,
    OM_K,
    OM_D,
    SUB2_K,
    SUB2_D,
    SUB1,
  ] = Array.from({ length: 20 }, (_, i) => aid(i + 1));
  const ALL = [
    CT,
    XL,
    XG,
    VIC_K,
    VIC_D,
    YL,
    ZL,
    ZG,
    COR_K,
    COR_D,
    US,
    GEO_K,
    GEO_D,
    WL,
    WG,
    OM_K,
    OM_D,
    SUB2_K,
    SUB2_D,
    SUB1,
  ];
  const [SP1, SP2] = [aid(101), aid(102)];
  const USER2 = aid(201);
  const SETTINGS = ["zzadv_region_ids", "zzadv_region"];

  // Georgia the country sits beside Usland, whose state Georgia the seed drops: the same shape as
  // a province listed under its country and its group, told apart only by the eBird code.
  function advSeed(): string {
    const row = (id: string, name: string, parent: string | null, code: string | null) =>
      `${id}\t${name}\t${parent ?? "\\N"}\t${code ?? "\\N"}`;
    const dump = [
      "COPY public.regions (id, name, parent_id, ebird_region_code) FROM stdin;",
      row(CT, "Advia Continent", null, null),
      row(XL, "Xland", CT, "XL"),
      row(XG, "North Xland", XL, null),
      row(VIC_K, "Victoria", XG, "XL-VC"),
      row(YL, "Yland", CT, "YL"),
      row(ZL, "Zland", CT, "ZL"),
      row(ZG, "West Zland", ZL, null),
      row(COR_K, "Cordoba", ZG, null),
      row(US, "Usland", CT, "US"),
      row(GEO_K, "Georgia", CT, "GE"),
      row(WL, "Wland", CT, "WL"),
      row(WG, "Wgroup", WL, null),
      row(OM_K, "Omega", WL, "WL-9"), // renumbered: both local copies still say WL-OM
      row(SUB2_K, "Sub Two", OM_K, null),
      "\\.",
      "",
    ].join("\n");
    const file = path.join(mkdtempSync(path.join(os.tmpdir(), "lifer-region-adv-")), "seed.sql.gz");
    writeFileSync(file, gzipSync(dump));
    return file;
  }

  const cleanup = async () => {
    await q(`DELETE FROM users WHERE id = $1`, [USER2]);
    await q(`DELETE FROM install_settings WHERE key = ANY($1)`, [SETTINGS]);
    for (const r of [...ALL].reverse()) await q(`DELETE FROM regions WHERE id = $1`, [r]);
    await q(`DELETE FROM species WHERE id = ANY($1)`, [[SP1, SP2]]);
  };
  afterAll(async () => {
    await cleanup();
    await whenSpeciesSearchReady();
    await pool.end();
  });

  beforeEach(async () => {
    await cleanup();
    await q(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 990201, 'Advia prima', 'aves'), ($2, 990202, 'Advia secunda', 'aves')`,
      [SP1, SP2],
    );
    const regions: Array<[string, string, string | null, string | null]> = [
      [CT, "Advia Continent", null, null],
      [XL, "Xland", CT, "XL"],
      [XG, "North Xland", XL, null],
      [VIC_K, "Victoria", XG, "XL-VC"],
      [VIC_D, "Victoria", XL, "XL-VI"],
      [YL, "Yland", CT, "YL"],
      [ZL, "Zland", CT, "ZL"],
      [ZG, "West Zland", ZL, null],
      [COR_K, "Cordoba", ZG, null],
      [COR_D, "Cordoba", YL, null],
      [US, "Usland", CT, "US"],
      [GEO_K, "Georgia", CT, "GE"],
      [GEO_D, "Georgia", US, "US-GA"],
      [WL, "Wland", CT, "WL"],
      [WG, "Wgroup", WL, null],
      [OM_K, "Omega", WG, "WL-OM"],
      [OM_D, "Omega", WL, "WL-OM"],
      [SUB2_K, "Sub Two", OM_K, null],
      [SUB2_D, "Sub Two", OM_D, null],
      [SUB1, "Sub One", OM_D, null],
    ];
    for (const [id, name, parent, code] of regions)
      await q(`INSERT INTO regions (id, name, parent_id, ebird_region_code) VALUES ($1, $2, $3, $4)`, [
        id,
        name,
        parent,
        code,
      ]);
    await q(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'region-adv@test', 'x')`, [USER2]);
    for (const r of [VIC_D, COR_D, GEO_D, SUB1, SUB2_D, OM_D])
      await q(`INSERT INTO captures_all (user_id, species_id, fingerprint, region_id) VALUES ($1, $2, $3, $4)`, [
        USER2,
        SP1,
        `zzadv-${r}`,
        r,
      ]);
    // Set on both copies: the one the user set last wins, whichever copy it's on.
    await q(
      `INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier, created_at) VALUES
         ($1, $2, $4, 'common', now() - interval '1 day'), ($1, $3, $4, 'rare', now()),
         ($1, $2, $5, 'legendary', now()), ($1, $3, $5, 'common', now() - interval '1 day')`,
      [USER2, OM_K, OM_D, SP1, SP2],
    );
    await q(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $4), ($1, $3, $4)`, [
      USER2,
      OM_K,
      OM_D,
      SP1,
    ]);
    await q(`INSERT INTO target_lists (user_id, name, region_id) VALUES ($1, 'Kept list', $2), ($1, 'Dup list', $3)`, [
      USER2,
      OM_K,
      OM_D,
    ]);
    await q(`INSERT INTO albums (user_id, name, rules) VALUES ($1, 'Adv album', $2::jsonb)`, [
      USER2,
      JSON.stringify({
        a: [OM_D, OM_D, SUB2_D],
        nested: { x: { regionId: OM_D } },
        s: `region:${OM_D}`,
        tags: ["x", "x"],
      }),
    ]);
    await q(`INSERT INTO install_settings (key, value) VALUES ($1, $2::jsonb), ($3, $4::jsonb)`, [
      SETTINGS[0],
      JSON.stringify([OM_D, OM_K, SUB1]),
      SETTINGS[1],
      JSON.stringify(OM_D),
    ]);
  });

  it("folds only the true duplicate, keeps look-alikes and every piece of the user's data", async () => {
    const merged = await applyCatalogSeedFile(pool, advSeed(), null, noProgress);
    expect(merged.regionsFolded).toBe(2);

    const tree = await q(`SELECT id, parent_id FROM regions WHERE id = ANY($1) ORDER BY id`, [ALL]);
    const parent = Object.fromEntries(tree.rows.map((r) => [r.id, r.parent_id]));
    expect(Object.keys(parent)).not.toContain(OM_D);
    expect(Object.keys(parent)).not.toContain(SUB2_D);
    expect(parent[VIC_D]).toBe(XL);
    expect(parent[COR_D]).toBe(YL);
    expect(parent[GEO_D]).toBe(US);
    expect(parent[OM_K]).toBe(WL);
    expect(parent[SUB1]).toBe(OM_K);

    const captures = await q(`SELECT fingerprint, region_id FROM captures_all WHERE user_id = $1`, [USER2]);
    const at = Object.fromEntries(captures.rows.map((r) => [r.fingerprint.slice(6), r.region_id]));
    expect(at).toEqual({
      [VIC_D]: VIC_D,
      [COR_D]: COR_D,
      [GEO_D]: GEO_D,
      [SUB1]: SUB1,
      [SUB2_D]: SUB2_K,
      [OM_D]: OM_K,
    });

    const tiers = await q(
      `SELECT region_id, species_id, tier FROM user_tier_overrides WHERE user_id = $1 ORDER BY species_id`,
      [USER2],
    );
    expect(tiers.rows).toEqual([
      { region_id: OM_K, species_id: SP1, tier: "rare" },
      { region_id: OM_K, species_id: SP2, tier: "legendary" },
    ]);
    const hidden = await q(`SELECT region_id FROM region_species_hidden WHERE user_id = $1`, [USER2]);
    expect(hidden.rows).toEqual([{ region_id: OM_K }]);
    const lists = await q(`SELECT name, region_id FROM target_lists WHERE user_id = $1 ORDER BY name`, [USER2]);
    expect(lists.rows).toEqual([
      { name: "Dup list", region_id: OM_K },
      { name: "Kept list", region_id: OM_K },
    ]);
    const album = await q(`SELECT rules FROM albums WHERE user_id = $1`, [USER2]);
    expect(album.rows[0].rules).toEqual({
      a: [OM_K, SUB2_K],
      nested: { x: { regionId: OM_K } },
      s: `region:${OM_K}`,
      tags: ["x", "x"],
    });
    const settings = await q(`SELECT key, value FROM install_settings WHERE key = ANY($1) ORDER BY key`, [SETTINGS]);
    expect(settings.rows).toEqual([
      { key: SETTINGS[1], value: OM_K },
      { key: SETTINGS[0], value: [OM_K, SUB1] },
    ]);

    const again = await applyCatalogSeedFile(pool, advSeed(), null, noProgress);
    expect(again.regionsFolded).toBeUndefined();
    const capturesAgain = await q(`SELECT fingerprint, region_id FROM captures_all WHERE user_id = $1`, [USER2]);
    expect(capturesAgain.rows.length).toBe(6);
  });
});
