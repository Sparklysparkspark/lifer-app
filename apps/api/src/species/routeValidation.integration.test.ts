// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer_test npx vitest run species/routeValidation
// The species routes' schemas: malformed input is refused with the status clients rely on (404 for
// a malformed id, 400 otherwise), and well-formed input still gets through to the handler.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000611";
const REGION = "ffffffff-0000-4000-8000-0000000006b1";
const SPECIES = "ffffffff-0000-4000-8000-000000000620";
const OTHER_TAXA = "ffffffff-0000-4000-8000-000000000621";
const NO_SUCH = "ffffffff-0000-4000-8000-0000000006ff";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "species-validation@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

// Warming would load the matching models when this machine has them; the route is what's tested.
vi.mock("@lifer/core/species/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lifer/core/species/embeddings.js")>()),
  warmSuggestions: async () => {},
}));

const invalid = (pattern: RegExp) => ({ error: expect.stringMatching(pattern), code: "invalid_request" });

describe.skipIf(!url)("species route validation", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, payload?: unknown) =>
    app.inject({ method, url: `/api${path}`, payload: payload as object });

  async function cleanup() {
    await db.query(`DELETE FROM user_species WHERE user_id = $1`, [USER]);
    await db.query(`DELETE FROM region_species WHERE region_id = $1`, [REGION]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [[SPECIES, OTHER_TAXA]]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, any_taxa_search_enabled) VALUES ($1, 'species-validation@test', 'x', true)`,
      [USER],
    );
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Validland', '{ZZV}')`, [REGION]);
    // enriched_at and gallery_backfilled_at set, so the detail page never fetches anything live.
    await db.query(
      `INSERT INTO species (id, gbif_key, scientific_name, taxon_class, enriched_at, gallery_backfilled_at)
       VALUES ($1, 916100, 'Validia schemata', 'aves', now(), now()),
              ($2, 916101, 'Validia othera', 'insecta', now(), now())`,
      [SPECIES, OTHER_TAXA],
    );
    await db.query(`UPDATE species SET is_other_taxa = true, inat_taxon_id = 916101 WHERE id = $1`, [OTHER_TAXA]);

    const { speciesRoutes } = await import("./routes.js");
    const { splitRoutes } = await import("./splitRoutes.js");
    const { matchingRoutes } = await import("./matchingRoutes.js");
    app = Fastify();
    await app.register(
      async (api) => {
        await api.register(speciesRoutes);
        await api.register(splitRoutes);
        await api.register(matchingRoutes);
      },
      { prefix: "/api" },
    );
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  describe("detail", () => {
    it("answers 404 for a malformed id and 400 for a malformed regionId", async () => {
      const bad = await call("GET", "/species/nope");
      expect([bad.statusCode, bad.json()]).toEqual([404, { error: "Species not found" }]);
      const region = await call("GET", `/species/${SPECIES}?regionId=nope`);
      expect([region.statusCode, region.json()]).toEqual([400, invalid(/^Invalid query: regionId must be an id/)]);
      for (const path of ["seen", "target", "encounters", "sequences", "volume-usage", "unmatched-raws"]) {
        const method = path === "seen" || path === "target" ? "PATCH" : "GET";
        const res = await call(method, `/species/nope/${path}`);
        expect([path, res.statusCode, res.json()]).toEqual([path, 404, { error: "Species not found" }]);
      }
    });

    it("still serves well-formed requests", async () => {
      const detail = await call("GET", `/species/${SPECIES}?regionId=${REGION}`);
      expect(detail.statusCode).toBe(200);
      expect(detail.json().species.scientific_name).toBe("Validia schemata");
      // An empty query value means "not given", as the web app sends it.
      expect((await call("GET", `/species/${SPECIES}?regionId=`)).statusCode).toBe(200);

      const seen = await call("PATCH", `/species/${SPECIES}/seen`);
      expect([seen.statusCode, seen.json()]).toEqual([200, { ok: true }]);
      const row = await db.query(`SELECT state FROM user_species WHERE user_id = $1 AND species_id = $2`, [USER, SPECIES]);
      expect(row.rows[0]?.state).toBe("seen");
      expect((await call("DELETE", `/species/${SPECIES}/seen`)).statusCode).toBe(200);

      const encounters = await call("GET", `/species/${SPECIES}/encounters`);
      expect([encounters.statusCode, encounters.json().totalPhotos]).toEqual([200, 0]);
    });
  });

  describe("reference photos", () => {
    it("answers 404 for malformed ids and lists a well-formed species", async () => {
      const list = await call("GET", "/species/nope/reference-photos");
      expect([list.statusCode, list.json()]).toEqual([404, { error: "Species not found" }]);
      const main = await call("GET", "/species/nope/reference-photo/thumb");
      expect([main.statusCode, main.json()]).toEqual([404, { error: "Reference photo not found" }]);
      const gallery = await call("GET", "/species/reference-gallery-photo/nope/display");
      expect([gallery.statusCode, gallery.json()]).toEqual([404, { error: "Gallery photo not found" }]);
      const ok = await call("GET", `/species/${SPECIES}/reference-photos`);
      expect([ok.statusCode, ok.json()]).toEqual([200, { photos: [] }]);
    });
  });

  describe("other taxa", () => {
    it("refuses a wrong type, a missing field, an extra field and an out-of-range taxon id", async () => {
      const add = (body: unknown) => call("POST", "/species/other-taxa", body);
      expect((await add({ inatTaxonId: "12", regionId: REGION })).json()).toEqual(invalid(/inatTaxonId must be integer/));
      expect((await add({ inatTaxonId: 12 })).json()).toEqual(invalid(/regionId is required/));
      expect((await add({ inatTaxonId: 12, regionId: REGION, extra: 1 })).json()).toEqual(invalid(/unexpected field extra/));
      const zero = await add({ inatTaxonId: 0, regionId: REGION });
      expect([zero.statusCode, zero.json()]).toEqual([400, invalid(/inatTaxonId must be >= 1/)]);
      expect((await add(undefined)).statusCode).toBe(400);
    });

    it("keeps 404 for a malformed region, which the handler checks", async () => {
      const res = await call("POST", "/species/other-taxa", { inatTaxonId: 12, regionId: "nope" });
      expect([res.statusCode, res.json()]).toEqual([404, { error: "Region not found" }]);
      const bulk = await call("POST", "/species/other-taxa/bulk", { regionId: "nope", entries: ["Apis mellifera"] });
      expect([bulk.statusCode, bulk.json()]).toEqual([404, { error: "Region not found" }]);
    });

    it("refuses an empty or non-list bulk entry list", async () => {
      const bulk = (body: unknown) => call("POST", "/species/other-taxa/bulk", body);
      expect((await bulk({ regionId: REGION, entries: [] })).json()).toEqual(invalid(/entries must /));
      expect((await bulk({ regionId: REGION, entries: "Apis mellifera" })).json()).toEqual(invalid(/entries must be array/));
      expect((await bulk({ regionId: REGION, entries: [3] })).json()).toEqual(invalid(/entries\.0 must be string/));
    });

    it("removes an Other Taxa species by a well-formed id only", async () => {
      const bad = await call("DELETE", "/species/nope/other-taxa");
      expect([bad.statusCode, bad.json()]).toEqual([404, { error: "Species not found" }]);
      const notOther = await call("DELETE", `/species/${SPECIES}/other-taxa`);
      expect(notOther.statusCode).toBe(400);
      const removed = await call("DELETE", `/species/${OTHER_TAXA}/other-taxa`);
      expect([removed.statusCode, removed.json()]).toEqual([200, { ok: true }]);
    });
  });

  describe("splits", () => {
    it("answers 404 for a malformed id and 400 for a malformed body", async () => {
      expect((await call("GET", "/species/nope/split")).statusCode).toBe(404);
      const post = (body: unknown, id = SPECIES) => call("POST", `/species/${id}/split`, body);
      const badId = await post({ keep: true }, "nope");
      expect([badId.statusCode, badId.json()]).toEqual([404, { error: "Species not found" }]);
      expect((await post({ speciesId: "nope" })).json()).toEqual(invalid(/speciesId must be an id/));
      expect((await post({ keep: "yes" })).json()).toEqual(invalid(/keep must be boolean/));
      expect((await post({ keep: true, also: 1 })).json()).toEqual(invalid(/unexpected field also/));
      // A well-formed species that isn't one of the split's: the handler's own 400.
      const notOption = await post({ speciesId: NO_SUCH });
      expect([notOption.statusCode, notOption.json()]).toEqual([400, { error: "Pick one of the species it was split into" }]);
    });

    it("still keeps the old name when asked", async () => {
      expect((await call("GET", `/species/${SPECIES}/split`)).statusCode).toBe(200);
      const keep = await call("POST", `/species/${SPECIES}/split`, { keep: true });
      expect([keep.statusCode, keep.json()]).toEqual([200, { ok: true, updated: 0 }]);
    });
  });

  describe("matching warm-up", () => {
    it("refuses a malformed regionId or an extra field and accepts a region or none", async () => {
      const warm = (body: unknown) => call("POST", "/species/matching/warm", body);
      expect((await warm({ regionId: "nope" })).json()).toEqual(invalid(/regionId must be an id/));
      expect((await warm({ regionId: 5 })).statusCode).toBe(400);
      expect((await warm({ regionId: REGION, extra: true })).json()).toEqual(invalid(/unexpected field extra/));
      for (const body of [{ regionId: REGION }, { regionId: null }, {}]) {
        const res = await warm(body);
        expect([res.statusCode, res.json()]).toEqual([202, { warming: true }]);
      }
    });
  });
});
