// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// GET /stats over a small library: EXIF buckets, gear, time of day and insights.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const OWNER = "eeeeeeee-0000-4000-8000-000000000661";
const TOKEN = "lifer_test_stats_overview_owner_661";
const SPECIES_A = "eeeeeeee-0000-4000-8000-000000000662";
const SPECIES_B = "eeeeeeee-0000-4000-8000-000000000663";

// [species, focal, aperture, shutter, iso, rating, taken_at]
const CAPTURES: Array<[string, number | null, number | null, string | null, number | null, number | null, string]> = [
  [SPECIES_A, 150, 5.6, "1/2000", 400, null, "2024-05-01T06:30:00"],
  [SPECIES_A, 600, 6.3, "0.0005", 3200, 5, "2024-05-02T06:10:00"],
  [SPECIES_B, 600, 4, "1/250", 100, 4, "2024-06-03T06:45:00"],
  [SPECIES_B, 900, 8, "2", 12800, null, "2024-07-04T18:00:00"],
  [SPECIES_B, null, null, "garbage", null, null, "2024-07-05T06:00:00"],
  // Rated 1 star: an ID shot, not a keeper.
  [SPECIES_A, 100, 2, "1/50", 200, 1, "2024-07-06T06:00:00"],
  [SPECIES_B, 650, 5.6, null, null, null, "2024-07-07T12:00:00"],
];

