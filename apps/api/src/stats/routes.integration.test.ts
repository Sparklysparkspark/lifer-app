// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55470/lifer npx vitest run stats/routes
// Query validation on the stats routes: the filters and years the web app sends work, anything
// else is refused with 400 instead of being quietly read as something else.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000651";
const TOKEN = "lifer_test_stats_routes_owner_651";

const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("stats route validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;

  const get = (route: string, cookies = { [cookieName]: TOKEN }) => app.inject({ method: "GET", url: route, cookies });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { statsRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'stats-routes@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);

    app = Fastify();
    await app.register(cookie);
    await app.register(statsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("takes the photo filters the web app sends, and refuses others", async () => {
    for (const filter of ["all", "featured", "topRated"]) {
      expect((await get(`/api/stats?filter=${filter}`)).statusCode).toBe(200);
    }
    expect((await get("/api/stats")).statusCode).toBe(200);
    const csv = await get("/api/stats/export.csv?filter=topRated");
    expect([csv.statusCode, csv.headers["content-type"]]).toEqual([200, expect.stringContaining("text/csv")]);

    for (const route of ["/api/stats?filter=best", "/api/stats/export.csv?filter=Featured"]) {
      const res = await get(route);
      expect([route, res.statusCode, res.json()]).toEqual([
        route,
        400,
        invalid(/^Invalid query: filter must be one of all, featured, topRated$/),
      ]);
    }
  });

  it("compares two whole years, refusing a missing, non-numeric or out-of-range year", async () => {
    const ok = await get("/api/stats/year-comparison?yearA=2024&yearB=2025");
    expect(ok.statusCode).toBe(200);
    expect(Object.keys(ok.json())).toEqual(expect.arrayContaining(["a", "b"]));

    for (const [query, pattern] of [
      ["yearA=2024", /^Invalid query: yearB is required$/],
      ["yearA=twenty&yearB=2025", /^Invalid query: yearA must be integer$/],
      ["yearA=0&yearB=2025", /^Invalid query: yearA must be >= 1$/],
      ["yearA=2024&yearB=10000", /^Invalid query: yearB must be <= 9999$/],
    ] as const) {
      const res = await get(`/api/stats/year-comparison?${query}`);
      expect([query, res.statusCode, res.json()]).toEqual([query, 400, invalid(pattern)]);
    }
  });

  it("still answers 401 before looking at the query when signed out", async () => {
    const res = await get("/api/stats/year-comparison?yearA=nope", {});
    expect([res.statusCode, res.json()]).toEqual([401, { error: "Not authenticated" }]);
  });

  it("counts a species with only RAW photos unless includeRaw=0", async () => {
    const species = "eeeeeeee-0000-4000-8000-000000000652";
    await db.query(`DELETE FROM species WHERE id = $1`, [species]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 916521, 'Rawia solum', 'Raw Only', 'aves')`,
      [species],
    );
    try {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, identification_state, camera_model)
         VALUES ($1, $2, 'stats-raw-only', '2025-05-01T10:00:00Z', 'confirmed', 'RawCam') RETURNING id`,
        [OWNER, species],
      );
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, 'raw', 'path', 'stats-raw-only.cr3', false, 'stats-raw-only', 1)`,
        [c.rows[0].id],
      );
      const rawCam = (body: { gearUsage: { cameras: { model: string; speciesCount: number }[] } }) =>
        body.gearUsage.cameras.find((g) => g.model === "RawCam");

      for (const query of ["", "?includeRaw=1"]) {
        const body = (await get(`/api/stats${query}`)).json();
        expect([query, body.totalKeepers, rawCam(body)?.speciesCount]).toEqual([query, 1, 1]);
      }
      const excluded = (await get("/api/stats?includeRaw=0")).json();
      expect([excluded.totalKeepers, rawCam(excluded)]).toEqual([0, undefined]);

      expect((await get("/api/stats/export.csv")).body).toContain("Rawia solum");
      expect((await get("/api/stats/export.csv?includeRaw=0")).body).not.toContain("Rawia solum");
      expect((await get("/api/stats?includeRaw=yes")).statusCode).toBe(400);
    } finally {
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [species]);
    }
  });

  it("lists every photo behind one EXIF bar, beyond the overview's sample", async () => {
    const species = "eeeeeeee-0000-4000-8000-000000000653";
    await db.query(`DELETE FROM species WHERE id = $1`, [species]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, 916531, 'Focalia longa', 'Long Lens', 'aves')`,
      [species],
    );
    try {
      const photoIds: string[] = [];
      for (let i = 0; i < 302; i++) {
        const c = await db.query<{ id: string }>(
          `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, identification_state, focal_length_mm)
           VALUES ($1, $2, $3, $4, 'confirmed', 450) RETURNING id`,
          [OWNER, species, `stats-bucket-${i}`, new Date(Date.UTC(2025, 0, 1, 0, i)).toISOString()],
        );
        const p = await db.query<{ id: string }>(
          `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
          [c.rows[0].id],
        );
        await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
        await db.query(
          `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
           VALUES ($1, 'jpeg', 'path', $2, false, $2, 1)`,
          [c.rows[0].id, `stats-bucket-${i}.jpg`],
        );
        photoIds.push(p.rows[0].id);
      }
      const newestFirst = [...photoIds].reverse();
      // 400-500mm is the fifth focal-length bar.
      const overview = (await get("/api/stats")).json();
      const bar = overview.exifDistributions.focalLength[4];
      expect([bar.label, bar.count, bar.photoIds]).toEqual(["400-500mm", 302, newestFirst.slice(0, 300)]);

      expect((await get("/api/stats/exif-bucket?dim=focalLength&bucket=5")).json()).toEqual({ photoIds: newestFirst });
      expect((await get("/api/stats/exif-bucket?dim=focalLength&bucket=4")).json()).toEqual({ photoIds: [] });
      expect((await get("/api/stats/exif-bucket?dim=focalLength&bucket=5&filter=topRated")).json()).toEqual({
        photoIds: [],
      });
      expect((await get("/api/stats/exif-bucket?dim=depth&bucket=5")).statusCode).toBe(400);
    } finally {
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
      await db.query(`DELETE FROM species WHERE id = $1`, [species]);
    }
  });

  it("counts keepers per month and class, and a month range narrows the stats to match its bars", async () => {
    const bird = "eeeeeeee-0000-4000-8000-000000000654";
    const frog = "eeeeeeee-0000-4000-8000-000000000655";
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[bird, frog]]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 916541, 'Avis tempora', 'Time Bird', 'aves'), ($2, 916551, 'Rana tempora', 'Time Frog', 'amphibia')`,
      [bird, frog],
    );
    let n = 0;
    const capture = async (
      species: string,
      takenAt: string | null,
      extra: { rating?: number; trashed?: boolean } = {},
    ) => {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, taken_at, identification_state, quality_rating, deleted_at)
         VALUES ($1, $2, $3, $4, 'confirmed', $5, $6) RETURNING id`,
        [OWNER, species, `stats-timeline-${n++}`, takenAt, extra.rating ?? null, extra.trashed ? new Date() : null],
      );
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size)
         VALUES ($1, 'jpeg', 'path', $2, false, $2, 1)`,
        [c.rows[0].id, `stats-timeline-${n}.jpg`],
      );
    };
    try {
      await capture(bird, "2023-03-10T12:00:00Z");
      await capture(bird, "2023-03-20T12:00:00Z");
      await capture(frog, "2023-03-21T12:00:00Z");
      await capture(frog, "2024-07-01T12:00:00Z");
      await capture(bird, null);
      // Neither an ID shot rated 1 star nor a trashed photo counts.
      await capture(bird, "2023-03-11T12:00:00Z", { rating: 1 });
      await capture(frog, "2023-03-12T12:00:00Z", { trashed: true });

      expect((await get("/api/stats/timeline")).json()).toEqual({
        months: [
          { month: "2023-03", taxonClass: "amphibia", count: 1 },
          { month: "2023-03", taxonClass: "aves", count: 2 },
          { month: "2024-07", taxonClass: "amphibia", count: 1 },
        ],
        undated: 1,
      });
      expect((await get("/api/stats")).json().totalKeepers).toBe(5);
      const march = (await get("/api/stats?from=2023-03&to=2023-03")).json();
      expect([march.totalKeepers, march.countriesPhotographed.count]).toEqual([3, 0]);
      expect((await get("/api/stats?from=2024-01")).json().totalKeepers).toBe(1);
      expect((await get("/api/stats?to=2023-12")).json().totalKeepers).toBe(3);
      expect((await get("/api/stats/export.csv?from=2024-07&to=2024-07")).body.split("\n")).toHaveLength(2);

      for (const query of ["from=2023-13", "to=2023-3", "from=2023-03'--"]) {
        expect([query, (await get(`/api/stats?${query}`)).statusCode]).toEqual([query, 400]);
      }
    } finally {
      await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [OWNER]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[bird, frog]]);
    }
  });

  it("filters the gear breakdown by camera or lens", async () => {
    expect((await get("/api/stats/gear-species-breakdown")).json()).toEqual({ breakdown: [] });
    expect((await get("/api/stats/gear-species-breakdown?camera=EOS%20R5")).json()).toEqual({ breakdown: [] });
  });
});
