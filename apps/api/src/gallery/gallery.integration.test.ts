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
    const takenAt = ["2024-05-01T10:00:00Z", "2024-05-01T10:00:00Z", null, "2023-01-01T00:00:00Z", null, "2025-07-04T08:30:00.123456Z"];
    const ratings = [5, null, 3, 1, 5, null];
    for (let i = 0; i < 18; i++) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, quality_rating, created_at, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [USER, SPECIES, `gallery-page-${i}`, takenAt[i % 6], ratings[i % 5], new Date(Date.UTC(2026, 0, 1 + (i % 4))).toISOString(), i % 3 === 0 ? ["pagetag"] : []],
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

  for (const sort of ["newest", "oldest", "ratingHigh", "ratingLow"]) {
    it(`pages add up to the full list (${sort})`, async () => {
      const full = await get(`/gallery?sort=${sort}`);
      expect(full.status).toBe(200);
      expect(full.body.nextCursor).toBeUndefined();
      const all = full.body.items.map((i: { captureId: string }) => i.captureId);
      expect(all).toHaveLength(18);
      for (const limit of [1, 4, 7]) {
        const paged: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 50; guard++) {
          const page = await get(`/gallery?sort=${sort}&limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`);
          expect(page.status).toBe(200);
          expect(page.body.items.length).toBeLessThanOrEqual(limit);
          paged.push(...page.body.items.map((i: { captureId: string }) => i.captureId));
          cursor = page.body.nextCursor;
          if (!cursor) break;
        }
        expect(paged).toEqual(all);
      }
    });
  }

  it("applies filters to pages too", async () => {
    const full = await get(`/gallery?tag=pagetag`);
    const page = await get(`/gallery?tag=pagetag&limit=500`);
    expect(page.body.items.map((i: { captureId: string }) => i.captureId)).toEqual(full.body.items.map((i: { captureId: string }) => i.captureId));
    expect(page.body.nextCursor).toBeNull();
    expect(full.body.items).toHaveLength(6);
    // total comes with the first page only, counted with the same filters.
    const first = await get(`/gallery?tag=pagetag&limit=2`);
    expect(first.body.total).toBe(6);
    expect(full.body.total).toBeUndefined();
    const second = await get(`/gallery?tag=pagetag&limit=2&cursor=${first.body.nextCursor}`);
    expect(second.body.total).toBeUndefined();
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
    invalid(badTrip.status, badTrip.body, /^Invalid query: tripId must be an id/);
    const badAlbum = await get(`/gallery/ids?albumId=123`);
    invalid(badAlbum.status, badAlbum.body, /^Invalid query: albumId must be an id/);
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
    expect(Object.keys(ids.body).sort()).toEqual(["captureIds", "rawCaptureIds", "videoCaptureIds"]);
    expect(ids.body.captureIds.length).toBeGreaterThan(0);
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

  it("applies tag and missingDate to search", async () => {
    const all = await get(`/gallery/search?q=paging%20warbler`);
    expect(all.body.items).toHaveLength(18);
    const tagged = await get(`/gallery/search?q=paging%20warbler&tag=pagetag`);
    expect(tagged.body.items).toHaveLength(6);
    const undated = await get(`/gallery/search?q=paging%20warbler&missingDate=1&quick=1`);
    expect(undated.body.items.length).toBeGreaterThan(0);
    expect(undated.body.items.every((i: { takenAt: unknown }) => i.takenAt === null)).toBe(true);
  });

  it("finds a trip or an album by name", async () => {
    const ids = (await db.query<{ id: string }>(`SELECT id FROM captures_all WHERE user_id = $1 ORDER BY fingerprint LIMIT 5`, [USER])).rows.map((r) => r.id);
    const trip = await db.query<{ id: string }>(`INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Costa Rica 2024', '/x', '/x/Wildlife') RETURNING id`, [USER]);
    await db.query(`UPDATE captures_all SET trip_id = $1 WHERE id = ANY($2)`, [trip.rows[0].id, ids.slice(0, 3)]);
    const album = await db.query<{ id: string }>(`INSERT INTO albums (user_id, name) VALUES ($1, 'Best Warblers Ever') RETURNING id`, [USER]);
    await db.query(`INSERT INTO album_captures (album_id, capture_id) SELECT $1, unnest($2::uuid[])`, [album.rows[0].id, ids.slice(3, 5)]);

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
    expect(ofIds(await get(`/gallery/search?q=paging%20warbler&quick=1&tripId=${trip.rows[0].id}`))).toEqual(ids.slice(0, 3).sort());
    expect(ofIds(await get(`/gallery/search?q=paging%20warbler&quick=1&albumId=${album.rows[0].id}`))).toEqual(ids.slice(3, 5).sort());
    expect((await get(`/gallery?tripId=nope`)).status).toBe(400);
    expect((await get(`/gallery/search?q=warbler&albumId=nope`)).status).toBe(400);
  });
});
