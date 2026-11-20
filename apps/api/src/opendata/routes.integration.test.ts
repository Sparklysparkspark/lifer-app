// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database.
// The opendata.read routes with a real key: installed regions, a region's list, and a point lookup.
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "cccccccc-0000-4000-8000-000000000701";
const COUNTRY = "cccccccc-0000-4000-8000-000000000710";
const PROVINCE = "cccccccc-0000-4000-8000-000000000711";
const OTHER_REGION = "cccccccc-0000-4000-8000-000000000712";
const SOUTH = "cccccccc-0000-4000-8000-000000000713";
const SP = ["cccccccc-0000-4000-8000-0000000007a0", "cccccccc-0000-4000-8000-0000000007b0"];
const TOKEN = "lifer_test_opendata_token_701";
const NARROW = "lifer_test_opendata_token_702";
const square = (x0: number, y0: number, x1: number, y1: number) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [x0, y0],
        [x1, y0],
        [x1, y1],
        [x0, y1],
        [x0, y0],
      ],
    ],
  },
});

describe.skipIf(!url)("opendata endpoints (API key)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const get = (p: string, token = TOKEN) => app.inject({ method: "GET", url: p, headers: { "x-api-key": token } });

  async function cleanup() {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id LIKE 'opendata-test-%'`);
    await db.query(`DELETE FROM api_keys WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM regions WHERE id = ANY($1)`, [[PROVINCE, SOUTH, COUNTRY, OTHER_REGION]]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    db = new pg.Pool({ connectionString: url });
    const { hashApiKey } = await import("../auth/apiKeys.js");
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'opendata@test', 'x')`, [USER]);
    await db.query(
      `INSERT INTO regions (id, name, parent_id, ebird_region_code, boundary_geojson) VALUES
         ($1, 'Opendatia', NULL, 'ZZ', $4), ($2, 'Opendatia North', $1, 'ZZ-N', $5), ($3, 'Opendatia Unpacked', NULL, NULL, $6)`,
      [COUNTRY, PROVINCE, OTHER_REGION, square(10, 10, 20, 20), square(10, 15, 20, 20), square(30, 30, 40, 40)],
    );
    // A province with a list of its own but no pack of its own.
    await db.query(
      `INSERT INTO regions (id, name, parent_id, home_country_id) VALUES ($1, 'Opendatia South', $2, $2)`,
      [SOUTH, COUNTRY],
    );
    await db.query(`UPDATE regions SET home_country_id = $1 WHERE id = $2`, [COUNTRY, PROVINCE]);
    // A real list, not a hub of other countries' lists, for the ranking.
    await db.query(`UPDATE regions SET external_codes = '{ZZ}' WHERE id = $1`, [COUNTRY]);
    for (const [i, id] of SP.entries())
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, taxon_class) VALUES ($1, $2, $3, $4, 'aves')`,
        [id, 970700 + i, `Opendatus ${"ab"[i]}`, `Open Bird ${i}`],
      );
    for (const id of SP)
      await db.query(`INSERT INTO region_species (region_id, species_id, is_vagrant) VALUES ($1, $2, false)`, [
        COUNTRY,
        id,
      ]);
    await db.query(`INSERT INTO region_species (region_id, species_id, is_vagrant) VALUES ($1, $2, false)`, [
      SOUTH,
      SP[0],
    ]);
    // Species a: its closest gallery photo is non-commercial; species b's photo is CC BY and a little further.
    const { CLIP_SPACE } = await import("@lifer/core/species/embeddings.js");
    const vec = (x: number) =>
      Array.from({ length: 768 }, (_, i) => (i === 0 ? x : i === 1 ? Math.sqrt(1 - x * x) : 0));
    await db.query(
      `UPDATE species SET reference_display_path = 'x.webp', reference_license = 'cc-by-nc' WHERE id = ANY($1)`,
      [SP],
    );
    for (const [i, [x, license]] of (
      [
        [1, "cc-by-nc"],
        [0.9, "cc-by"],
      ] as const
    ).entries()) {
      const photo = await db.query<{ id: string }>(
        `INSERT INTO species_reference_photos (species_id, photo_url, credit, license) VALUES ($1, 'https://x/p', 'A. Name', $2) RETURNING id`,
        [SP[i], license],
      );
      await db.query(
        `INSERT INTO species_reference_gallery_embeddings (reference_photo_id, species_id, embedding, model_version, license)
         VALUES ($1, $2, $3, $4, $5)`,
        [photo.rows[0].id, SP[i], vec(x), CLIP_SPACE.modelVersion, license],
      );
    }
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, region, species_count) VALUES ('opendata-test-1', 'Opendatia', 2), ('opendata-test-2', 'Opendatia North', 1)`,
    );
    const key = `INSERT INTO api_keys (user_id, name, key_hash, permissions) VALUES ($1, 'k', $2, $3)`;
    await db.query(key, [USER, hashApiKey(TOKEN), ["opendata.read"]]);
    await db.query(key, [USER, hashApiKey(NARROW), ["userdata.read"]]);
    app = Fastify();
    installSchemas(app);
    await app.register(cookie);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("lists installed regions only, with country code, bounds and count", async () => {
    const res = await get("/api/opendata/v1/regions");
    expect(res.statusCode).toBe(200);
    const mine = (res.json() as { regions: { id: string }[] }).regions.filter((r) =>
      [COUNTRY, PROVINCE, SOUTH, OTHER_REGION].includes(r.id),
    );
    expect(mine).toEqual([
      {
        id: COUNTRY,
        name: "Opendatia",
        countryCode: "ZZ",
        parentId: null,
        bounds: { minLat: 10, minLon: 10, maxLat: 20, maxLon: 20 },
        speciesCount: 2,
      },
      {
        id: PROVINCE,
        name: "Opendatia North",
        countryCode: "ZZ",
        parentId: COUNTRY,
        bounds: { minLat: 15, minLon: 10, maxLat: 20, maxLon: 20 },
        speciesCount: 1,
      },
      {
        id: SOUTH,
        name: "Opendatia South",
        countryCode: "ZZ",
        parentId: COUNTRY,
        bounds: null,
        speciesCount: 1,
      },
    ]);
  });

  it("resolves a point to the most specific installed region first", async () => {
    const ids = async (lat: number, lon: number) =>
      (
        (await get(`/api/opendata/v1/regions/at?lat=${lat}&lon=${lon}`)).json() as { regions: { id: string }[] }
      ).regions.map((r) => r.id);
    expect(await ids(17, 15)).toEqual([PROVINCE, COUNTRY]);
    expect(await ids(12, 15)).toEqual([COUNTRY]);
    expect(await ids(35, 35)).toEqual([]);
    expect((await get("/api/opendata/v1/regions/at?lat=99&lon=0")).statusCode).toBe(400);
  });

  it("returns a region's list in the phone's item shape", async () => {
    const res = await get(`/api/opendata/v1/regions/${COUNTRY}/checklist`);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { regionId: string; name: string; items: Record<string, unknown>[] };
    expect(body).toMatchObject({ regionId: COUNTRY, name: "Opendatia" });
    expect(body.items.map((i) => i.scientificName)).toEqual(["Opendatus a", "Opendatus b"]);
    expect(Object.keys(body.items[0]).sort()).toEqual(
      ["commonName", "ebirdCode", "isVagrant", "scientificName", "sensitiveByDefault", "taxonClass", "tier"].sort(),
    );
    expect((await get("/api/opendata/v1/regions/cccccccc-0000-4000-8000-000000000799/checklist")).statusCode).toBe(404);
  });

  it("serves the whole region tree, installed or not", async () => {
    const res = await get("/api/opendata/v1/regions/tree");
    expect(res.statusCode).toBe(200);
    const mine = new Map(
      (res.json() as { regions: Array<{ id: string } & Record<string, unknown>> }).regions.map((r) => [r.id, r]),
    );
    expect(mine.get(SOUTH)).toMatchObject({
      parentId: COUNTRY,
      hasChecklist: true,
      installed: true,
      countryCode: "ZZ",
    });
    expect(mine.get(OTHER_REGION)).toMatchObject({ parentId: null, hasChecklist: false, installed: false });
    expect(mine.get(COUNTRY)).toMatchObject({ name: "Opendatia", aliases: [] });
  });

  it("ranks species for a vector with openly licensed photos only", async () => {
    const { CLIP_SPACE } = await import("@lifer/core/species/embeddings.js");
    const rank = (body: object, token = TOKEN) =>
      app.inject({
        method: "POST",
        url: "/api/opendata/v1/species/rank",
        headers: { "x-api-key": token },
        payload: body,
      });
    const query = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const res = await rank({ model: CLIP_SPACE.modelVersion, regionId: COUNTRY, vectors: [query] });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { suggestions: { scientificName: string }[] }).suggestions.map(
      (s) => s.scientificName,
    );
    // a's only photo is non-commercial, so it can't be matched at all; b's open photo wins.
    expect(names).toEqual(["Opendatus b"]);
    expect((await rank({ model: "other-v1", regionId: COUNTRY, vectors: [query] })).statusCode).toBe(409);
    expect((await rank({ model: CLIP_SPACE.modelVersion, regionId: COUNTRY, vectors: [[1, 0]] })).statusCode).toBe(400);
    expect(
      (await rank({ model: CLIP_SPACE.modelVersion, regionId: COUNTRY, vectors: [query] }, NARROW)).statusCode,
    ).toBe(401);
  });

  it("ranks a batch exactly as single calls, in order", async () => {
    const { CLIP_SPACE } = await import("@lifer/core/species/embeddings.js");
    const model = CLIP_SPACE.modelVersion;
    const post = (url: string, body: object, token = TOKEN) =>
      app.inject({
        method: "POST",
        url: `/api/opendata/v1/species/${url}`,
        headers: { "x-api-key": token },
        payload: body,
      });
    const unit = (x: number) =>
      Array.from({ length: 768 }, (_, i) => (i === 0 ? x : i === 1 ? Math.sqrt(1 - x * x) : 0));
    const items = [
      { vectors: [unit(1)], takenAt: null },
      { vectors: [unit(0.9), unit(0.2)], takenAt: "2026-05-01T10:00:00Z" },
      { vectors: [unit(-0.5)], takenAt: null },
    ];
    const res = await post("rank-batch", { model, regionId: COUNTRY, limit: 5, items });
    expect(res.statusCode).toBe(200);
    const singles = await Promise.all(
      items.map(async (it) => (await post("rank", { model, regionId: COUNTRY, limit: 5, ...it })).json()),
    );
    expect(res.json()).toEqual({ model, results: singles.map((s) => ({ suggestions: s.suggestions })) });
    expect(singles[0].suggestions.length).toBeGreaterThan(0);

    const status = async (body: object, token = TOKEN) => (await post("rank-batch", body, token)).statusCode;
    const ok = { model, regionId: COUNTRY, items: [items[0]] };
    expect(await status({ ...ok, items: Array.from({ length: 16 }, () => items[0]) })).toBe(200);
    expect(await status({ ...ok, items: Array.from({ length: 17 }, () => items[0]) })).toBe(400);
    expect(await status({ ...ok, items: [] })).toBe(400);
    expect(await status({ ...ok, items: [{ vectors: [[1, 0]], takenAt: null }] })).toBe(400);
    expect(await status({ ...ok, items: [{ vectors: Array.from({ length: 5 }, () => unit(1)) }] })).toBe(400);
    expect(await status({ ...ok, items: [{ ...items[0], extra: 1 }] })).toBe(400);
    expect(await status({ ...ok, extra: 1 })).toBe(400);
    expect(await status({ ...ok, limit: 21 })).toBe(400);
    const mismatch = await post("rank-batch", { ...ok, model: "other-v1" });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ code: "model_mismatch" });
    expect(await status(ok, NARROW)).toBe(401);

    // With suggestions off, every item answers empty.
    await db.query(`UPDATE users SET species_suggest_enabled = false WHERE id = $1`, [USER]);
    try {
      expect((await post("rank-batch", { ...ok, items }).then((r) => r.json())).results).toEqual(
        items.map(() => ({ suggestions: [] })),
      );
    } finally {
      await db.query(`UPDATE users SET species_suggest_enabled = true WHERE id = $1`, [USER]);
    }
  });

  it("names species by Lifer's scientific and common names, through synonyms", async () => {
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Oldgenus opendatus')`, [
      SP[1],
    ]);
    const res = await app.inject({
      method: "POST",
      url: "/api/opendata/v1/species/names",
      headers: { "x-api-key": TOKEN },
      payload: { scientificNames: ["Opendatus a", "Oldgenus opendatus", "Nonesuch nothing"] },
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json() as { names: { scientificName: string; canonicalScientificName: string }[] }).names;
    expect(names.map((n) => [n.scientificName, n.canonicalScientificName]).sort()).toEqual([
      ["Oldgenus opendatus", "Opendatus b"],
      ["Opendatus a", "Opendatus a"],
    ]);
    // The survivor's id and GBIF key, so a caller can store a stable key.
    expect(names.find((n) => n.scientificName === "Oldgenus opendatus")).toMatchObject({
      speciesId: SP[1],
      gbifKey: 970701,
    });
  });

  it("needs the opendata.read scope", async () => {
    expect((await get("/api/opendata/v1/regions", NARROW)).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/opendata/v1/regions" })).statusCode).toBe(401);
  });
});
