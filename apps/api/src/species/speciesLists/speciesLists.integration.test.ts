// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer:lifer@localhost:5432/lifer_test npx vitest run speciesLists.integration
// Lists from iNaturalist against a fake iNaturalist: preview, adding in the background, dedupe
// against existing species, native only, pause and resume, removal keeping what the user
// photographed or marked, and that nothing reaches the catalog tables or apps' open data routes.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  process.env.INAT_MIN_HOST_INTERVAL_MS = "1";
});

const url = process.env.TEST_DATABASE_URL;
const USER = "abcdabcd-0000-4000-8000-00000000d101";
const OTHER_USER = "abcdabcd-0000-4000-8000-00000000d102";
const COUNTRY = "Zzlistland";
const PROVINCE = "Zzlist East";
const COUNTRY_PLACE = 424_201;
const PROVINCE_PLACE = 424_202;
const SPIDERS = 424_240;
const GATED = 424_241;
const N = 620;
const BASE_ID = 991_000;

vi.mock("../../auth/session.js", () => {
  const asUser = async (request: { user?: unknown; headers: Record<string, unknown> }) => {
    const id = request.headers["x-test-user"] === "other" ? OTHER_USER : USER;
    request.user = { id, email: `${id}@test` };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

// The fake iNaturalist: N spiders, every third one introduced, one with an openly licensed photo.
const calls: URL[] = [];
let releaseGate: () => void = () => {};
const taxon = (i: number) => ({
  count: N - i,
  taxon: {
    id: BASE_ID + i,
    name: `Zzlist sp${i}`,
    rank: "species",
    iconic_taxon_name: "Arachnida",
    preferred_common_name: i % 2 ? `list spider ${i}` : undefined,
    establishment_means: { establishment_means: i % 3 === 0 ? "introduced" : "native" },
    default_photo:
      i === 1
        ? {
            medium_url: "https://inaturalist-open-data.s3.amazonaws.com/photos/1/medium.jpg",
            license_code: "cc-by",
            attribution: "(c) A",
          }
        : null,
  },
});
async function fakeFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  calls.push(u);
  if (u.pathname === "/v1/observations/species_counts") {
    const id = Number(u.searchParams.get("taxon_id"));
    if (id === GATED)
      await new Promise<void>((resolve, reject) => {
        releaseGate = resolve;
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    let all = Array.from({ length: id === GATED ? 10 : N }, (_, k) => taxon(k + 1));
    if (u.searchParams.get("native") === "true")
      all = all.filter((r) => r.taxon.establishment_means.establishment_means === "native");
    const per = Number(u.searchParams.get("per_page"));
    const page = Number(u.searchParams.get("page"));
    return Response.json({
      total_results: all.length,
      page,
      per_page: per,
      results: all.slice((page - 1) * per, page * per),
    });
  }
  if (u.pathname === "/v1/taxa/autocomplete")
    return Response.json({
      results: [{ id: SPIDERS, name: "Araneae", rank: "order", preferred_common_name: "Spiders" }],
    });
  if (u.pathname === "/v1/places/autocomplete") return new Response("busy", { status: 429 });
  return new Response("not found", { status: 404 });
}

describe.skipIf(!url)("lists from iNaturalist", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let countryId: string;
  let provinceId: string;
  let worker: typeof import("./worker.js");

  const call = (method: "GET" | "POST" | "PATCH" | "DELETE", route: string, payload?: object, user = "me") =>
    app.inject({ method, url: `/api${route}`, payload, headers: user === "other" ? { "x-test-user": "other" } : {} });
  const speciesCountsCalls = () => calls.filter((c) => c.pathname.endsWith("species_counts"));
  const idOf = async (i: number) =>
    (
      await db.query<{ id: string }>(
        `SELECT id FROM species WHERE scientific_name = $1 ORDER BY is_other_taxa LIMIT 1`,
        [`Zzlist sp${i}`],
      )
    ).rows[0].id;
  async function idle() {
    for (let i = 0; i < 500; i++) {
      await worker.speciesListJob.settled();
      await new Promise((r) => setTimeout(r, 20));
      if (!worker.speciesListJob.status.running) return;
    }
    throw new Error("list worker didn't stop");
  }
  const createBody = (extra: object = {}) => ({
    taxonId: SPIDERS,
    taxonName: "Spiders",
    taxonRank: "order",
    placeId: COUNTRY_PLACE,
    placeName: COUNTRY,
    ...extra,
  });

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = ANY($1)`, [[USER, OTHER_USER]]);
    await db.query(`DELETE FROM species WHERE scientific_name LIKE 'Zzlist %'`);
    await db.query(`DELETE FROM regions WHERE name = ANY($1)`, [[PROVINCE, COUNTRY]]);
    await db.query(
      `DELETE FROM inat_response_cache WHERE url LIKE '%place_id=4242%' OR url LIKE '%autocomplete%q=zz%'`,
    );
    await db.query(`DELETE FROM sync_tombstones WHERE user_id = ANY($1)`, [[USER, OTHER_USER]]);
  }

  beforeAll(async () => {
    vi.stubGlobal("fetch", vi.fn(fakeFetch));
    db = new pg.Pool({ connectionString: url });
    await cleanup();
    await db.query(
      `INSERT INTO users (id, email, password_hash, any_taxa_search_enabled)
       VALUES ($1, 'list-a@test', 'x', true), ($2, 'list-b@test', 'x', true)`,
      [USER, OTHER_USER],
    );
    countryId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, external_codes, inat_place_id, has_children) VALUES ($1, '{ZZL}', $2, true) RETURNING id`,
        [COUNTRY, COUNTRY_PLACE],
      )
    ).rows[0].id;
    provinceId = (
      await db.query<{ id: string }>(
        `INSERT INTO regions (name, parent_id, external_codes, inat_place_id) VALUES ($1, $2, '{ZZL-E}', $3) RETURNING id`,
        [PROVINCE, countryId, PROVINCE_PLACE],
      )
    ).rows[0].id;
    // Catalog species a list must reuse: one by iNaturalist id, one by name only.
    await db.query(
      `INSERT INTO species (gbif_key, scientific_name, taxon_class, inat_taxon_id)
       VALUES (987654321, 'Zzlist sp2', 'arachnida', $1), (987654322, 'Zzlist sp3', 'arachnida', NULL)`,
      [BASE_ID + 2],
    );
    worker = await import("./worker.js");
    const { speciesListRoutes } = await import("./routes.js");
    const { opendataRoutes } = await import("../../opendata/routes.js");
    app = Fastify();
    await app.register(
      async (api) => {
        await api.register(speciesListRoutes);
        await api.register(opendataRoutes);
      },
      { prefix: "/api" },
    );
    await app.ready();
  });

  afterAll(async () => {
    await worker?.stopSpeciesLists();
    vi.unstubAllGlobals();
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("previews a list with one cached call and adds nothing", async () => {
    calls.length = 0;
    const body = { taxonId: SPIDERS, placeId: COUNTRY_PLACE };
    const res = await call("POST", "/species-lists/preview", body);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ count: N, batches: 1 });
    expect(res.json().examples).toHaveLength(6);
    expect(res.json().examples[0]).toEqual({
      taxonId: BASE_ID + 1,
      scientificName: "Zzlist sp1",
      commonName: "List Spider 1",
    });
    await call("POST", "/species-lists/preview", body);
    expect(speciesCountsCalls()).toHaveLength(1);
    expect(speciesCountsCalls()[0].searchParams.get("per_page")).toBe("6");
    expect((await db.query(`SELECT 1 FROM species_lists WHERE user_id = $1`, [USER])).rowCount).toBe(0);
  });

  it("adds a list in the background in two pages, reusing existing species", async () => {
    calls.length = 0;
    const res = await call("POST", "/species-lists", createBody());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ created: true, list: { name: `Spiders of ${COUNTRY}`, regionId: countryId } });
    await idle();
    expect(speciesCountsCalls().map((c) => c.searchParams.get("page"))).toEqual(["1", "2"]);

    const lists = (await call("GET", "/species-lists")).json().lists;
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ status: "done", addedCount: N, sizeEstimate: N, capped: false, lastError: null });
    const created = await db.query(
      `SELECT count(*)::int AS n FROM species WHERE scientific_name LIKE 'Zzlist %' AND is_other_taxa`,
    );
    expect(created.rows[0].n).toBe(N - 2);
    const sp2 = await db.query(`SELECT is_other_taxa, common_name FROM species WHERE scientific_name = 'Zzlist sp2'`);
    expect(sp2.rows).toEqual([{ is_other_taxa: false, common_name: null }]);
    // Only an openly licensed photo is kept.
    const photos = await db.query(
      `SELECT scientific_name, reference_license FROM species WHERE scientific_name LIKE 'Zzlist %' AND reference_photo IS NOT NULL`,
    );
    expect(photos.rows).toEqual([{ scientific_name: "Zzlist sp1", reference_license: "cc-by" }]);
    const additions = await db.query(
      `SELECT user_id, region_id, count(*)::int AS n, bool_and(via_list) AS via_list FROM region_species_user_added a
        JOIN species s ON s.id = a.species_id WHERE s.scientific_name LIKE 'Zzlist %' GROUP BY 1, 2`,
    );
    expect(additions.rows).toEqual([{ user_id: USER, region_id: countryId, n: N, via_list: true }]);
    // Personal by construction: never a catalog checklist row.
    const catalog = await db.query(
      `SELECT 1 FROM region_species rs JOIN species s ON s.id = rs.species_id WHERE s.scientific_name LIKE 'Zzlist %'`,
    );
    expect(catalog.rowCount).toBe(0);
    expect((await call("GET", "/species-lists", undefined, "other")).json().lists).toEqual([]);
  });

  it("adds nothing twice when the same list is added again or refreshed", async () => {
    const again = await call("POST", "/species-lists", createBody());
    expect(again.json()).toMatchObject({ created: false });
    const id = again.json().list.id;
    expect((await call("POST", `/species-lists/${id}/refresh`)).statusCode).toBe(200);
    await idle();
    const counts = await db.query(
      `SELECT (SELECT count(*)::int FROM species WHERE scientific_name LIKE 'Zzlist %') AS species,
              (SELECT count(*)::int FROM species_list_members WHERE list_id = $1) AS members`,
      [id],
    );
    expect(counts.rows[0]).toEqual({ species: N, members: N });
    expect((await call("GET", "/species-lists")).json().lists[0]).toMatchObject({ status: "done", addedCount: N });
  });

  it("asks iNaturalist for native species only when the list says so", async () => {
    calls.length = 0;
    const res = await call(
      "POST",
      "/species-lists",
      createBody({ placeId: PROVINCE_PLACE, placeName: PROVINCE, nativeOnly: true }),
    );
    expect(res.json().list.regionId).toBe(provinceId);
    await idle();
    expect(speciesCountsCalls().every((c) => c.searchParams.get("native") === "true")).toBe(true);
    const list = (await call("GET", "/species-lists"))
      .json()
      .lists.find((l: { regionId: string }) => l.regionId === provinceId);
    expect(list).toMatchObject({ status: "done", nativeOnly: true, addedCount: N - Math.floor(N / 3) });
    // Same species rows as the country's list.
    const species = await db.query(`SELECT count(*)::int AS n FROM species WHERE scientific_name LIKE 'Zzlist %'`);
    expect(species.rows[0].n).toBe(N);
  });

  it("pauses mid-fetch and resumes from the saved page", async () => {
    const created = await call("POST", "/species-lists", createBody({ taxonId: GATED, taxonName: "Gated" }));
    const id = created.json().list.id;
    for (let i = 0; i < 100 && worker.speciesListJob.status.listId !== id; i++)
      await new Promise((r) => setTimeout(r, 10));
    const paused = await call("POST", `/species-lists/${id}/pause`);
    expect(paused.json().list).toMatchObject({ status: "paused", addedCount: 0, fetchingNow: false });
    expect((await call("POST", `/species-lists/${id}/pause`)).statusCode).toBe(409);
    const resumed = await call("POST", `/species-lists/${id}/resume`);
    expect(resumed.json().list.status).toMatch(/queued|running/);
    for (let i = 0; i < 100 && worker.speciesListJob.status.listId !== id; i++)
      await new Promise((r) => setTimeout(r, 10));
    releaseGate();
    await idle();
    expect((await call("GET", "/species-lists")).json().lists.find((l: { id: string }) => l.id === id)).toMatchObject({
      status: "done",
      addedCount: 10,
    });
    expect((await call("DELETE", `/species-lists/${id}`)).statusCode).toBe(200);
  });

  it("keeps apps' open data free of list species", async () => {
    const sp5 = await idOf(5);
    // An open photo and vector, so only the source keeps it out.
    const vector = Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0));
    const { CLIP_SPACE } = await import("@lifer/core/species/embeddings.js");
    const { rankSpeciesBatch, invalidateSuggestionCache } = await import("@lifer/core/species/suggest.js");
    const { pool } = await import("@lifer/core/db.js");
    await db.query(
      `UPDATE species SET reference_display_path = '/nowhere/x.webp', reference_license = 'cc-by', reference_photo = 'https://x/y.jpg', reference_credit = 'A' WHERE id = $1`,
      [sp5],
    );
    await db.query(
      `INSERT INTO species_reference_embeddings (species_id, embedding, model_version) VALUES ($1, $2, $3)`,
      [sp5, vector, CLIP_SPACE.modelVersion],
    );
    invalidateSuggestionCache();
    const rank = (openOnly: boolean) =>
      rankSpeciesBatch(
        pool,
        USER,
        [{ embeddings: [Float32Array.from(vector)], takenAt: null }],
        provinceId,
        5,
        CLIP_SPACE,
        null,
        { openOnly },
      );
    // Inside Lifer, a region's suggestions now include the user's list species...
    expect((await rank(false))[0].map((s) => s.id)).toContain(sp5);
    // ...but the open ranking apps get never does.
    expect((await rank(true))[0].map((s) => s.id)).not.toContain(sp5);

    const names = await call("POST", "/opendata/v1/species/names", { scientificNames: ["Zzlist sp5", "Zzlist sp2"] });
    expect(names.json().names.map((n: { scientificName: string }) => n.scientificName)).toEqual(["Zzlist sp2"]);
    const checklist = await call("GET", `/opendata/v1/regions/${countryId}/checklist`);
    expect(checklist.json().items).toEqual([]);

    const defs = await call("GET", "/opendata/v1/species-lists");
    expect(defs.statusCode).toBe(200);
    for (const l of defs.json().lists)
      expect(Object.keys(l).sort()).toEqual(
        [
          "countryCode",
          "hidden",
          "id",
          "name",
          "nativeOnly",
          "regionId",
          "placeId",
          "placeName",
          "sizeEstimate",
          "taxonId",
          "taxonName",
          "taxonRank",
          "updatedAt",
        ].sort(),
      );
    expect(defs.json().lists[0]).toMatchObject({
      taxonId: SPIDERS,
      placeId: COUNTRY_PLACE,
      sizeEstimate: N,
      regionId: countryId,
      hidden: false,
    });
    expect(Number.isNaN(Date.parse(defs.json().lists[0].updatedAt))).toBe(false);
    expect(defs.body).not.toContain("Zzlist sp");
  });

  it("removes a list, keeping species the user photographed, marked or added by hand", async () => {
    const [sp10, sp11, sp12] = [await idOf(10), await idOf(11), await idOf(12)];
    await db.query(`INSERT INTO user_species (user_id, species_id, is_target) VALUES ($1, $2, true)`, [USER, sp10]);
    await db.query(`INSERT INTO captures_all (user_id, species_id, fingerprint) VALUES ($1, $2, 'zzlist-fp')`, [
      USER,
      sp11,
    ]);
    const { addToRegionChecklist } = await import("../../regions/checklistAdditions.js");
    const { pool } = await import("@lifer/core/db.js");
    expect(await addToRegionChecklist(pool, USER, countryId, sp12)).toBe(false);

    const list = (await call("GET", "/species-lists"))
      .json()
      .lists.find((l: { regionId: string }) => l.regionId === countryId);
    const res = await call("DELETE", `/species-lists/${list.id}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().kept).toBe(2);

    const left = await db.query<{ species_id: string; via_list: boolean }>(
      `SELECT species_id, via_list FROM region_species_user_added WHERE user_id = $1 AND region_id = $2 ORDER BY species_id`,
      [USER, countryId],
    );
    expect(left.rows).toEqual([sp10, sp11, sp12].sort().map((species_id) => ({ species_id, via_list: false })));
    // Species rows the removed list alone held are gone; the province list's and the kept ones stay.
    const otherTaxa = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM species s WHERE s.scientific_name LIKE 'Zzlist %' AND s.is_other_taxa`,
    );
    const stillListed = await db.query<{ n: number }>(
      `SELECT count(DISTINCT s.id)::int AS n FROM species s
         LEFT JOIN species_list_members m ON m.species_id = s.id
        WHERE s.scientific_name LIKE 'Zzlist %' AND s.is_other_taxa AND (m.list_id IS NOT NULL OR s.id = ANY($1))`,
      [[sp10, sp11, sp12]],
    );
    expect(otherTaxa.rows[0].n).toBe(stillListed.rows[0].n);
    expect(otherTaxa.rows[0].n).toBeLessThan(N - 2);
    // The catalog species stay whatever happens to lists.
    expect(
      (
        await db.query(
          `SELECT 1 FROM species WHERE scientific_name IN ('Zzlist sp2', 'Zzlist sp3') AND NOT is_other_taxa`,
        )
      ).rowCount,
    ).toBe(2);
    const tomb = await db.query(`SELECT ref FROM sync_tombstones WHERE user_id = $1 AND kind = 'species_list'`, [USER]);
    expect(tomb.rows.map((r) => r.ref)).toContain(list.id);
    await db.query(`DELETE FROM captures_all WHERE fingerprint = 'zzlist-fp'`);
  });

  it("targets every species a list adds, page by page, and takes the targets back", async () => {
    const [sp4, sp10] = [await idOf(4), await idOf(10)];
    await db.query(
      `INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')
       ON CONFLICT (user_id, species_id) DO UPDATE SET state = 'collected'`,
      [USER, sp4],
    );
    const targetsNow = async () =>
      (
        await db.query<{ id: string }>(
          `SELECT s.id FROM user_species us JOIN species s ON s.id = us.species_id
            WHERE us.user_id = $1 AND us.is_target AND s.scientific_name LIKE 'Zzlist %'`,
          [USER],
        )
      ).rows.map((r) => r.id);

    const res = await call("POST", "/species-lists", createBody({ targets: { name: "Spider targets" } }));
    expect(res.statusCode).toBe(200);
    const { list } = res.json();
    expect(list.targetListId).toEqual(expect.any(String));
    await idle();
    const onList = await db.query(`SELECT count(*)::int AS n FROM target_list_species WHERE list_id = $1`, [
      list.targetListId,
    ]);
    // Every species but the photographed one.
    expect(onList.rows[0].n).toBe(N - 1);
    expect((await targetsNow()).length).toBe(N - 1);
    expect(await targetsNow()).not.toContain(sp4);

    const undone = await call("POST", `/species-lists/${list.id}/untarget`);
    expect(undone.json().list.targetListId).toBeNull();
    // The one the user flagged by hand stays a target; the emptied target list goes.
    expect(await targetsNow()).toEqual([sp10]);
    expect((await db.query(`SELECT 1 FROM target_lists WHERE id = $1`, [list.targetListId])).rowCount).toBe(0);

    // An existing list targets what it holds already, at once.
    const again = await call(
      "POST",
      "/species-lists",
      createBody({ placeId: PROVINCE_PLACE, placeName: PROVINCE, nativeOnly: true, targets: { photographed: true } }),
    );
    expect(again.json()).toMatchObject({ created: false, list: { name: `Spiders of ${PROVINCE}` } });
    const province = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM species_list_members WHERE list_id = $1`,
      [again.json().list.id],
    );
    expect((await targetsNow()).length).toBe(province.rows[0].n);
    const named = await db.query(`SELECT name FROM target_lists WHERE id = $1`, [again.json().list.targetListId]);
    expect(named.rows[0].name).toBe(`Spiders of ${PROVINCE}`);
    await call("POST", `/species-lists/${again.json().list.id}/untarget`);
    expect((await call("POST", "/species-lists/00000000-0000-4000-8000-000000000000/untarget")).statusCode).toBe(404);
  });

  it("searches places in Lifer's regions first and reports iNaturalist refusing politely", async () => {
    const exact = await call("GET", `/species-lists/search/places?q=${encodeURIComponent(COUNTRY)}`);
    expect(exact.json()).toEqual({
      results: [expect.objectContaining({ placeId: COUNTRY_PLACE, regionId: countryId })],
      inatUnavailable: null,
    });
    const partial = await call("GET", "/species-lists/search/places?q=zzli");
    expect(partial.json().inatUnavailable).toBe("rate_limited");
    expect(partial.json().results.length).toBeGreaterThan(0);
    const taxa = await call("GET", "/species-lists/search/taxa?q=zzspiders");
    expect(taxa.json().results[0]).toMatchObject({ taxonId: SPIDERS, commonName: "Spiders", rank: "order" });
  });
});
