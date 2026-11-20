// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run integrations
// Exercises the integration endpoints over HTTP with a real API key, the way a script would.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000107";
const SPECIES_A = "cccccccc-0000-4000-8000-00000000000a";
const SPECIES_B = "cccccccc-0000-4000-8000-00000000000b";
// On eBird's sensitive list everywhere.
const SPECIES_SENSITIVE = "cccccccc-0000-4000-8000-00000000000c";
const TOKEN = "lifer_test_integration_token_107";

describe.skipIf(!url)("integration endpoints (API key)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const captures: string[] = [];

  const get = (path: string, token = TOKEN) =>
    app.inject({ method: "GET", url: path, headers: { "x-api-key": token } });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    // API keys only apply in server mode, and the dev .env turns desktop mode on. dotenv never
    // overrides a variable already set.
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { integrationRoutes } = await import("./routes.js");
    const { photoRoutes } = await import("../photos/routes.js");
    const { apiVersionAlias } = await import("../apiRoutes.js");
    const { galleryRoutes } = await import("../gallery/routes.js");
    const { galleryMapRoutes } = await import("../gallery/map.js");
    const { tripsRoutes } = await import("../trips/routes.js");
    const { statsRoutes } = await import("../stats/routes.js");
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'integrations@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES
         ($1, 910701, 'Testus alpha', 'Alpha Bird', 'aves'), ($2, 910702, 'Testus beta', 'Beta Fox', 'mammalia')
       ON CONFLICT (id) DO NOTHING`,
      [SPECIES_A, SPECIES_B],
    );
    for (const [i, sp] of [SPECIES_A, SPECIES_B].entries()) {
      const c = await db.query<{ id: string }>(
        `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, quality_rating) VALUES ($1, $2, $3, now() - interval '1 day', 3) RETURNING id`,
        [USER, sp, `integration-${i}`],
      );
      const p = await db.query<{ id: string }>(
        `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
        [c.rows[0].id],
      );
      await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [p.rows[0].id, c.rows[0].id]);
      await db.query(
        `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', $2, true, 'abc', 1234)`,
        [c.rows[0].id, `/library/Birds/IMG_000${i}.jpg`],
      );
      await db.query(
        `INSERT INTO user_species (user_id, species_id, state, cover_photo_id, first_collected) VALUES ($1, $2, 'collected', $3, CURRENT_DATE)`,
        [USER, sp, p.rows[0].id],
      );
      captures.push(c.rows[0].id);
    }
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'test', $2, $3)`, [
      USER,
      hashApiKey(TOKEN),
      ["photos.read", "collection.read"],
    ]);
    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'narrow', $2, $3)`, [
      USER,
      hashApiKey(`${TOKEN}_narrow`),
      ["stats.read"],
    ]);

    await db.query(`INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'wide', $2, $3)`, [
      USER,
      hashApiKey(`${TOKEN}_wide`),
      ["photos.read", "gallery.read", "trips.read", "stats.read"],
    ]);

    app = Fastify({ rewriteUrl: apiVersionAlias });
    await app.register(cookie);
    for (const routes of [integrationRoutes, photoRoutes, galleryRoutes, galleryMapRoutes, tripsRoutes, statsRoutes])
      await app.register(routes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM captures_all WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM trips WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id IN ($1, $2, $3)`, [SPECIES_A, SPECIES_B, SPECIES_SENSITIVE]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("lists photos with species, originals for matching, and image links", async () => {
    const res = await get("/api/captures");
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(2);
    const a = body.items.find((i: { speciesId: string }) => i.speciesId === SPECIES_A);
    expect(a.commonName).toBe("Alpha Bird");
    expect(a.originals.jpeg).toEqual({ fileName: "IMG_0000.jpg", sizeBytes: 1234, sha256: "abc" });
    expect(a.images.thumb).toBe(`/api/photos/${a.photoId}/thumb`);
    expect(body.nextCursor).toBeNull();
    // Full microsecond precision, so it round-trips exactly as `since`.
    expect(a.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  });

  it("pages with a cursor and returns only what changed with since", async () => {
    const first = (await get("/api/captures?limit=1")).json();
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = (await get(`/api/captures?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.items).toHaveLength(1);
    expect(second.items[0].captureId).not.toBe(first.items[0].captureId);

    const mark = second.items[0].updatedAt;
    await new Promise((ok) => setTimeout(ok, 20));
    await db.query(`UPDATE captures_all SET quality_rating = 5 WHERE id = $1`, [captures[0]]);
    const changed = (await get(`/api/captures?since=${encodeURIComponent(mark)}`)).json();
    expect(changed.items.map((i: { captureId: string }) => i.captureId)).toEqual([captures[0]]);
    expect(changed.items[0].rating).toBe(5);
  });

  it("summarizes the life list", async () => {
    const res = await get("/api/life-list/summary");
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.photographedSpecies).toBe(2);
    expect(s.photos).toBe(2);
    expect(s.byTaxonClass).toEqual({ aves: 1, mammalia: 1 });
    expect(s.latestLifer.speciesId).toBeTruthy();
    const list = (await get("/api/life-list?taxonClass=aves")).json();
    expect(list.species.map((x: { scientificName: string }) => x.scientificName)).toEqual(["Testus alpha"]);
    expect(list.species[0].photoCount).toBe(1);
  });

  it("lets a photos.read key fetch images (404 here only because the test file doesn't exist)", async () => {
    const item = (await get("/api/captures")).json().items[0];
    expect((await get(item.images.thumb)).statusCode).toBe(404);
    expect((await get(item.images.thumb, `${TOKEN}_narrow`)).statusCode).toBe(401);
  });

  it("refuses a key without the scope, or no key", async () => {
    expect((await get("/api/captures", `${TOKEN}_narrow`)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/life-list/summary" })).statusCode).toBe(401);
  });

  it("refuses a malformed speciesId or regionId instead of failing", async () => {
    expect((await get("/api/captures?speciesId=nope")).statusCode).toBe(400);
    expect((await get("/api/life-list/summary?regionId=nope")).statusCode).toBe(404);
  });

  it("checks the feed's query against its schema", async () => {
    const invalid = { error: expect.stringMatching(/^Invalid query: /), code: "invalid_request" };
    for (const query of ["limit=0", "limit=-3", "limit=abc", "includeDeleted=yes", "speciesId=42"]) {
      const res = await get(`/api/captures?${query}`);
      expect([query, res.statusCode, res.json()]).toEqual([query, 400, invalid]);
    }
    expect((await get("/api/captures?speciesId=nope")).json().error).toBe(
      "Invalid query: speciesId must be an id (a UUID)",
    );
    // An unknown key never learns about the schema: authentication comes first.
    expect((await get("/api/captures?limit=0", "lifer_no_such_key")).statusCode).toBe(401);
    // Larger pages are capped, as documented, and an empty parameter means it wasn't given.
    const capped = await get("/api/captures?limit=100000&speciesId=&since=");
    expect([capped.statusCode, capped.json().items.length]).toEqual([200, 2]);
    expect((await get("/api/captures?includeDeleted=0&limit=1")).json().items).toHaveLength(1);
  });

  it("checks the life list's query, keeping 404 for a malformed region", async () => {
    expect((await get("/api/life-list?include=all")).statusCode).toBe(400);
    expect((await get("/api/life-list?include=seen")).statusCode).toBe(200);
    expect((await get("/api/life-list/summary?regionId=")).json().region).toBeNull();
    const bad = await get("/api/life-list/summary?regionId=12345");
    expect([bad.statusCode, bad.json()]).toEqual([404, { error: "Unknown region" }]);
  });

  it("answers with exactly the documented fields", async () => {
    const item = (await get("/api/captures")).json().items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        "captureId",
        "photoId",
        "speciesId",
        "scientificName",
        "commonName",
        "taxonClass",
        "additionalSpecies",
        "takenAt",
        "createdAt",
        "updatedAt",
        "deletedAt",
        "lat",
        "lon",
        "regionId",
        "regionName",
        "locationLabel",
        "tripId",
        "camera",
        "rating",
        "tags",
        "lifeStage",
        "sex",
        "plumage",
        "morph",
        "kind",
        "width",
        "height",
        "originals",
        "images",
      ].sort(),
    );
    // Dates keep their full ISO form through the response schema.
    expect(item.takenAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    const latest = (await get("/api/life-list/summary")).json().latestLifer;
    expect(latest.firstCollected).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it("serves an OpenAPI document generated from the route schemas", async () => {
    const doc = (await app.inject({ method: "GET", url: "/api/openapi.json" })).json();
    const feed = doc.paths["/captures"].get;
    expect(feed["x-required-scope"]).toBe("photos.read");
    expect(feed.parameters.find((p: { name: string }) => p.name === "limit")).toMatchObject({
      in: "query",
      required: false,
      schema: { type: "integer", minimum: 1 },
    });
    expect(feed.responses["200"].content["application/json"].schema.properties.items.type).toBe("array");
  });

  it("answers the same routes under /api/v1", async () => {
    const plain = await get("/api/life-list/summary");
    const versioned = await get("/api/v1/life-list/summary");
    expect([versioned.statusCode, versioned.json()]).toEqual([200, plain.json()]);
    expect((await get("/api/v1/captures?limit=0")).statusCode).toBe(400);
    expect((await get("/api/v1/captures", `${TOKEN}_narrow`)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/v1/openapi.json" })).json().servers).toEqual([
      { url: "/api/v1" },
    ]);
  });

  it("never gives an API key a sensitive species' coordinates or place name", async () => {
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class)
       VALUES ($1, 910703, 'Strix nebulosa', 'Great Grey Owl', 'aves') ON CONFLICT (id) DO NOTHING`,
      [SPECIES_SENSITIVE],
    );
    const trip = await db.query<{ id: string }>(
      `INSERT INTO trips (user_id, name, source_folder, destination_folder) VALUES ($1, 'Owls', '/in', '/out') RETURNING id`,
      [USER],
    );
    const owl = await db.query<{ id: string }>(
      `INSERT INTO captures (user_id, species_id, fingerprint, taken_at, quality_rating, lat, lon, location_label, trip_id)
       VALUES ($1, $2, 'integration-owl', now(), 3, 51.123456, -0.654321, 'Secret Wood', $3) RETURNING id`,
      [USER, SPECIES_SENSITIVE, trip.rows[0].id],
    );
    const owlPhoto = await db.query<{ id: string }>(
      `INSERT INTO photos (capture_id, display_path, thumb_path) VALUES ($1, '/nowhere/d.webp', '/nowhere/t.webp') RETURNING id`,
      [owl.rows[0].id],
    );
    await db.query(`UPDATE captures_all SET current_photo_id = $1 WHERE id = $2`, [
      owlPhoto.rows[0].id,
      owl.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO originals (capture_id, kind, ref_type, ref, managed, content_hash, file_size) VALUES ($1, 'jpeg', 'path', '/library/owl.jpg', true, 'def', 1)`,
      [owl.rows[0].id],
    );
    // An ordinary species beside it keeps its point, so the check below can't pass by hiding everything.
    await db.query(
      `UPDATE captures_all SET lat = 49.28, lon = -123.12, location_label = 'Stanley Park', trip_id = $2 WHERE id = $1`,
      [captures[1], trip.rows[0].id],
    );
    const wide = (path: string) => get(path, `${TOKEN}_wide`);
    const place = (i: { lat: unknown; lon: unknown; locationLabel: unknown }) => [i.lat, i.lon, i.locationLabel];

    for (const path of ["/api/captures", "/api/v1/captures"]) {
      const items = (await wide(path)).json().items as Array<{
        captureId: string;
        lat: unknown;
        lon: unknown;
        locationLabel: unknown;
      }>;
      expect(place(items.find((i) => i.captureId === owl.rows[0].id)!)).toEqual([null, null, null]);
      expect(place(items.find((i) => i.captureId === captures[1])!)).toEqual([49.28, -123.12, "Stanley Park"]);
    }

    const gallery = (await wide("/api/gallery")).json().items as Array<{
      captureId: string;
      lat: unknown;
      lon: unknown;
      locationLabel: unknown;
    }>;
    expect(place(gallery.find((i) => i.captureId === owl.rows[0].id)!)).toEqual([null, null, null]);
    expect(gallery.find((i) => i.captureId === captures[1])!.lat).not.toBeNull();

    const map = (await wide("/api/gallery/map")).json();
    expect(map.cells.map((c: { photoId: string }) => c.photoId)).not.toContain(owlPhoto.rows[0].id);
    expect(map.cells).toHaveLength(1);

    const tripItems = (await wide(`/api/trips/${trip.rows[0].id}/photos`)).json().items as Array<{
      captureId: string;
      lat: unknown;
      lon: unknown;
      locationLabel: unknown;
    }>;
    expect(place(tripItems.find((i) => i.captureId === owl.rows[0].id)!)).toEqual([null, null, null]);
    expect(tripItems.find((i) => i.captureId === captures[1])!.lat).not.toBeNull();

    const csv = (await wide("/api/stats/export.csv")).body;
    expect(csv).toContain("Great Grey Owl");
    expect(csv).not.toMatch(/51\.12|0\.654|Secret Wood/);
    expect(csv).toContain("Stanley Park");
  });
});
