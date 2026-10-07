// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run speciesMerges
// applySpeciesMerges (migration 113): user data and gaps move to the survivor, chains resolve.
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Imports neither config nor the pool, so a static import is safe before DATABASE_URL is set.
import { applySpeciesMerges } from "./speciesMerges.js";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000411";
const REGION = "ffffffff-0000-4000-8000-0000000004b1";
const REGION2 = "ffffffff-0000-4000-8000-0000000004b2";
const NEW = "ffffffff-0000-4000-8000-000000000420";
const OLD = "ffffffff-0000-4000-8000-000000000421";
// Merged into OLD, so it has to follow the chain on to NEW.
const OLDER = "ffffffff-0000-4000-8000-000000000422";
const CAPTURE = "ffffffff-0000-4000-8000-000000000431";

describe.skipIf(!url)("applySpeciesMerges", () => {
  let db: pg.Pool;
  let hasTable = false;

  async function cleanup() {
    await db.query(`DELETE FROM captures_all WHERE id = $1`, [CAPTURE]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db
      .query(`DELETE FROM species_merges WHERE old_species_id = ANY($1) OR new_species_id = ANY($1)`, [
        [NEW, OLD, OLDER],
      ])
      .catch(() => {});
    await db.query(`DELETE FROM species_synonyms WHERE synonym_name LIKE 'Zzmerge%'`);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[NEW, OLD, OLDER]]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[REGION, REGION2]]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    hasTable = ((await db.query(`SELECT 1 FROM pg_class WHERE relname = 'species_merges'`)).rowCount ?? 0) > 0;
    if (!hasTable) return;
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'merge@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzmergeland', '{ZZM}'), ($2, 'Zzmergeland Two', '{ZZN}')`,
      [REGION, REGION2],
    );
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, ebird_code, taxon_class, family) VALUES
         ($1, 914100, 'Zzmergea nova', NULL, NULL, 'aves', 'Zzmergidae'),
         ($2, 914101, 'Zzmergea vetus', 'Old Merge Bird', 'zzmold1', 'aves', 'Zzmergidae'),
         ($3, 914102, 'Zzmergea antiqua', 'Older Merge Bird', NULL, 'aves', NULL)`,
      [NEW, OLD, OLDER],
    );
    // The survivor is on REGION2 only; the old entry adds REGION, and its REGION2 row is dropped.
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_frequency, local_tier) VALUES
         ($1, $3, 5, 'uncommon'), ($2, $3, 9, 'common'), ($2, $4, 40, 'occasional')`,
      [REGION, REGION2, OLD, NEW],
    );
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Zzmergea vetusta')`, [OLD]);
    // Collected on the old entry, seen and targeted on the survivor.
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state, first_collected, best_quality, is_target) VALUES
         ($1, $2, 'collected', '2020-01-01', 3, false), ($1, $3, 'seen', NULL, NULL, true), ($1, $4, 'collected', '2018-06-01', 5, false)`,
      [USER, OLD, NEW, OLDER],
    );
    await db.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2)`, [USER, OLD]);
    await db.query(
      `INSERT INTO captures_all (id, user_id, species_id, fingerprint) VALUES ($1, $2, $3, 'zzmerge-fp')`,
      [CAPTURE, USER, OLD],
    );
    await db.query(
      `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name) VALUES ($1, $2, 'Zzmergea vetus'), ($3, $1, 'Zzmergea antiqua')`,
      [OLD, NEW, OLDER],
    );
  });

  afterAll(async () => {
    if (hasTable) await cleanup();
    await db.end();
  });

  it("folds both old entries into the survivor with everything they carried", async (ctx) => {
    if (!hasTable) ctx.skip();
    const client = await db.connect();
    let result;
    try {
      await client.query("BEGIN");
      result = await applySpeciesMerges(client);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    expect(result.merged).toBe(2);
    expect(result.captures).toEqual([{ userId: USER, captureId: CAPTURE }]);

    const left = await db.query(`SELECT id FROM species WHERE id = ANY($1)`, [[NEW, OLD, OLDER]]);
    expect(left.rows.map((r) => r.id)).toEqual([NEW]);

    // Gaps filled from the old entry, the survivor's own name kept.
    const sp = (await db.query(`SELECT scientific_name, common_name, ebird_code FROM species WHERE id = $1`, [NEW]))
      .rows[0];
    expect(sp).toEqual({ scientific_name: "Zzmergea nova", common_name: "Old Merge Bird", ebird_code: "zzmold1" });

    // REGION comes from the old entry; REGION2 keeps the survivor's own row.
    const rs = await db.query(
      `SELECT region_id, local_frequency::int AS f FROM region_species WHERE species_id = $1 ORDER BY region_id`,
      [NEW],
    );
    expect(rs.rows).toEqual([
      { region_id: REGION, f: 5 },
      { region_id: REGION2, f: 40 },
    ]);

    // Collected beats seen, the earliest date and best quality win, the target stays.
    const us = (
      await db.query(
        `SELECT state, first_collected::text AS fc, best_quality, is_target FROM user_species WHERE user_id = $1`,
        [USER],
      )
    ).rows;
    expect(us).toEqual([{ state: "collected", fc: "2018-06-01", best_quality: 5, is_target: true }]);

    expect((await db.query(`SELECT species_id FROM captures_all WHERE id = $1`, [CAPTURE])).rows[0].species_id).toBe(
      NEW,
    );
    expect((await db.query(`SELECT species_id FROM user_archived_species WHERE user_id = $1`, [USER])).rows).toEqual([
      { species_id: NEW },
    ]);

    const syn = await db.query(
      `SELECT synonym_name FROM species_synonyms WHERE species_id = $1 ORDER BY synonym_name`,
      [NEW],
    );
    expect(syn.rows.map((r) => r.synonym_name)).toEqual(["Zzmergea antiqua", "Zzmergea vetus", "Zzmergea vetusta"]);

    // The chain's first link now points at the survivor instead of cascading away with OLD.
    const chain = await db.query(
      `SELECT old_species_id, new_species_id FROM species_merges WHERE old_species_id = ANY($1) ORDER BY old_species_id`,
      [[OLD, OLDER]],
    );
    expect(chain.rows).toEqual([
      { old_species_id: OLD, new_species_id: NEW },
      { old_species_id: OLDER, new_species_id: NEW },
    ]);
  });

  it("does nothing the second time", async (ctx) => {
    if (!hasTable) ctx.skip();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      expect((await applySpeciesMerges(client)).merged).toBe(0);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
  });
});

