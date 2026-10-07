// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@127.0.0.1:55432/lifer_test npx vitest run species/otherTaxa
// Hand imports from iNaturalist: one species and a pasted list each become the importing user's
// own checklist additions (never a shared region_species row), so they show marked "Added by you"
// for that user only. Removing one takes it off that user's lists and deletes the species itself
// only once nobody else has it. iNaturalist, GBIF and photo enrichment are stubbed: no network.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-000000000c01";
const OTHER_USER = "abcdabcd-0000-4000-8000-000000000c02";
const HUB = "Zzimport Continent";
const COUNTRY = "Zzimportland";
const PROVINCE = "Zzimport East";
// iNaturalist taxon ids the stub knows. Their GBIF match fails, so the species gets a synthetic
// negative key, as a real import of an unmatched taxon does.
const BEETLE = 990_301;
const MOTH = 990_302;
const TAXA: Record<number, { name: string; common: string; iconic: string }> = {
  [BEETLE]: { name: "Zzimportus beetlei", common: "import beetle", iconic: "Insecta" },
  [MOTH]: { name: "Zzimportus mothi", common: "import moth", iconic: "Insecta" },
};

// The signed-in user comes from a test header, so one app serves both users.
vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown; headers: Record<string, unknown> }) => {
    const id = request.headers["x-test-user"] === "other" ? OTHER_USER : USER;
    request.user = { id, email: `${id}@test` };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

// Photos and descriptions would be fetched live; the checklist handling is what's tested.
vi.mock("@lifer/core/species/lazyEnrich.js", () => ({
  enrichSpecies: async () => ({ gallery: [], referencePhoto: null }),
  persistEnrichment: async () => {},
  persistGalleryPromotingMainIfMissing: async () => {},
}));

// Saving writes the library's own record file, which a test must never touch.
vi.mock("../lib/collectionState.js", () => ({ scheduleCollectionStateSave: () => {} }));

function fakeFetch(input: string | URL | Request): Promise<Response> {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const taxon = href.match(/api\.inaturalist\.org\/v1\/taxa\/(\d+)/);
  if (taxon && TAXA[Number(taxon[1])]) {
    const t = TAXA[Number(taxon[1])];
    return Promise.resolve(
      Response.json({
        results: [
          {
            id: Number(taxon[1]),
            name: t.name,
            preferred_common_name: t.common,
            iconic_taxon_name: t.iconic,
            // A regional status and a global IUCN one: the global one wins, stored as its code.
            conservation_statuses: [
              { status: "S2", authority: "NatureServe", place: { id: 1 }, iucn: 40 },
              { status: "vulnerable", authority: "IUCN Red List", place: null, iucn: 30 },
            ],
          },
        ],
      }),
    );
  }
  if (href.includes("api.gbif.org/v1/species/match")) return Promise.resolve(Response.json({}));
  return Promise.reject(new Error(`unexpected fetch in test: ${href}`));
}

describe.skipIf(!url)("hand imports (Other Taxa)", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let hubId: string;
  let countryId: string;
  let provinceId: string;

  const call = (method: "GET" | "POST" | "DELETE", route: string, payload?: object, user: "me" | "other" = "me") =>
    app.inject({ method, url: `/api${route}`, payload, headers: user === "other" ? { "x-test-user": "other" } : {} });

  const speciesIdFor = async (inatTaxonId: number) =>
    (await db.query<{ id: string }>(`SELECT id FROM species WHERE inat_taxon_id = $1`, [inatTaxonId])).rows[0]?.id;
  const additions = async (speciesId: string) =>
    (
      await db.query<{ user_id: string; region_id: string }>(
        `SELECT user_id, region_id FROM region_species_user_added WHERE species_id = $1 ORDER BY user_id, region_id`,
        [speciesId],
      )
    ).rows;
  const catalogRows = async (speciesId: string) =>
    Number((await db.query(`SELECT count(*) FROM region_species WHERE species_id = $1`, [speciesId])).rows[0].count);
  async function checklist(regionId: string, user: "me" | "other" = "me") {
    const res = await call("GET", `/regions/${regionId}/species`, undefined, user);
    expect(res.statusCode).toBe(200);
    return (res.json().items as Array<{ speciesId: string; userAddedRegion: { id: string } | null }>).map((i) => ({
      speciesId: i.speciesId,
      addedTo: i.userAddedRegion?.id ?? null,
    }));
  }
  async function bulkImport(regionId: string, entries: string[]) {
    const started = await call("POST", "/species/other-taxa/bulk", { regionId, entries });
    expect([started.statusCode, started.json()]).toEqual([200, { started: true, total: entries.length }]);
    for (let i = 0; i < 100; i++) {
      const status = (await call("GET", "/species/other-taxa/bulk/status")).json();
      if (!status.running) return status as { added: number; alreadyPresent: number; notFound: string[] };
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("bulk import didn't finish");
  }

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM species WHERE inat_taxon_id = ANY($1)`, [[BEETLE, MOTH]]);
    await db.query(`DELETE FROM regions WHERE name = ANY($1)`, [[PROVINCE, COUNTRY, HUB]]);
  }

  beforeAll(async () => {
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, any_taxa_search_enabled)
       VALUES ($1, 'import-a@test', 'x', true), ($2, 'import-b@test', 'x', true)`,
      [USER, OTHER_USER],
    );
    hubId = (await db.query<{ id: string }>(`INSERT INTO regions (name) VALUES ($1) RETURNING id`, [HUB])).rows[0].id;
    countryId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at, has_children)
         VALUES ($1, $2, '{ZZI}', now(), true) RETURNING id`,
        [COUNTRY, hubId],
      )
    ).rows[0].id;
    provinceId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at)
         VALUES ($1, $2, '{ZZI-E}', now()) RETURNING id`,
        [PROVINCE, countryId],
      )
    ).rows[0].id;

    const { otherTaxaRoutes } = await import("./otherTaxa.js");
    const { regionRoutes } = await import("../regions/routes.js");
    app = Fastify();
    await app.register(
      async (api) => {
        await api.register(otherTaxaRoutes);
        await api.register(regionRoutes);
      },
      { prefix: "/api" },
    );
    await app.ready();
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM species WHERE inat_taxon_id = ANY($1)`, [[BEETLE, MOTH]]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("adds one species to the importing user's checklist only, marked as added by them", async () => {
    const res = await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    expect(res.statusCode).toBe(200);
    const beetle = await speciesIdFor(BEETLE);
    expect(res.json()).toEqual({ speciesId: beetle });
    expect(await additions(beetle)).toEqual([{ user_id: USER, region_id: provinceId }]);
    expect(await catalogRows(beetle)).toBe(0);

    expect(await checklist(provinceId)).toContainEqual({ speciesId: beetle, addedTo: provinceId });
    // Rolls up to the country, still marked with the province it was added to.
    expect(await checklist(countryId)).toContainEqual({ speciesId: beetle, addedTo: provinceId });
    expect((await checklist(provinceId, "other")).map((i) => i.speciesId)).not.toContain(beetle);
    // The "insecta" filter is offered where the user has one.
    const presence = await call("GET", `/regions/taxon-presence?regionIds=${countryId}`);
    expect(presence.json()[countryId]).toContain("insecta");
    const othersPresence = await call("GET", `/regions/taxon-presence?regionIds=${countryId}`, undefined, "other");
    expect(othersPresence.json()[countryId]).not.toContain("insecta");
  });

  it("stores the species' conservation status in species_traits as an IUCN code", async () => {
    await call("POST", "/species/other-taxa", { inatTaxonId: MOTH, regionId: provinceId });
    const moth = await speciesIdFor(MOTH);
    const traits = await db.query(`SELECT iucn_status, iucn_source FROM species_traits WHERE species_id = $1`, [moth]);
    expect(traits.rows).toEqual([{ iucn_status: "VU", iucn_source: "inaturalist" }]);
  });

  it("reuses the species when a second user imports it, adding it for them too", async () => {
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    const again = await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: countryId }, "other");
    const beetle = await speciesIdFor(BEETLE);
    expect(again.json()).toEqual({ speciesId: beetle });
    expect(await additions(beetle)).toEqual([
      { user_id: USER, region_id: provinceId },
      { user_id: OTHER_USER, region_id: countryId },
    ]);
  });

  it("unhides a species the user had hidden in that region", async () => {
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    const beetle = await speciesIdFor(BEETLE);
    await db.query(`INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3)`, [
      USER,
      provinceId,
      beetle,
    ]);
    expect((await checklist(provinceId)).map((i) => i.speciesId)).not.toContain(beetle);
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    expect((await checklist(provinceId)).map((i) => i.speciesId)).toContain(beetle);
  });

  it("refuses World or a continent, which have no checklist of their own", async () => {
    const one = await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: hubId });
    expect([one.statusCode, one.json().code]).toEqual([400, "no_checklist"]);
    const bulk = await call("POST", "/species/other-taxa/bulk", { regionId: hubId, entries: [String(BEETLE)] });
    expect([bulk.statusCode, bulk.json().code]).toEqual([400, "no_checklist"]);
    expect(await speciesIdFor(BEETLE)).toBeUndefined();
  });

  it("imports a pasted list as the user's additions, counting ones already there", async () => {
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    const result = await bulkImport(provinceId, [String(BEETLE), String(MOTH)]);
    expect(result).toMatchObject({ added: 1, alreadyPresent: 1, notFound: [] });
    const [beetle, moth] = [await speciesIdFor(BEETLE), await speciesIdFor(MOTH)];
    expect(await additions(moth)).toEqual([{ user_id: USER, region_id: provinceId }]);
    expect(await catalogRows(beetle)).toBe(0);
    expect(await catalogRows(moth)).toBe(0);
  });

  it("removes a species from the remover's lists only, and deletes it once nobody has it", async () => {
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: countryId }, "other");
    const beetle = await speciesIdFor(BEETLE);
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [USER, beetle]);

    const mine = await call("DELETE", `/species/${beetle}/other-taxa`);
    expect([mine.statusCode, mine.json()]).toEqual([200, { ok: true }]);
    expect(await additions(beetle)).toEqual([{ user_id: OTHER_USER, region_id: countryId }]);
    expect((await db.query(`SELECT 1 FROM user_species WHERE species_id = $1`, [beetle])).rowCount).toBe(0);
    // The other user still has it, so the species stays, on their checklist and not on mine.
    expect(await speciesIdFor(BEETLE)).toBe(beetle);
    expect((await checklist(countryId, "other")).map((i) => i.speciesId)).toContain(beetle);
    expect((await checklist(countryId)).map((i) => i.speciesId)).not.toContain(beetle);

    const theirs = await call("DELETE", `/species/${beetle}/other-taxa`, undefined, "other");
    expect(theirs.statusCode).toBe(200);
    expect(await speciesIdFor(BEETLE)).toBeUndefined();
  });

  it("keeps a species another user has photographed, while removing it from the remover's lists", async () => {
    await call("POST", "/species/other-taxa", { inatTaxonId: BEETLE, regionId: provinceId });
    const beetle = await speciesIdFor(BEETLE);
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'seen')`, [
      OTHER_USER,
      beetle,
    ]);
    const res = await call("DELETE", `/species/${beetle}/other-taxa`);
    expect(res.statusCode).toBe(200);
    expect(await additions(beetle)).toEqual([]);
    expect(await speciesIdFor(BEETLE)).toBe(beetle);
  });
});
