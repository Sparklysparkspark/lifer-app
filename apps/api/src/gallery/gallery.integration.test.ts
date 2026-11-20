// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run gallery.integration
// Keyset pages of GET /gallery must add up to exactly the unpaged list, in every sort order, and
// /gallery/search must honor the same filters.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000211";
const SPECIES = "ffffffff-0000-4000-8000-0000000002a1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "gallery@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});
// Shot types come from CLIP vectors; the test picks each capture's reading, matched as the app does.
const shots = vi.hoisted(() => ({ types: new Map<string, { action: string; framing: string }>() }));
vi.mock("../stats/shotKinds.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../stats/shotKinds.js")>();
  return {
    ...real,
    captureIdsOfShotTypes: async (_userId: string, actions: never[], framings: never[]) =>
      real.matchShotTypes(shots.types as never, actions, framings),
  };
});

describe.skipIf(!url)("GET /gallery keyset pages", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  const get = async (path: string) => {
    const res = await app.inject({ method: "GET", url: `/api${path}` });
    return { status: res.statusCode, body: res.json() };
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'gallery@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 912101, 'Galleria pagina', 'Paging Warbler', 'aves')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES],
    );
    // Ties on taken_at and rating, NULL dates and ratings, so every tiebreak is exercised.
    const takenAt = [
      "2024-05-01T10:00:00Z",
      "2024-05-01T10:00:00Z",
      null,
      "2023-01-01T00:00:00Z",
      null,
      "2025-07-04T08:30:00.123456Z",
    ];
    const ratings = [5, null, 3, 1, 5, null];
    for (let i = 0; i < 18; i++) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating, created_at, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
          USER,
          SPECIES,
          `gallery-page-${i}`,
          takenAt[i % 6],
          ratings[i % 5],
          new Date(Date.UTC(2026, 0, 1 + (i % 4))).toISOString(),
          i % 3 === 0 ? ["pagetag"] : [],
        ],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    }
    const { galleryRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(galleryRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  type Item = { captureId: string; scientificName: string; takenAt: string | null };
  /** The full list in `sort`, checked to equal its keyset pages of several sizes. */
  async function pagesAddUp(sort: string, count: number): Promise<Item[]> {
    const full = await get(`/gallery?sort=${sort}`);
    expect(full.status).toBe(200);
    // No limit means the largest page, which holds them all here.
    expect(full.body.nextCursor).toBeNull();
    const all = full.body.items.map((i: Item) => i.captureId);
    expect(all).toHaveLength(count);
    for (const limit of [1, 4, 7]) {
      const paged: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 50; guard++) {
        const page = await get(`/gallery?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
        expect(page.status).toBe(200);
        expect(page.body.items.length).toBeLessThanOrEqual(limit);
        paged.push(...page.body.items.map((i: Item) => i.captureId));
        cursor = page.body.nextCursor;
        if (!cursor) break;
      }
      expect(paged).toEqual(all);
    }
    return full.body.items;
  }

  for (const sort of ["newest", "oldest", "ratingHigh", "ratingLow", "taxonomic", "name", "scientific", "rarity"]) {
    it(`pages add up to the full list (${sort})`, async () => {
      await pagesAddUp(sort, 18);
    });
  }

  it("orders by the Collection's species orders, newest first within a species, across pages", async () => {
    const OWL = "ffffffff-0000-4000-8000-0000000002a2";
    const MOOSE = "ffffffff-0000-4000-8000-0000000002a3";
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class, taxon_order, family) VALUES
         ($1, 912102, 'Strix secunda', 'Second Owl', 'aves', 'Strigiformes', 'Strigidae'),
         ($2, 912103, 'Alces tertius', NULL, 'mammalia', 'Artiodactyla', 'Cervidae')
       ON CONFLICT (id) DO NOTHING`,
      [OWL, MOOSE],
    );
    await db.query(`UPDATE species SET taxon_order = 'Passeriformes', family = 'Parulidae' WHERE id = $1`, [SPECIES]);
    await db.query(
      `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier)
       VALUES ($1, 0, 0, 0, 'common'), ($2, 0, 0, 0, 'rare'), ($3, 0, 0, 0, 'legendary')
       ON CONFLICT (species_id) DO UPDATE SET tier = EXCLUDED.tier`,
      [SPECIES, OWL, MOOSE],
    );
    for (const [i, species] of [OWL, OWL, OWL, MOOSE, MOOSE, MOOSE].entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at) VALUES ($1, $2, $3, $4) RETURNING id`,
        [USER, species, `gallery-sort-${i}`, [null, "2021-03-01T00:00:00Z", "2022-03-01T00:00:00Z"][i % 3]],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
    }
    try {
      const runs = (items: Item[]) => items.map((i) => i.scientificName).filter((n, k, a) => n !== a[k - 1]);
      const expected: Record<string, string[]> = {
        // Birds before mammals; owls before songbirds in the Clements sequence.
        taxonomic: ["Strix secunda", "Galleria pagina", "Alces tertius"],
        // The common name, or the scientific one where there's none.
        name: ["Alces tertius", "Galleria pagina", "Strix secunda"],
        scientific: ["Alces tertius", "Galleria pagina", "Strix secunda"],
        rarity: ["Alces tertius", "Strix secunda", "Galleria pagina"],
      };
      for (const [sort, order] of Object.entries(expected)) {
        const items = await pagesAddUp(sort, 24);
        // Each species once, in one run.
        expect(runs(items)).toEqual(order);
        for (const name of order) {
          const dates = items.filter((i) => i.scientificName === name).map((i) => i.takenAt);
          const dated = dates.filter((d): d is string => d !== null);
          expect(dated).toEqual([...dated].sort().reverse());
          expect(dates.slice(dated.length).every((d) => d === null)).toBe(true);
        }
      }
    } finally {
      await db.query(`DELETE FROM captures_all WHERE user_id = $1 AND fingerprint LIKE 'gallery-sort-%'`, [USER]);
      await db.query(`DELETE FROM species_rarity WHERE species_id = ANY($1)`, [[SPECIES, OWL, MOOSE]]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[OWL, MOOSE]]);
      (await import("./routes.js")).clearGallerySearchCaches();
    }
  });

  it("applies filters to pages too", async () => {
    const full = await get(`/gallery?tag=pagetag`);
    const page = await get(`/gallery?tag=pagetag&limit=500`);
    expect(page.body.items.map((i: { captureId: string }) => i.captureId)).toEqual(
      full.body.items.map((i: { captureId: string }) => i.captureId),
    );
    expect(page.body.nextCursor).toBeNull();
    expect(full.body.items).toHaveLength(6);
    // total comes with the first page only, counted with the same filters.
    const first = await get(`/gallery?tag=pagetag&limit=2`);
    expect(first.body.total).toBe(6);
    expect(full.body.total).toBe(6);
    const second = await get(`/gallery?tag=pagetag&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.total).toBeUndefined();
    expect((await get(`/gallery?tag=pagetag&limit=9999`)).body.items).toHaveLength(6);
  });

  it("filters by a star rating range, or unrated on its own", async () => {
    const count = async (qs: string) => (await get(`/gallery?${qs}`)).body.items.length;
    // Seeded: seven 5-star, four 3-star, three 1-star and four unrated photos.
    expect(await count("ratingMin=5")).toBe(7);
    expect(await count("onlyTopRated=1")).toBe(7);
    expect(await count("ratingMin=2&ratingMax=4")).toBe(4);
    expect(await count("ratingMax=3")).toBe(7);
    expect(await count("unrated=1")).toBe(4);
    expect((await get(`/gallery?ratingMin=4&ratingMax=2`)).status).toBe(400);
    expect((await get(`/gallery?unrated=1&ratingMin=3`)).status).toBe(400);
    expect((await get(`/gallery?ratingMin=6`)).status).toBe(400);
  });

  it("filters by the number of animals, leaving the photo's edit time alone", async () => {
    const before = await db.query(`SELECT max(updated_at) AS t FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`UPDATE captures_all SET subject_count = quality_rating WHERE user_id = $1`, [USER]);
    try {
      const count = async (qs: string) => (await get(`/gallery?${qs}`)).body.items.length;
      expect(await count("animalsMin=3")).toBe(11);
      expect(await count("animalsMin=3&animalsMax=3")).toBe(4);
      expect((await get(`/gallery?animalsMin=4&animalsMax=2`)).status).toBe(400);
      expect((await get(`/gallery?animalsMin=0`)).status).toBe(400);
      const after = await db.query(`SELECT max(updated_at) AS t FROM captures_all WHERE user_id = $1`, [USER]);
      expect(after.rows[0].t).toEqual(before.rows[0].t);
    } finally {
      await db.query(`UPDATE captures_all SET subject_count = NULL WHERE user_id = $1`, [USER]);
    }
  });

  it("filters by exact place name", async () => {
    await db.query(
      `UPDATE captures_all SET location_label = CASE fingerprint WHEN 'gallery-page-4' THEN 'Pigeon Lake' ELSE 'Pigeon Lake East' END
        WHERE user_id = $1 AND fingerprint IN ('gallery-page-4', 'gallery-page-5')`,
      [USER],
    );
    try {
      const res = await get(`/gallery?place=${encodeURIComponent(" Pigeon Lake ")}`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.total).toBe(1);
    } finally {
      await db.query(`UPDATE captures_all SET location_label = NULL WHERE user_id = $1`, [USER]);
    }
  });

  it("takes several values per filter: any one of a filter's values, and all filters together", async () => {
    // A region with no parent is a root, which also matches photos with no region.
    const root = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Multi Root') RETURNING id`))
      .rows[0].id;
    const [bc, ab, yukon] = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id) VALUES ('Multi BC', $1), ('Multi Alberta', $1), ('Multi Yukon', $1) RETURNING id`,
        [root],
      )
    ).rows.map((r) => r.id);
    const fps = ["gallery-page-0", "gallery-page-1", "gallery-page-2", "gallery-page-3", "gallery-page-4"];
    const setup: Array<[string | null, number, string, string]> = [
      [bc, 5, "owl", "Lake A"],
      [ab, 3, "hawk", "Lake B"],
      [yukon, 5, "owl", "Lake C"],
      [null, 4, "hawk", "Lake A"],
      [bc, 2, "hawk", "Lake D"],
    ];
    const trip = (
      await db.query<{ id: string }>(
        `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Multi trip', '/x', '/y') RETURNING id`,
        [USER],
      )
    ).rows[0].id;
    try {
      for (const [i, [region, rating, tag, place]] of setup.entries())
        await db.query(
          `UPDATE captures_all SET region_id = $1, quality_rating = $2, tags = ARRAY[$3]::text[], location_label = $4,
                  trip_id = CASE WHEN $6 IN (0, 1) THEN $7::uuid END
            WHERE user_id = $8 AND fingerprint = $5`,
          [region, rating, tag, place, fps[i], i, trip, USER],
        );
      const count = async (qs: string) => {
        const res = await get(`/gallery?${qs}`);
        expect(res.status).toBe(200);
        return res.body.total as number;
      };
      const mine = "tag=owl&tag=hawk";
      expect(await count(`${mine}&regionId=${bc}`)).toBe(2);
      // OR within a filter: BC or Alberta.
      expect(await count(`${mine}&regionId=${bc}&regionId=${ab}`)).toBe(3);
      expect(await count(`${mine}&regionId=${bc}&regionId=uncategorized`)).toBe(3);
      // AND across filters: BC or Alberta, and 3 to 5 stars.
      expect(await count(`${mine}&regionId=${bc}&regionId=${ab}&ratingMin=3&ratingMax=5`)).toBe(2);
      expect(await count("tag=owl&tag=nothing")).toBe(2);
      expect(await count(`${mine}&place=Lake%20A&place=Lake%20D`)).toBe(3);
      expect(await count(`tripId=${trip}&tripId=${trip}`)).toBe(2);
      // A single value works as before, and a repeated one counts once.
      expect(await count(`regionId=${bc}&regionId=${bc}`)).toBe(2);
      const search = await get(`/gallery/search?q=paging%20warbler&quick=1&regionId=${bc}&regionId=${ab}`);
      expect(search.body.items).toHaveLength(3);
      expect((await get(`/gallery/ids?regionId=${bc}&regionId=${ab}`)).body.captureIds).toHaveLength(3);
    } finally {
      // Back to what the seed gave them.
      for (const [i, fp] of fps.entries())
        await db.query(
          `UPDATE captures_all SET region_id = NULL, quality_rating = $3, tags = $4, location_label = NULL, trip_id = NULL
            WHERE user_id = $1 AND fingerprint = $2`,
          [USER, fp, [5, null, 3, 1, 5][i], i % 3 === 0 ? ["pagetag"] : []],
        );
      await db.query(`DELETE FROM trips WHERE id = $1`, [trip]);
      await db.query(`DELETE FROM regions WHERE name LIKE 'Multi %' AND parent_id IS NOT NULL`);
      await db.query(`DELETE FROM regions WHERE name = 'Multi Root'`);
    }
  });

  it("filters RAW-only photos and edited photos with a RAW separately", async () => {
    const ids = (
      await db.query<{ id: string; fingerprint: string }>(
        `SELECT id, fingerprint FROM captures_all WHERE user_id = $1 AND fingerprint = ANY($2)`,
        [USER, ["gallery-page-0", "gallery-page-1", "gallery-page-2"]],
      )
    ).rows.reduce<Record<string, string>>((out, r) => ({ ...out, [r.fingerprint]: r.id }), {});
    const [edited, editedWithRaw, rawOnly] = [ids["gallery-page-0"], ids["gallery-page-1"], ids["gallery-page-2"]];
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size) VALUES
         ($1, 'jpeg', 'path', '/nowhere/a.jpg', true, $4, 'g-a', 1),
         ($2, 'jpeg', 'path', '/nowhere/b.jpg', true, $4, 'g-b', 1),
         ($2, 'raw', 'path', '/nowhere/b.cr3', true, $4, 'g-b-raw', 1),
         ($3, 'raw', 'path', '/nowhere/c.cr3', true, $4, 'g-c-raw', 1)`,
      [edited, editedWithRaw, rawOnly, USER],
    );
    try {
      const listed = async (query: string) =>
        new Set((await get(`/gallery?${query}`)).body.items.map((i: { captureId: string }) => i.captureId));
      // RAW files: only, hidden.
      expect([...(await listed("onlyRaw=1"))]).toEqual([rawOnly]);
      const hidden = await listed("includeRaw=0");
      expect([hidden.has(rawOnly), hidden.has(editedWithRaw), hidden.size]).toEqual([false, true, 17]);
      // Edited photos with or without their RAW; a RAW-only photo passes both.
      const withRaw = await listed("onlyHasRaw=1");
      expect([withRaw.has(editedWithRaw), withRaw.has(rawOnly), withRaw.has(edited)]).toEqual([true, true, false]);
      const withoutRaw = await listed("excludeHasRaw=1");
      expect([withoutRaw.has(editedWithRaw), withoutRaw.has(rawOnly), withoutRaw.has(edited)]).toEqual([
        false,
        true,
        true,
      ]);
    } finally {
      await db.query(`DELETE FROM originals WHERE capture_id = ANY($1)`, [[edited, editedWithRaw, rawOnly]]);
    }
  });

  it("refuses bad ids, dates, limits and cursors with a 400", async () => {
    expect((await get(`/gallery?regionId=nope`)).status).toBe(400);
    expect((await get(`/gallery?dateFrom=yesterday`)).status).toBe(400);
    expect((await get(`/gallery?limit=0`)).status).toBe(400);
    expect((await get(`/gallery?limit=abc`)).status).toBe(400);
    expect((await get(`/gallery?limit=5&cursor=garbage`)).status).toBe(400);
    const first = await get(`/gallery?sort=oldest&limit=2`);
    expect((await get(`/gallery?sort=newest&limit=2&cursor=${first.body.nextCursor}`)).status).toBe(400);
    expect((await get(`/gallery/search?q=warbler&regionId=nope`)).status).toBe(400);
    expect((await get(`/gallery?regionId=uncategorized`)).status).toBe(200);
  });

  it("checks the query against its schema, keeping lenient values clients send", async () => {
    const invalid = (status: number, body: { error: string; code?: string }, pattern: RegExp) => {
      expect(status).toBe(400);
      expect(body.code).toBe("invalid_request");
      expect(body.error).toMatch(pattern);
    };
    const badTrip = await get(`/gallery?tripId=nope`);
    invalid(badTrip.status, badTrip.body, /^Invalid query: tripId\.0 must be an id/);
    const badAlbum = await get(`/gallery/ids?albumId=123`);
    invalid(badAlbum.status, badAlbum.body, /^Invalid query: albumId\.0 must be an id/);
    const badFlag = await get(`/gallery?onlyVideo=yes`);
    invalid(badFlag.status, badFlag.body, /^Invalid query: onlyVideo must be one of 0, 1$/);
    const badQuick = await get(`/gallery/search?q=warbler&quick=true`);
    invalid(badQuick.status, badQuick.body, /^Invalid query: quick /);
    const negative = await get(`/gallery?limit=-1`);
    invalid(negative.status, negative.body, /^Invalid query: limit must be >= 1$/);
    const word = await get(`/gallery?limit=ten`);
    invalid(word.status, word.body, /^Invalid query: limit must be integer$/);
    const badDate = await get(`/gallery/ids?dateTo=05/01/2024`);
    invalid(badDate.status, badDate.body, /^Invalid query: dateTo /);

    // Empty values mean "not given", a larger limit is capped rather than refused, an unknown
    // sort (a stale one the browser remembered) is the default, and "0" leaves a flag off.
    const lenient = await get(`/gallery?regionId=&tripId=&limit=100000&sort=bogus&onlyVideo=0`);
    expect(lenient.status).toBe(200);
    expect(lenient.body.items).toHaveLength(18);
    expect(lenient.body.total).toBe(18);
    const ids = await get(`/gallery/ids?missingDate=1`);
    expect(ids.status).toBe(200);
    expect(Object.keys(ids.body).sort()).toEqual(["captureIds", "locatedCaptureIds", "rawCaptureIds", "videoCaptureIds"]);
    expect(ids.body.captureIds.length).toBeGreaterThan(0);
  });

  it("lists the originals of every matching photo when asked, for downloading them", async () => {
    const page = await get(`/gallery?limit=1`);
    const { captureId, photoId } = page.body.items[0];
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
       VALUES ($1, 'raw', 'path', '/nowhere/o.cr3', true, 'gallery-ids-original', 1)`,
      [captureId],
    );
    try {
      const ids = await get(`/gallery/ids?originals=true`);
      expect(ids.body.originals).toEqual([{ captureId, photoId, kind: "raw" }]);
    } finally {
      await db.query(`DELETE FROM originals WHERE capture_id = $1`, [captureId]);
    }
  });

  it("keeps every item field through the response schema", async () => {
    const page = await get(`/gallery?limit=1`);
    expect(Object.keys(page.body.items[0])).toEqual(
      expect.arrayContaining(["photoId", "captureId", "scientificName", "takenAt", "tags", "isFeatured", "matchScore"]),
    );
    expect(page.body.items[0].scientificName).toBe("Galleria pagina");
    const search = await get(`/gallery/search?q=paging%20warbler&quick=1`);
    expect(search.body.items[0].commonName).toBe("Paging Warbler");
    expect(search.body).toHaveProperty("interpretation");
  });

  it("returns each photo's taxonomy and tiers, the local one only with a region filter", async () => {
    const region = (
      await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ('Gallery Tierland') RETURNING id`)
    ).rows[0].id;
    try {
      await db.query(`UPDATE species SET taxon_order = 'Passeriformes', family = 'Parulidae' WHERE id = $1`, [SPECIES]);
      await db.query(
        `INSERT INTO species_rarity (species_id, range_score, abundance_score, composite, tier) VALUES ($1, 0, 0, 0, 'rare')
         ON CONFLICT (species_id) DO UPDATE SET tier = 'rare'`,
        [SPECIES],
      );
      await db.query(`INSERT INTO region_species (region_id, species_id, local_tier) VALUES ($1, $2, 'common')`, [
        region,
        SPECIES,
      ]);
      await db.query(`UPDATE captures_all SET region_id = $1 WHERE user_id = $2`, [region, USER]);
      const plain = (await get(`/gallery?limit=1`)).body.items[0];
      expect(plain).toMatchObject({
        taxonOrder: "Passeriformes",
        family: "Parulidae",
        isOtherTaxa: false,
        tier: "rare",
        localTier: null,
      });
      expect((await get(`/gallery?limit=1&regionId=${region}`)).body.items[0].localTier).toBe("common");
      const search = await get(`/gallery/search?q=paging%20warbler&quick=1&regionId=${region}`);
      expect(search.body.items[0]).toMatchObject({ tier: "rare", localTier: "common" });
    } finally {
      await db.query(`UPDATE captures_all SET region_id = NULL WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM species_rarity WHERE species_id = $1`, [SPECIES]);
      await db.query(`DELETE FROM regions WHERE id = $1`, [region]);
      (await import("./routes.js")).clearGallerySearchCaches();
    }
  });

  it("applies tag and missingDate to search", async () => {
    const all = await get(`/gallery/search?q=paging%20warbler`);
    expect(all.body.items).toHaveLength(18);
    const tagged = await get(`/gallery/search?q=paging%20warbler&tag=pagetag`);
    expect(tagged.body.items).toHaveLength(6);
    const undated = await get(`/gallery/search?q=paging%20warbler&missingDate=1&quick=1`);
    expect(undated.body.items.length).toBeGreaterThan(0);
    expect(undated.body.items.every((i: { takenAt: unknown }) => i.takenAt === null)).toBe(true);
  });

  it("filters by shot type: OR within action or framing, AND across them, old shotKind included", async () => {
    const ids = (
      await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE user_id = $1 ORDER BY fingerprint`, [USER])
    ).rows.map((r) => r.id);
    // 0-3 flying environmental, 4-7 behaviour close, the rest at rest and close.
    shots.types = new Map(
      ids.map((id, i) => [
        id,
        i < 4
          ? { action: "flying", framing: "environmental" }
          : i < 8
            ? { action: "behavior", framing: "close" }
            : { action: "resting", framing: "close" },
      ]),
    );
    try {
      const ofIds = (r: { body: { items: Array<{ captureId: string }> } }) =>
        r.body.items.map((i) => i.captureId).sort();
      const listed = async (qs: string) => ofIds(await get(`/gallery?${qs}`));
      const sorted = (list: string[]) => list.slice().sort();
      expect(await listed("action=flying")).toEqual(sorted(ids.slice(0, 4)));
      expect(await listed("action=flying,behavior")).toEqual(sorted(ids.slice(0, 8)));
      expect(await listed("action=flying,behavior&framing=close")).toEqual(sorted(ids.slice(4, 8)));
      expect(await listed("action=flying&framing=close")).toEqual([]);
      // The older single shotKind reads as the axis it stands for.
      expect(await listed("shotKind=flight")).toEqual(await listed("action=flying"));
      expect(await listed("shotKind=behavior")).toEqual(await listed("action=behavior"));
      expect(await listed("shotKind=portrait")).toEqual(sorted(ids.slice(4)));
      expect(await listed("shotKind=environmental")).toEqual(sorted(ids.slice(0, 4)));
      expect((await get(`/gallery?action=sleeping`)).status).toBe(400);
      expect((await get(`/gallery?framing=close,`)).status).toBe(400);

      // A search narrows within the filter, and its shot words narrow it too.
      expect(ofIds(await get(`/gallery/search?q=paging%20warbler&framing=close&quick=1`))).toEqual(
        sorted(ids.slice(4)),
      );
      const typed = await get(`/gallery/search?q=paging%20warbler%20environmental%20flight&quick=1`);
      expect(ofIds(typed)).toEqual(sorted(ids.slice(0, 4)));
      expect(typed.body.interpretation.readings).toEqual(["environmental", "flying"]);
      expect(ofIds(await get(`/gallery/search?q=paging%20warbler%20close%20up&action=behavior&quick=1`))).toEqual(
        sorted(ids.slice(4, 8)),
      );
      // Typed words never widen a filter: flying isn't among the close-up photos.
      expect((await get(`/gallery/search?q=paging%20warbler%20flight&framing=close&quick=1`)).body.items).toEqual([]);
      expect((await get(`/gallery/search?q=paging%20warbler%20flight&action=behavior&quick=1`)).body.items).toEqual([]);
      expect((await get(`/gallery/search?q=paging%20warbler&quick=1`)).body.items).toHaveLength(18);
    } finally {
      shots.types = new Map();
    }
  });

  it("finds scene and colour words from the scene model", async () => {
    const { SCENE_MODEL_VERSION } = await import("@lifer/core/config.js");
    const ids = (
      await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE user_id = $1 ORDER BY fingerprint`, [USER])
    ).rows.map((r) => r.id);
    const scene = (i: number) =>
      i === 0 ? { water: 10, grass: 50 } : i === 1 ? { lake: 30, sky: 20 } : { grass: 80, water: 1 };
    for (const [i, id] of ids.entries()) {
      await db.query(
        `INSERT INTO capture_scenes (capture_id, photo_id, model_version, labels, colors)
         SELECT id, current_photo_id, $2, $3, $4 FROM captures_all WHERE id = $1`,
        [id, SCENE_MODEL_VERSION, scene(i), i === 2 ? { purple: 12 } : { green: 60 }],
      );
    }
    (await import("./routes.js")).clearGallerySearchCaches();
    const water = await get(`/gallery/search?q=water`);
    expect(water.body.items.map((i: { captureId: string }) => i.captureId)).toEqual([ids[1], ids[0]]);
    expect(water.body.interpretation.scenes).toEqual(["water"]);
    const purple = await get(`/gallery/search?q=paging%20warbler%20purp`);
    expect(purple.body.items.map((i: { captureId: string }) => i.captureId)).toEqual([ids[2]]);
    expect((await get(`/gallery/search?q=snow`)).body.items).toEqual([]);
  });

  it("finds a trip or an album by name", async () => {
    const ids = (
      await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE user_id = $1 ORDER BY fingerprint LIMIT 5`, [
        USER,
      ])
    ).rows.map((r) => r.id);
    const trip = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Costa Rica 2024', '/x', '/x/Wildlife') RETURNING id`,
      [USER],
    );
    await db.query(`UPDATE captures_all SET trip_id = $1 WHERE id = ANY($2)`, [trip.rows[0].id, ids.slice(0, 3)]);
    const album = await db.query<{ id: string }>(
      `INSERT INTO albums (user_id, name) VALUES ($1, 'Best Warblers Ever') RETURNING id`,
      [USER],
    );
    await db.query(`INSERT INTO album_captures (album_id, capture_id) SELECT $1, unnest($2::uuid[])`, [
      album.rows[0].id,
      ids.slice(3, 5),
    ]);

    // The library stamp is reused for a few seconds; a real user rarely searches that fast.
    (await import("./routes.js")).clearGallerySearchCaches();
    const byTrip = await get(`/gallery/search?q=costa%20rica%20trip`);
    expect(byTrip.body.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual(ids.slice(0, 3).sort());
    const byAlbum = await get(`/gallery/search?q=best%20warblers%20ever`);
    expect(byAlbum.body.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual(ids.slice(3, 5).sort());

    // tripId / albumId narrow both the listing and a search to that trip or album.
    const ofIds = (r: { body: { items: Array<{ captureId: string }> } }) => r.body.items.map((i) => i.captureId).sort();
    expect(ofIds(await get(`/gallery?tripId=${trip.rows[0].id}`))).toEqual(ids.slice(0, 3).sort());
    expect(ofIds(await get(`/gallery?albumId=${album.rows[0].id}`))).toEqual(ids.slice(3, 5).sort());
    expect((await get(`/gallery?albumId=${album.rows[0].id}&limit=1`)).body.total).toBe(2);
    expect(ofIds(await get(`/gallery/search?q=paging%20warbler&quick=1&tripId=${trip.rows[0].id}`))).toEqual(
      ids.slice(0, 3).sort(),
    );
    expect(ofIds(await get(`/gallery/search?q=paging%20warbler&quick=1&albumId=${album.rows[0].id}`))).toEqual(
      ids.slice(3, 5).sort(),
    );
    expect((await get(`/gallery?tripId=nope`)).status).toBe(400);
    expect((await get(`/gallery/search?q=warbler&albumId=nope`)).status).toBe(400);

    // Album and trip pages filter through /gallery/ids, so the Gallery's filters hold inside each.
    const rated = async (scopeIds: string[], where: string) =>
      (await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE id = ANY($1) AND ${where}`, [scopeIds])).rows
        .map((r) => r.id)
        .sort();
    const idsOf = async (path: string) => ((await get(path)).body.captureIds as string[]).sort();
    expect(await idsOf(`/gallery/ids?tripId=${trip.rows[0].id}&unrated=1`)).toEqual(
      await rated(ids.slice(0, 3), "quality_rating IS NULL"),
    );
    expect(await idsOf(`/gallery/ids?albumId=${album.rows[0].id}&ratingMin=3&ratingMax=5`)).toEqual(
      await rated(ids.slice(3, 5), "quality_rating BETWEEN 3 AND 5"),
    );
    expect(await idsOf(`/gallery/ids?albumId=${album.rows[0].id}&taxa=aves`)).toEqual(ids.slice(3, 5).sort());
    expect(await idsOf(`/gallery/ids?tripId=${trip.rows[0].id}&taxa=mammalia`)).toEqual([]);
  });

  it("reads filter words, lifers, endemics and cameras in a search", async () => {
    const { clearGallerySearchCaches } = await import("./routes.js");
    const search = async (q: string) => {
      clearGallerySearchCaches();
      return (await get(`/gallery/search?q=${encodeURIComponent(q)}&quick=1`)).body;
    };
    const ids = (
      await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE user_id = $1 ORDER BY fingerprint`, [USER])
    ).rows.map((r) => r.id);
    try {
      // Seeded: seven 5-star and four unrated photos, six with no date, three from 2023-01-01.
      expect((await search("5 stars")).items).toHaveLength(7);
      expect((await search("paging warbler 4+ stars")).interpretation.stars).toEqual({ min: 4, max: null });
      expect((await search("unrated")).items).toHaveLength(4);
      expect((await search("no date")).items).toHaveLength(6);
      // A word only narrows what the filters already check.
      clearGallerySearchCaches();
      expect((await get(`/gallery/search?q=unrated&quick=1&ratingMin=5`)).body.items).toHaveLength(0);

      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, first_collected) VALUES ($1, $2, 'collected', '2023-01-01T00:00:00Z')`,
        [USER, SPECIES],
      );
      const lifers = await search("lifers");
      expect(lifers.items).toHaveLength(3);
      expect(lifers.interpretation.readings).toEqual(["lifers"]);

      await db.query(
        `INSERT INTO species_traits (species_id, source_attribution, endemic_country_iso3) VALUES ($1, 'test', 'CRI')`,
        [SPECIES],
      );
      expect((await search("endemics")).items).toHaveLength(18);

      await db.query(`UPDATE captures_all SET camera_model = 'Canon EOS R5m2' WHERE id = ANY($1)`, [ids.slice(0, 2)]);
      const r5 = await search("r5");
      expect(r5.items.map((i: { captureId: string }) => i.captureId).sort()).toEqual(ids.slice(0, 2).sort());
      expect(r5.interpretation.cameras).toEqual(["Canon EOS R5m2"]);

      await db.query(`UPDATE captures_all SET hidden_at = now() WHERE id = $1`, [ids[0]]);
      expect((await search("hidden")).items.map((i: { captureId: string }) => i.captureId)).toEqual([ids[0]]);
    } finally {
      await db.query(`UPDATE captures_all SET camera_model = NULL, hidden_at = NULL WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
      await db.query(`DELETE FROM species_traits WHERE species_id = $1`, [SPECIES]);
      clearGallerySearchCaches();
    }
  });
});