// One scenario per test, each inside a transaction that is rolled back, so nothing here depends on
// another test's rows. OLD_X is merged into SURV_X in every scenario.
describe.skipIf(!url)("applySpeciesMerges, scenario by scenario", () => {
  let db: pg.Pool;
  const U1 = "ffffffff-0000-4000-8000-000000000441";
  const U2 = "ffffffff-0000-4000-8000-000000000442";
  const R1 = "ffffffff-0000-4000-8000-0000000004c1";
  const R2 = "ffffffff-0000-4000-8000-0000000004c2";
  const SURV = "ffffffff-0000-4000-8000-000000000450";
  const OLD_X = "ffffffff-0000-4000-8000-000000000451";
  const OLD_Y = "ffffffff-0000-4000-8000-000000000452";
  const OTHER = "ffffffff-0000-4000-8000-000000000453";

  beforeAll(() => {
    db = new pg.Pool({ connectionString: url });
  });
  afterAll(async () => {
    await db.end();
  });

  type Client = pg.PoolClient;
  async function scenario(run: (c: Client, merge: () => ReturnType<typeof applyMerges>) => Promise<void>) {
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO users (id, email, password_hash) VALUES ($1, 'fold1@test', 'x'), ($2, 'fold2@test', 'x')`,
        [U1, U2],
      );
      await client.query(`INSERT INTO regions (id, name) VALUES ($1, 'Zzfoldland'), ($2, 'Zzfoldland Two')`, [R1, R2]);
      await client.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES
           ($1, 914150, 'Zzfolda nova', 'aves'), ($2, 914151, 'Zzfolda vetus', 'aves'),
           ($3, 914152, 'Zzfolda antiqua', 'aves'), ($4, 914153, 'Zzfolda alia', 'aves')`,
        [SURV, OLD_X, OLD_Y, OTHER],
      );
      await client.query(
        `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name) VALUES ($1, $2, 'Zzfolda vetus')`,
        [OLD_X, SURV],
      );
      await run(client, () => applyMerges(client));
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  }
  async function applyMerges(client: Client) {
    return applySpeciesMerges(client);
  }
  const rows = async (c: Client, sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;

  it("keeps a user's originals and multi-species tags, which would cascade away with the old entry", async () => {
    await scenario(async (c, merge) => {
      const capture = async (fp: string) =>
        (
          await c.query(
            `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, $3) RETURNING id`,
            [U1, OLD_X, fp],
          )
        ).rows[0].id as string;
      const c1 = await capture("fold-1");
      const c2 = await capture("fold-2");
      await c.query(
        `INSERT INTO originals (capture_id, user_id, species_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, $2, $3, 'jpeg', 'path', '/library/fold.jpg', true, 'fold-hash', 1)`,
        [c1, U1, OLD_X],
      );
      // c1 is tagged with the old entry and another species; c2 already with both entries.
      await c.query(
        `INSERT INTO capture_species (capture_id, species_id) VALUES ($1, $3), ($1, $4), ($2, $3), ($2, $5)`,
        [c1, c2, OLD_X, OTHER, SURV],
      );
      await merge();
      expect(await rows(c, `SELECT species_id, ref FROM originals WHERE content_hash = 'fold-hash'`)).toEqual([
        { species_id: SURV, ref: "/library/fold.jpg" },
      ]);
      const tags = await rows(
        c,
        `SELECT capture_id, species_id FROM capture_species WHERE capture_id = ANY($1) ORDER BY capture_id, species_id`,
        [[c1, c2]],
      );
      expect(tags).toEqual(
        [
          { capture_id: c1, species_id: SURV },
          { capture_id: c1, species_id: OTHER },
          { capture_id: c2, species_id: SURV },
        ].sort((a, b) => (a.capture_id + a.species_id).localeCompare(b.capture_id + b.species_id)),
      );
    });
  });

  it("carries every user's archived, hidden, checklist-addition and tier marks, the survivor's own mark winning", async () => {
    await scenario(async (c, merge) => {
      await c.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $3), ($2, $3)`, [
        U1,
        U2,
        OLD_X,
      ]);
      await c.query(
        `INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $4), ($1, $3, $4)`,
        [U1, R1, R2, OLD_X],
      );
      // Added by hand to R1 under the old entry, and to R2 under both: one row each on the survivor.
      await c.query(
        `INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $4), ($1, $3, $4), ($1, $3, $5)`,
        [U1, R1, R2, OLD_X, SURV],
      );
      await c.query(
        `INSERT INTO user_tier_overrides (user_id, region_id, species_id, tier) VALUES
           ($1, $2, $4, 'rare'), ($1, $3, $4, 'uncommon'), ($1, NULL, $4, 'common'), ($1, $2, $5, 'legendary')`,
        [U1, R1, R2, OLD_X, SURV],
      );
      // Added by hand to a sea zone under both entries: one row on the survivor.
      const zone = (
        await c.query<{ id: string }>(
          `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
           VALUES ('Zzfold Marks Sea', 'POINT(0 0)', 0, 0, 1, 1) RETURNING id`,
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO sea_zone_species_user_added (user_id, sea_zone_id, species_id) VALUES ($1, $3, $4), ($1, $3, $5), ($2, $3, $4)`,
        [U1, U2, zone, OLD_X, SURV],
      );
      await merge();
      expect(
        await rows(c, `SELECT user_id FROM sea_zone_species_user_added WHERE species_id = $1 ORDER BY user_id`, [SURV]),
      ).toEqual([{ user_id: U1 }, { user_id: U2 }]);
      expect(
        await rows(c, `SELECT user_id FROM user_archived_species WHERE species_id = $1 ORDER BY user_id`, [SURV]),
      ).toEqual([{ user_id: U1 }, { user_id: U2 }]);
      expect(
        await rows(c, `SELECT region_id FROM region_species_hidden WHERE species_id = $1 ORDER BY region_id`, [SURV]),
      ).toEqual([{ region_id: R1 }, { region_id: R2 }]);
      expect(
        await rows(c, `SELECT region_id FROM region_species_user_added WHERE species_id = $1 ORDER BY region_id`, [
          SURV,
        ]),
      ).toEqual([{ region_id: R1 }, { region_id: R2 }]);
      const tiers = await rows(
        c,
        `SELECT region_id, tier FROM user_tier_overrides WHERE species_id = $1 ORDER BY region_id NULLS LAST`,
        [SURV],
      );
      expect(tiers).toEqual([
        { region_id: R1, tier: "legendary" },
        { region_id: R2, tier: "uncommon" },
        { region_id: null, tier: "common" },
      ]);
    });
  });

  it("copies catalog rows the survivor lacks, one per region, zone, country and pack", async () => {
    await scenario(async (c, merge) => {
      const zones = (
        await c.query(
          `INSERT INTO sea_zones (name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat)
           VALUES ('Zzfold Sea', 'POINT(0 0)', 0, 0, 1, 1), ('Zzfold Sea Two', 'POINT(0 0)', 0, 0, 1, 1) RETURNING id`,
        )
      ).rows.map((r) => r.id as string);
      await c.query(`INSERT INTO downloaded_packs (pack_id) VALUES ('zzfold-a'), ('zzfold-b') ON CONFLICT DO NOTHING`);
      await c.query(`INSERT INTO species_traits (species_id, source_attribution) VALUES ($1, 'old traits')`, [OLD_X]);
      await c.query(
        `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier) VALUES ($1, 1, 1, 1, 'rare')`,
        [OLD_X],
      );
      for (const table of [
        "species_reference_embeddings",
        "species_text_embeddings",
        "id_model_reference_embeddings",
        "id_model_text_embeddings",
      ]) {
        await c.query(`INSERT INTO ${table} (species_id, embedding, model_version) VALUES ($1, '{0.5}', 'zzfold')`, [
          OLD_X,
        ]);
      }
      await c.query(
        `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $3, 4), ($2, $3, 7)`,
        [...zones, OLD_X],
      );
      await c.query(
        `INSERT INTO region_species (region_id, species_id, local_frequency) VALUES ($1, $3, 3), ($2, $3, 4)`,
        [R1, R2, OLD_X],
      );
      await c.query(
        `INSERT INTO species_nonnative_countries (species_id, country_iso3) VALUES ($1, 'NZL'), ($1, 'AUS')`,
        [OLD_X],
      );
      await c.query(
        `INSERT INTO region_species_manual_overrides (region_id, species_id, is_vagrant, source) VALUES ($1, $3, true, 'x'), ($2, $3, false, 'y')`,
        [R1, R2, OLD_X],
      );
      await c.query(`INSERT INTO pack_species (pack_id, species_id) VALUES ('zzfold-a', $1), ('zzfold-b', $1)`, [
        OLD_X,
      ]);
      await merge();
      const one = async (sql: string) => (await rows(c, sql, [SURV])).length;
      expect(await rows(c, `SELECT source_attribution FROM species_traits WHERE species_id = $1`, [SURV])).toEqual([
        { source_attribution: "old traits" },
      ]);
      expect(await rows(c, `SELECT tier FROM species_rarity WHERE species_id = $1`, [SURV])).toEqual([
        { tier: "rare" },
      ]);
      for (const table of [
        "species_reference_embeddings",
        "species_text_embeddings",
        "id_model_reference_embeddings",
        "id_model_text_embeddings",
      ]) {
        expect(await one(`SELECT 1 FROM ${table} WHERE species_id = $1`)).toBe(1);
      }
      expect(await one(`SELECT 1 FROM sea_zone_species WHERE species_id = $1`)).toBe(2);
      expect(await one(`SELECT 1 FROM region_species WHERE species_id = $1`)).toBe(2);
      expect(
        await rows(c, `SELECT country_iso3 FROM species_nonnative_countries WHERE species_id = $1 ORDER BY 1`, [SURV]),
      ).toEqual([{ country_iso3: "AUS" }, { country_iso3: "NZL" }]);
      expect(await one(`SELECT 1 FROM region_species_manual_overrides WHERE species_id = $1`)).toBe(2);
      expect(await rows(c, `SELECT pack_id FROM pack_species WHERE species_id = $1 ORDER BY 1`, [SURV])).toEqual([
        { pack_id: "zzfold-a" },
        { pack_id: "zzfold-b" },
      ]);
    });
  });

  it("fills the survivor's empty fields, moving the photo and description each as a set", async () => {
    await scenario(async (c, merge) => {
      await c.query(
        `UPDATE species SET inat_taxon_id = 4242, family = 'Zzfoldidae', taxon_order = 'Zzfoldiformes', habitat_description = 'marsh',
           aba_code = 'ZZFO', inat_iconic_taxon = 'Aves', wikipedia_title = 'Zzfold', commons_image = 'zz.jpg',
           reference_photo = 'https://example.org/old.jpg', reference_credit = 'Old Photographer', reference_license = 'cc-by',
           reference_focal_x = 20, reference_focal_y = 30, reference_display_path = '/d/old.webp', reference_thumb_path = '/t/old.webp',
           description = 'An old description.', description_credit = 'Wikipedia', description_source_url = 'https://example.org/wiki'
         WHERE id = $1`,
        [OLD_X],
      );
      await merge();
      const [s] = await rows(
        c,
        `SELECT inat_taxon_id, family, taxon_order, habitat_description, aba_code, inat_iconic_taxon, wikipedia_title,
                commons_image, reference_photo, reference_credit, reference_license, reference_focal_x::int AS fx,
                reference_focal_y::int AS fy, reference_display_path, reference_thumb_path, description, description_credit,
                description_source_url
           FROM species WHERE id = $1`,
        [SURV],
      );
      expect(s).toEqual({
        inat_taxon_id: 4242,
        family: "Zzfoldidae",
        taxon_order: "Zzfoldiformes",
        habitat_description: "marsh",
        aba_code: "ZZFO",
        inat_iconic_taxon: "Aves",
        wikipedia_title: "Zzfold",
        commons_image: "zz.jpg",
        reference_photo: "https://example.org/old.jpg",
        reference_credit: "Old Photographer",
        reference_license: "cc-by",
        fx: 20,
        fy: 30,
        reference_display_path: "/d/old.webp",
        reference_thumb_path: "/t/old.webp",
        description: "An old description.",
        description_credit: "Wikipedia",
        description_source_url: "https://example.org/wiki",
      });
    });
  });

  it("keeps the survivor's own photo and description rather than mixing in the old entry's", async () => {
    await scenario(async (c, merge) => {
      const photo = (url: string, credit: string) =>
        `reference_photo = '${url}', reference_credit = '${credit}', reference_license = 'cc0'`;
      const desc = (text: string) =>
        `description = '${text}', description_credit = 'c', description_source_url = 'https://example.org/${text}'`;
      await c.query(`UPDATE species SET ${photo("https://example.org/old.jpg", "Old")}, ${desc("old")} WHERE id = $1`, [
        OLD_X,
      ]);
      await c.query(`UPDATE species SET ${photo("https://example.org/own.jpg", "Own")}, ${desc("own")} WHERE id = $1`, [
        SURV,
      ]);
      await merge();
      expect(
        await rows(c, `SELECT reference_photo, reference_credit, description FROM species WHERE id = $1`, [SURV]),
      ).toEqual([{ reference_photo: "https://example.org/own.jpg", reference_credit: "Own", description: "own" }]);
    });
  });

  it("keeps the old common name findable as an alias only when it's really a different name", async () => {
    await scenario(async (c, merge) => {
      // Three survivors at once: a different name, the same name in other case, an existing alias.
      const ids = [
        "ffffffff-0000-4000-8000-000000000460",
        "ffffffff-0000-4000-8000-000000000461",
        "ffffffff-0000-4000-8000-000000000462",
      ];
      const olds = [
        "ffffffff-0000-4000-8000-000000000463",
        "ffffffff-0000-4000-8000-000000000464",
        "ffffffff-0000-4000-8000-000000000465",
      ];
      await c.query(
        `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, common_name, common_name_aliases) VALUES
           ($1, 914160, 'Zzalia a', 'aves', 'Marsh Zzbird', NULL), ($2, 914161, 'Zzalia b', 'aves', 'Reed Zzbird', NULL),
           ($3, 914162, 'Zzalia c', 'aves', 'Sedge Zzbird', '{Old Sedge Zzbird}'),
           ($4, 914163, 'Zzalia d', 'aves', 'Swamp Zzbird', NULL), ($5, 914164, 'Zzalia e', 'aves', 'reed zzbird', NULL),
           ($6, 914165, 'Zzalia f', 'aves', 'old sedge zzbird', NULL)`,
        [...ids, ...olds],
      );
      await c.query(
        `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name) VALUES ($1, $4, 'Zzalia d'), ($2, $5, 'Zzalia e'), ($3, $6, 'Zzalia f')`,
        [...olds, ...ids],
      );
      await merge();
      const aliases = await rows(
        c,
        `SELECT common_name, common_name_aliases FROM species WHERE id = ANY($1) ORDER BY scientific_name`,
        [ids],
      );
      expect(aliases).toEqual([
        { common_name: "Marsh Zzbird", common_name_aliases: ["Swamp Zzbird"] },
        { common_name: "Reed Zzbird", common_name_aliases: null },
        { common_name: "Sedge Zzbird", common_name_aliases: ["Old Sedge Zzbird"] },
      ]);
    });
  });

  it("records the old name as a merge synonym and drops a synonym that is just the survivor's own name", async () => {
    await scenario(async (c, merge) => {
      await c.query(
        `INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'zzfolda NOVA'), ($1, 'Zzfolda vetusta')`,
        [OLD_X],
      );
      await merge();
      const syn = await rows(
        c,
        `SELECT synonym_name, source FROM species_synonyms WHERE species_id = $1 ORDER BY synonym_name`,
        [SURV],
      );
      expect(syn).toEqual([
        { synonym_name: "Zzfolda vetus", source: "merge" },
        { synonym_name: "Zzfolda vetusta", source: null },
      ]);
    });
  });

  it("moves a gallery with its vectors to a survivor without one, the larger gallery winning", async () => {
    await scenario(async (c, merge) => {
      await c.query(
        `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name) VALUES ($1, $2, 'Zzfolda antiqua')`,
        [OLD_Y, SURV],
      );
      const photo = async (species: string, url: string) => {
        const id = (
          await c.query(
            `INSERT INTO species_reference_photos (species_id, photo_url, credit, license) VALUES ($1, $2, 'c', 'cc0') RETURNING id`,
            [species, url],
          )
        ).rows[0].id as string;
        for (const table of ["species_reference_gallery_embeddings", "id_model_gallery_embeddings"]) {
          await c.query(
            `INSERT INTO ${table} (reference_photo_id, species_id, embedding, model_version) VALUES ($1, $2, '{0.1}', 'zz')`,
            [id, species],
          );
        }
        return id;
      };
      const a = await photo(OLD_X, "https://example.org/x1.jpg");
      const b = await photo(OLD_X, "https://example.org/x2.jpg");
      await photo(OLD_Y, "https://example.org/y1.jpg");
      await merge();
      expect(
        await rows(c, `SELECT id FROM species_reference_photos WHERE species_id = $1 ORDER BY photo_url`, [SURV]),
      ).toEqual([{ id: a }, { id: b }]);
      for (const table of ["species_reference_gallery_embeddings", "id_model_gallery_embeddings"]) {
        const vectors = await rows(c, `SELECT reference_photo_id FROM ${table} WHERE species_id = $1 ORDER BY 1`, [
          SURV,
        ]);
        expect(vectors.map((r) => r.reference_photo_id).sort()).toEqual([a, b].sort());
      }
    });
  });

  it("keeps the survivor's own gallery", async () => {
    await scenario(async (c, merge) => {
      await c.query(
        `INSERT INTO species_reference_photos (species_id, photo_url, credit, license) VALUES ($1, 'https://example.org/own.jpg', 'c', 'cc0'),
           ($2, 'https://example.org/x1.jpg', 'c', 'cc0'), ($2, 'https://example.org/x2.jpg', 'c', 'cc0')`,
        [SURV, OLD_X],
      );
      await merge();
      expect(await rows(c, `SELECT photo_url FROM species_reference_photos WHERE species_id = $1`, [SURV])).toEqual([
        { photo_url: "https://example.org/own.jpg" },
      ]);
    });
  });

  it("moves hotspot clusters only for regions where the survivor has none", async () => {
    await scenario(async (c, merge) => {
      const spot = (region: string, species: string, points: number) =>
        c.query(
          `INSERT INTO region_species_hotspots (region_id, species_id, centroid_lat, centroid_lon, point_count, bbox_diagonal_km)
           VALUES ($1, $2, 0, 0, $3, 1)`,
          [region, species, points],
        );
      await spot(R1, OLD_X, 11);
      await spot(R2, OLD_X, 12);
      await spot(R2, SURV, 99);
      await merge();
      expect(
        await rows(
          c,
          `SELECT region_id, point_count FROM region_species_hotspots WHERE species_id = $1 ORDER BY region_id`,
          [SURV],
        ),
      ).toEqual([
        { region_id: R1, point_count: 11 },
        { region_id: R2, point_count: 99 },
      ]);
    });
  });

  it("takes the old entry's cover and crop when the survivor has none", async () => {
    await scenario(async (c, merge) => {
      const cap = (
        await c.query(
          `INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, 'fold-cover') RETURNING id`,
          [U1, OLD_X],
        )
      ).rows[0].id;
      const ph = (
        await c.query(
          `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/d', '/t') RETURNING id`,
          [cap],
        )
      ).rows[0].id;
      await c.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, card_crop_x, card_crop_y, card_crop_size) VALUES
           ($1, $2, 'collected', $4, 10, 20, 50), ($1, $3, 'seen', NULL, NULL, NULL, NULL)`,
        [U1, OLD_X, SURV, ph],
      );
      await merge();
      expect(
        await rows(
          c,
          `SELECT state, cover_photo_id, card_crop_x::int AS x, card_crop_y::int AS y, card_crop_size::int AS s FROM user_species WHERE user_id = $1`,
          [U1],
        ),
      ).toEqual([{ state: "collected", cover_photo_id: ph, x: 10, y: 20, s: 50 }]);
    });
  });

  it("can run twice in one transaction, picking up a merge added in between", async () => {
    await scenario(async (c, merge) => {
      expect((await merge()).merged).toBe(1);
      await c.query(
        `INSERT INTO species_merges (old_species_id, new_species_id, old_scientific_name) VALUES ($1, $2, 'Zzfolda antiqua')`,
        [OLD_Y, SURV],
      );
      expect((await merge()).merged).toBe(1);
      expect(await rows(c, `SELECT id FROM species WHERE id = ANY($1)`, [[OLD_X, OLD_Y]])).toEqual([]);
    });
  });
});
