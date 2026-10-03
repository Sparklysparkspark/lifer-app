// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run collectionQuery
// GET /collection and /collection/count across pack unlocks, archiving, obscurity and seen states.

import Fastify from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Before any import below loads db.ts, so the app's own pool uses the test database too.
vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

import {
  obscureSpeciesSql,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  SPECIES_UNLOCKED_SQL,
} from "../species/obscurity.js";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000111";
const COUNTRY = "ffffffff-0000-4000-8000-0000000001c1";
const PROVINCE = "ffffffff-0000-4000-8000-0000000001c2";
const SP = Array.from({ length: 7 }, (_, i) => `ffffffff-0000-4000-8000-00000000011${i}`);
const PACK = "zz-collection-query-test";
const MAMMAL_PACK = "zz-collection-query-test-mammals";
const MAMMAL_COUNTRY = "ffffffff-0000-4000-8000-0000000001c3";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "cq@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const OLD_SQL = (maxDepthM: number) => `SELECT
           s.id AS species_id,
           s.scientific_name,
           s.common_name,
           s.taxon_class,
           s.family,
           s.taxon_order,
           s.reference_photo,
           s.reference_credit,
           s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
           s.reference_focal_x,
           s.reference_focal_y,
           s.is_other_taxa,
           s.inat_iconic_taxon,
           r.tier,
           r.tier_reason,
           uto.tier AS override_tier,
           t.endemic_country_iso3,
           t.endemic_region_label,
           t.occurrence_count,
           t.last_occurrence_year,
           t.depth_min_m,
           us.state,
           us.is_target,
           us.was_ghost_when_collected,
           us.was_lost_when_collected,
           us.cover_photo_id,
           us.card_crop_x,
           us.card_crop_y,
           us.card_crop_size,
           -- A trashed capture doesn't clear cover_photo_id (only purging it does): gating on
           -- cc.id (the trash-excluding captures view, not captures_all) is what stops a
           -- species card from keeping a soft-deleted photo as its cover for the whole trash
           -- retention window.
           (p.thumb_path IS NOT NULL AND cc.id IS NOT NULL) AS has_cover_photo,
           sv.label AS cover_volume_label,
           -- Every distinct calendar year this user has ANY real capture of this species (not
           -- just the first-ever one, which us.first_collected already captures): lets a "big
           -- year" style filter show a species again in a later year even if it was first found
           -- long before. Deliberately from captures, not captures_all: a trashed photo
           -- shouldn't count as "found this year" any more than it counts as a cover photo above.
           (SELECT array_agg(DISTINCT EXTRACT(YEAR FROM cy.taken_at)::int)
              FROM captures cy WHERE cy.user_id = $1 AND cy.species_id = s.id AND cy.taken_at IS NOT NULL) AS captured_years
         FROM species s
         LEFT JOIN species_rarity r ON r.species_id = s.id
         LEFT JOIN user_tier_overrides uto ON uto.user_id = $1 AND uto.species_id = s.id AND uto.region_id IS NULL
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
         LEFT JOIN photos p ON p.id = us.cover_photo_id
         LEFT JOIN captures cc ON cc.id = p.capture_id
         LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
         LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
         LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
         WHERE (($2::text[] IS NULL) OR ($2 @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY($2)) AND COALESCE(t.fully_extinct, false) = false
           AND ($3 = false OR ${ALREADY_OWNED_SQL} OR NOT ${obscureSpeciesSql(maxDepthM)})
           AND ${NOT_ARCHIVED_SQL}
           AND (${ALREADY_OWNED_SQL} OR ${SPECIES_UNLOCKED_SQL})
         ORDER BY s.sort_order NULLS LAST, s.scientific_name`;

const OLD_COUNT_SQL = (maxDepthM: number) => `SELECT
     count(*) AS total,
     count(*) FILTER (WHERE us.state = 'collected') AS collected,
     count(*) FILTER (WHERE us.state = 'seen') AS seen
   FROM species s
   LEFT JOIN species_traits t ON t.species_id = s.id
   LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
   LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
   WHERE (($2::text[] IS NULL) OR ($2 @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY($2)) AND COALESCE(t.fully_extinct, false) = false
     AND ($3 = false OR ${ALREADY_OWNED_SQL} OR NOT ${obscureSpeciesSql(maxDepthM)})
     AND ${NOT_ARCHIVED_SQL}
     AND (${ALREADY_OWNED_SQL} OR ${SPECIES_UNLOCKED_SQL})`;

describe.skipIf(!url)("collection query rewrite", () => {
  let db: pg.Pool;

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = ANY($1)`, [[PACK, MAMMAL_PACK]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, COUNTRY, MAMMAL_COUNTRY]]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'cq@test', 'x')`, [USER]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzland Query Test', '{ZZQ}')`, [COUNTRY]);
    await db.query(`INSERT INTO regions (id, name, parent_id, external_codes) VALUES ($1, 'Zzland Province', $2, '{ZZQ.1}')`, [PROVINCE, COUNTRY]);
    // 0 unlocked bird, 1 bird in a mammal-only pack (locked), 2 other taxa, 3 collected but
    // locked, 4 archived, 5 obscure, 6 seen via eBird
    const classes = ["aves", "aves", "insecta", "aves", "aves", "aves", "aves"];
    for (const [i, id] of SP.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, is_other_taxa, reference_photo, reference_credit, reference_license, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6, 'http://x/y.jpg', 'Test', 'cc0', $7)`,
        [id, 912000 + i, `Queryus species${i}`, `Query Bird ${i}`, classes[i], i === 2, 900000 + i],
      );
    }
    await db.query(`INSERT INTO species_traits (species_id, occurrence_count, source_attribution) VALUES ($1, 5, 'test')`, [SP[5]]);
    for (const i of [0, 4, 5, 6]) {
      await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [PROVINCE, SP[i]]);
    }
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ($1, 'Zzland Query Test', NULL)`, [PACK]);
    // SP[1] is only on a country whose downloaded pack is mammals-only.
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzmammal Query Test', '{ZZM}')`, [MAMMAL_COUNTRY]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [MAMMAL_COUNTRY, SP[1]]);
    await db.query(`INSERT INTO downloaded_packs (pack_id, region, taxon) VALUES ($1, 'Zzmammal Query Test', 'mammalia')`, [MAMMAL_PACK]);
    await db.query(`INSERT INTO user_archived_species (user_id, species_id) VALUES ($1, $2)`, [USER, SP[4]]);
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected'), ($1, $3, 'collected'), ($1, $4, 'seen')`, [
      USER,
      SP[0],
      SP[3],
      SP[6],
    ]);
    const takenAt = [
      [SP[0], "2019-05-01T10:00:00Z", null],
      [SP[0], "2021-06-01T10:00:00Z", null],
      [SP[0], "2021-07-01T10:00:00Z", null],
      [SP[0], "2015-01-01T10:00:00Z", "2024-01-01T00:00:00Z"],
      [SP[3], "2020-03-01T10:00:00Z", null],
      [SP[3], null, null],
    ];
    for (const [i, [species, at, deleted]] of takenAt.entries()) {
      await db.query(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, deleted_at) VALUES ($1, $2, $3, $4, $5)`,
        [USER, species, `cq-${i}`, at, deleted],
      );
    }
  });

  afterAll(async () => {
    await cleanup();
    await db.end();
    const { pool } = await import("../db.js");
    await pool.end();
  });

  const combos: Array<[string[] | null, boolean, number]> = [
    [null, true, 60],
    [null, false, 60],
    [["aves"], true, 120],
    [["other-taxa"], false, 60],
    [["aves", "insecta"], true, 60],
  ];

  it("GET /collection rows match the old query", async () => {
    const { collectionQuerySql } = await import("./routes.js");
    for (const [taxa, hideObscure, maxDepthM] of combos) {
      const [oldRes, newRes] = [
        await db.query(OLD_SQL(maxDepthM), [USER, taxa, hideObscure]),
        await db.query(collectionQuerySql(maxDepthM), [USER, taxa, hideObscure]),
      ];
      expect(newRes.rows.length).toBe(oldRes.rows.length);
      expect(newRes.rows).toEqual(oldRes.rows);
    }
    const res = await db.query(collectionQuerySql(60), [USER, null, true]);
    const byId = new Map(res.rows.map((r) => [r.species_id, r]));
    expect(byId.get(SP[0])?.captured_years).toEqual([2019, 2021]);
    expect(byId.get(SP[3])?.captured_years).toEqual([2020]);
    expect(byId.has(SP[1])).toBe(false);
    expect(byId.has(SP[2])).toBe(true);
    expect(byId.has(SP[4])).toBe(false);
    expect(byId.has(SP[5])).toBe(false);
    expect(byId.get(SP[6])?.state).toBe("seen");
  }, 180_000);

  it("GET /collection/count matches the old query", async () => {
    const { collectionCountSql } = await import("./routes.js");
    for (const [taxa, hideObscure, maxDepthM] of combos) {
      const oldRes = await db.query(OLD_COUNT_SQL(maxDepthM), [USER, taxa, hideObscure]);
      const newRes = await db.query(collectionCountSql(maxDepthM), [USER, taxa, hideObscure]);
      expect(newRes.rows).toEqual(oldRes.rows);
    }
  }, 180_000);

  it("bumps the collection data version on writes", async () => {
    const has = await db.query(`SELECT 1 FROM pg_class WHERE relname = 'collection_data_version'`);
    if (has.rowCount === 0) return;
    const read = async () => Number((await db.query(`SELECT last_value FROM collection_data_version`)).rows[0].last_value);
    const before = await read();
    await db.query(`UPDATE user_species SET is_target = true WHERE user_id = $1 AND species_id = $2`, [USER, SP[0]]);
    expect(await read()).toBeGreaterThan(before);
  });

  it("answers 304 to a matching If-None-Match until something changes", async () => {
    const has = await db.query(`SELECT 1 FROM pg_class WHERE relname = 'collection_data_version'`);
    if (has.rowCount === 0) return;
    const { collectionRoutes } = await import("./routes.js");
    const app = Fastify();
    await app.register(collectionRoutes, { prefix: "/api" });
    await app.ready();
    try {
      for (const path of ["/api/collection/count?taxon=aves", "/api/collection?taxon=insecta"]) {
        // The version counter is database-wide, so other test files writing in parallel can bump
        // it between two requests. Retry until two requests see the same version.
        let etag = "";
        let again = await app.inject({ method: "GET", url: path });
        for (let attempt = 0; attempt < 10; attempt++) {
          const first = await app.inject({ method: "GET", url: path });
          expect(first.statusCode).toBe(200);
          etag = first.headers.etag as string;
          expect(etag).toMatch(/^W\//);
          again = await app.inject({ method: "GET", url: path, headers: { "if-none-match": etag } });
          if (again.statusCode === 304) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        expect(again.statusCode).toBe(304);
        expect(again.body).toBe("");
        await db.query(`UPDATE user_species SET is_target = NOT COALESCE(is_target, false) WHERE user_id = $1 AND species_id = $2`, [USER, SP[3]]);
        const changed = await app.inject({ method: "GET", url: path, headers: { "if-none-match": etag } });
        expect(changed.statusCode).toBe(200);
        expect(changed.headers.etag).not.toBe(etag);
      }
    } finally {
      await app.close();
    }
  }, 180_000);
});
