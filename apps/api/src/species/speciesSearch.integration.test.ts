// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run speciesSearch
// GET /species over species_search_names (migration 111): codes, diacritics, old names, boosts.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000311";
const REGION = "ffffffff-0000-4000-8000-0000000003b1";
const SP = Array.from({ length: 4 }, (_, i) => `ffffffff-0000-4000-8000-00000000031${i}`);

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "search@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

type Result = { id: string; scientific_name: string; common_name: string | null; rank: number };

describe.skipIf(!url)("GET /species search", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let hasTable = false;
  const search = async (q: string, extra = "") => {
    const res = await app.inject({ method: "GET", url: `/api/species?q=${encodeURIComponent(q)}${extra}` });
    return { status: res.statusCode, results: (res.statusCode === 200 ? res.json().results : []) as Result[] };
  };

  async function cleanup() {
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = ANY($1)`, [SP]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
  }

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    hasTable = ((await db.query(`SELECT 1 FROM pg_class WHERE relname = 'species_search_names'`)).rowCount ?? 0) > 0;
    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'search@test', 'x')`, [USER]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Zzsearchland', '{ZZS}')`, [REGION]);
    const rows: Array<[string, string, string | null, string[], string | null, string | null]> = [
      ["Zzquuxa ñandúensis", "Zzquux Ñandú Test", ["Zzquux Rhea"], "ZQNT", "zqnand1"],
      ["Zzquuxa secunda", "Zzquux Sparrow Test", [], "ZQST", null],
      ["Zzquuxa tertia", "Zzquux Sparrow Test Two", [], null, null],
      ["Zzquuxa quarta", "Zzquux Sparrow Test Three", [], null, null],
    ].map(([sci, common, aliases, aba, ebird], i) => [SP[i], sci as string, common as string, aliases as string[], aba as string | null, ebird as string | null]);
    for (const [i, [id, sci, common, aliases, aba, ebird]] of rows.entries()) {
      await db.query(
        `INSERT INTO species (id, gbif_key, scientific_name, common_name, common_name_aliases, aba_code, ebird_code, taxon_class, family)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'aves', 'Zzquuxidae')`,
        [id, 913100 + i, sci, common, aliases, aba, ebird],
      );
    }
    // Trigger path: a synonym added after the species row exists.
    await db.query(`INSERT INTO species_synonyms (species_id, synonym_name) VALUES ($1, 'Oldgenus zzquuxorum')`, [SP[1]]);
    await db.query(`INSERT INTO region_species (region_id, species_id) VALUES ($1, $2)`, [REGION, SP[3]]);
    await db.query(`INSERT INTO user_species (user_id, species_id, state) VALUES ($1, $2, 'collected')`, [USER, SP[2]]);

    const { speciesRoutes } = await import("./routes.js");
    const { whenSpeciesSearchReady } = await import("./search.js");
    app = Fastify();
    await app.register(speciesRoutes, { prefix: "/api" });
    await app.ready();
    await whenSpeciesSearchReady();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("keeps the response shape", async () => {
    const { status, results } = await search("zzquux sparrow");
    expect(status).toBe(200);
    expect(Object.keys(results[0]).sort()).toEqual(["common_name", "id", "rank", "scientific_name"]);
  });

  it("ranks an exact 4 or 6 letter code first", async () => {
    expect((await search("zqst")).results[0].id).toBe(SP[1]);
    expect((await search("ZQNAND1".slice(0, 6))).results.some((r) => r.id === SP[0])).toBe(true);
  });

  it("matches without diacritics, by alias, and by an old scientific name", async () => {
    if (!hasTable) return;
    expect((await search("zzquux nandu test")).results[0].id).toBe(SP[0]);
    expect((await search("zzquux rhea")).results[0].id).toBe(SP[0]);
    expect((await search("oldgenus zzquuxorum")).results[0].id).toBe(SP[1]);
    await db.query(`UPDATE species SET common_name_aliases = '{Zzquux Emu}' WHERE id = $1`, [SP[0]]);
    expect((await search("zzquux emu")).results[0]?.id).toBe(SP[0]);
  });

  it("boosts the region's checklist and the user's own species within a tier", async () => {
    if (!hasTable) return;
    const plain = (await search("zzquux sparrow test t")).results.map((r) => r.id);
    expect(plain.indexOf(SP[2])).toBeLessThan(plain.indexOf(SP[3])); // collected
    const inRegion = (await search("zzquux sparrow test t", `&regionId=${REGION}`)).results.map((r) => r.id);
    expect(inRegion.indexOf(SP[3])).toBeLessThan(inRegion.indexOf(SP[2])); // on the checklist
  });

  it("finds species by family", async () => {
    if (!hasTable) return;
    expect((await search("zzquuxidae")).results.map((r) => r.id).sort()).toEqual([...SP].sort());
  });

  it("refuses a malformed regionId", async () => {
    expect((await search("zzquux", "&regionId=nope")).status).toBe(400);
    // Left empty, as the web app sends it when no region is picked, it's simply not given.
    expect((await search("zzquux", "&regionId=")).status).toBe(200);
  });
});