describe.skipIf(!url)("GET /stats", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const photoIds: string[] = [];

  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { statsRoutes } = await import("./routes.js");

    await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B]]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'stats-overview@test', 'x')`, [OWNER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      OWNER,
    ]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 915661, 'Statia prima', 'First Stat', 'aves'), ($2, 915662, 'Statia secunda', 'Second Stat', 'aves')`,
      [SPECIES_A, SPECIES_B],
    );
    for (const [i, [species, focal, aperture, shutter, iso, rating, takenAt]] of CAPTURES.entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures_all (user_id, species_id, fingerprint, focal_length_mm, aperture, shutter, iso,
                                   quality_rating, taken_at, camera_model, lens)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'EOS R5', 'RF 100-500')
         RETURNING id`,
        [OWNER, species, `stats-overview-${i}`, focal, aperture, shutter, iso, rating, takenAt],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, user_id, content_hash, file_size)
         VALUES ($1, 'jpeg', 'path', $2, false, $3, $2, 1)`,
        [c.rows[0].id, `/nowhere/stats-overview-${i}.jpg`, OWNER],
      );
      photoIds.push(p.rows[0].id);
    }

    app = Fastify();
    await app.register(cookie);
    await app.register(statsRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    if (db) {
      await db.query(`DELETE FROM users WHERE id = $1`, [OWNER]);
      await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES_A, SPECIES_B]]);
      await db.end();
    }
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  const counts = (buckets: Array<{ label: string; count: number }>) =>
    Object.fromEntries(buckets.filter((b) => b.count > 0).map((b) => [b.label, b.count]));

  it("buckets keepers' EXIF, with a sample of photo ids per bucket", async () => {
    const res = await get("/api/stats");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalKeepers).toBe(6);
    const { focalLength, iso, aperture, shutter } = body.exifDistributions;
    expect(focalLength).toHaveLength(8);
    expect(counts(focalLength)).toEqual({ "100-200mm": 1, "600-800mm": 3, "800mm+": 1 });
    expect(counts(iso)).toEqual({ "≤200": 1, "400": 1, "3200": 1, "6400+": 1 });
    expect(counts(aperture)).toEqual({ "f/4.0-5.6": 1, "f/5.6-8.0": 3, "f/8.0+": 1 });
    expect(counts(shutter)).toEqual({ "1/1000-1/2000": 2, "1/125-1/250": 1, "≤1/125": 1 });
    expect(focalLength.find((b: { label: string }) => b.label === "600-800mm").photoIds.sort()).toEqual(
      [photoIds[1], photoIds[2], photoIds[6]].sort(),
    );
    expect(focalLength.find((b: { label: string }) => b.label === "0-100mm").photoIds).toEqual([]);
    expect(
      counts(body.hitRateByFocalLength.map((b: { label: string; species: number }) => ({ ...b, count: b.species }))),
    ).toEqual({
      "100-200mm": 1,
      "600-800mm": 2,
      "800mm+": 1,
    });

    expect(body.gearUsage.cameras).toEqual([{ model: "EOS R5", photoCount: 6, speciesCount: 2 }]);
    expect(body.timeOfDay.find((h: { hour: number }) => h.hour === 6).count).toBe(4);
    expect(body.scatter).toHaveLength(6);
    expect(body.scatter.find((s: { shutterLabel: string | null }) => s.shutterLabel === "1/2000")).toBeDefined();
    expect(body.insights).toEqual([
      "You photographed 100% of your keepers with the EOS R5.",
      "60% of your keepers were shot in the 600-800mm range.",
      "Your most productive hour is 6 AM, 67% of your keepers.",
    ]);
  });

  it("narrows to 5-star photos with the topRated filter", async () => {
    const body = (await get("/api/stats?filter=topRated")).json();
    expect(body.totalKeepers).toBe(1);
    expect(counts(body.exifDistributions.focalLength)).toEqual({ "600-800mm": 1 });
    expect(counts(body.exifDistributions.shutter)).toEqual({ "1/1000-1/2000": 1 });
  });

  it("parses shutter speeds in SQL the same way as in code", async () => {
    const { parseShutterSeconds, shutterSecondsSql } = await import("./shutter.js");
    const raws = [
      "1/2000",
      "1 / 250",
      "0.0005",
      "2",
      "30",
      ".5",
      "5e-4",
      "1/0",
      "0",
      "0/1",
      "",
      "abc",
      "1/2/3",
      "-1",
      "9".repeat(400),
    ];
    const res = await db.query<{ raw: string; seconds: number | null }>(
      `SELECT v AS raw, ${shutterSecondsSql("v")} AS seconds FROM unnest($1::text[]) AS v`,
      [raws],
    );
    for (const row of res.rows) {
      const expected = parseShutterSeconds(row.raw);
      expect([row.raw, row.seconds]).toEqual([
        row.raw,
        expected === null || !Number.isFinite(expected) ? null : expected,
      ]);
    }
  });

  it("answers the other stats views over the same library", async () => {
    const portfolio = (await get("/api/stats/species-portfolio")).json();
    expect(portfolio.species).toHaveLength(2);
    expect(
      portfolio.species.find((r: { scientificName: string }) => r.scientificName === "Statia prima"),
    ).toMatchObject({
      totalPhotos: 3,
      rated4Plus: 1,
      bestRating: 5,
      earliestTakenAt: expect.stringMatching(/^2024-05-01/),
    });
    expect((await get("/api/stats/archive-health")).json()).toEqual({ total: 7, missingDate: 0 });
    expect((await get("/api/stats/gear-species-breakdown?camera=EOS%20R5")).json()).toEqual({
      breakdown: [{ taxonClass: "aves", count: 7, percent: 100 }],
    });
    const years = (await get("/api/stats/year-comparison?yearA=2024&yearB=2025")).json();
    expect(years.a).toMatchObject({ year: 2024, speciesCount: 2, photoCount: 7 });
    expect(years.b).toEqual({ year: 2025, speciesCount: 0, photoCount: 0, avgFocalLength: null, avgIso: null });
    const dna = (await get("/api/stats/photography-dna")).json();
    expect(dna).toMatchObject({ medianFocalLengthMm: 600, medianIso: 400 });
    expect(dna.categoryBreakdown.map((c: { key: string }) => c.key)).toEqual([
      "portrait",
      "flight",
      "behavior",
      "environmental",
    ]);
  });
});
