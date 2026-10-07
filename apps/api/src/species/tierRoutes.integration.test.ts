// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run tierRoutes
// A tier's reasons come back for the popover, and the user's own tier wins in the region's list.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const USER = "ffffffff-0000-4000-8000-000000000511";
const REGION = "ffffffff-0000-4000-8000-0000000005b1";
const SPECIES = "ffffffff-0000-4000-8000-000000000520";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: USER, email: "tier@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

describe.skipIf(!url)("tier routes", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  const explain = { v: 1, group: "birds", rate: 0.2, records: 800, effort: 4_000_000, source: "gbif", base: "uncommon", steps: [{ kind: "nocturnal" }], guard: false, season: null };

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'tier@test', 'x')`, [USER]);
    await db.query(`INSERT INTO regions (id, name, external_codes) VALUES ($1, 'Tierland', '{ZZT}')`, [REGION]);
    await db.query(`INSERT INTO species (id, gbif_key, scientific_name, taxon_class) VALUES ($1, 915100, 'Tiera nocturna', 'aves')`, [SPECIES]);
    await db.query(
      `INSERT INTO region_species (region_id, species_id, local_tier, tier_reason, tier_explain) VALUES ($1, $2, 'rare', 'rated', $3)`,
      [REGION, SPECIES, JSON.stringify(explain)],
    );
    const { tierRoutes } = await import("./tierRoutes.js");
    app = Fastify();
    await app.register(async (api) => api.register(tierRoutes), { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
    await db.query(`DELETE FROM species WHERE id = $1`, [SPECIES]);
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("returns the local tier with its reasons", async () => {
    const res = await app.inject({ method: "GET", url: `/api/species/${SPECIES}/tier?regionId=${REGION}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().local).toMatchObject({ tier: "rare", reason: "rated", regionName: "Tierland", explain: { base: "uncommon" } });
    expect(res.json().override).toBeNull();
  });

  it("saves the user's own tier, prefers the region's over an everywhere one, and clears it", async () => {
    const put = (body: object) => app.inject({ method: "PUT", url: `/api/species/${SPECIES}/tier-override`, payload: body });
    expect((await put({ regionId: null, tier: "uncommon" })).statusCode).toBe(200);
    expect((await put({ regionId: REGION, tier: "common" })).statusCode).toBe(200);
    let got = (await app.inject({ method: "GET", url: `/api/species/${SPECIES}/tier?regionId=${REGION}` })).json();
    expect(got.override).toEqual({ tier: "common", everywhere: false });

    await put({ regionId: REGION, tier: null });
    got = (await app.inject({ method: "GET", url: `/api/species/${SPECIES}/tier?regionId=${REGION}` })).json();
    expect(got.override).toEqual({ tier: "uncommon", everywhere: true });

    const mythical = await put({ regionId: null, tier: "mythical" });
    expect([mythical.statusCode, mythical.json().code]).toEqual([400, "invalid_request"]);
    expect(mythical.json().error).toMatch(/^Invalid body: tier must be one of common, occasional/);
    expect((await put({ regionId: null, tier: "rare", note: "x" })).statusCode).toBe(400);
  });

  it("answers 404 for a malformed species or region id", async () => {
    const tier = (u: string) => app.inject({ method: "GET", url: `/api/species/${u}` });
    expect((await tier("nope/tier")).json()).toEqual({ error: "Species not found" });
    expect((await tier("nope/tier")).statusCode).toBe(404);
    expect((await tier(`${SPECIES}/tier?regionId=nope`)).statusCode).toBe(404);
    const put = await app.inject({ method: "PUT", url: `/api/species/${SPECIES}/tier-override`, payload: { regionId: "nope", tier: "common" } });
    expect(put.statusCode).toBe(404);
    expect(put.json()).toEqual({ error: "Region not found" });
  });
});
