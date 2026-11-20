// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database (it adds and removes
// its own rows). Lifer works offline: with every remote index unreachable, the screens that show
// what's installed (Collection, region tree, a region's species, the downloads list) still do.
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const USER = "eeeeeeee-0000-4000-8000-000000000581";
const TOKEN = "lifer_test_offline_app_581";
const PACK = "test-offline-app-canada-aves";
const NAMES = { world: "Offline Test World", continent: "Offline Test Continent", country: "Offline Test Country" };
const SPECIES = "Offlinea testis";
// A reference photo keeps it out of "species almost nobody photographs".
const PHOTO = "https://packs.invalid/offlinea.jpg";
const appData = mkdtempSync(path.join(os.tmpdir(), "lifer-offline-app-"));

// The list answers at once and refreshes in the background; this waits for that refresh to end.
async function refreshSettled(): Promise<void> {
  const { packIndexRemoteState } = await import("./index.js");
  while (packIndexRemoteState().refreshing) await new Promise((r) => setTimeout(r, 50));
}

describe.skipIf(!url)("Lifer with the published indexes unreachable", () => {
  let app: FastifyInstance;
  let db: pg.Pool;
  let cookieName: string;
  const ids: Record<string, string> = {};
  // A host with no DNS answer: the one case Lifer calls offline.
  const fetchMock = vi.fn(async () => {
    throw new Error("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
  });
  const get = (route: string) => app.inject({ method: "GET", url: route, cookies: { [cookieName]: TOKEN } });

  async function cleanup() {
    await db.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [PACK]);
    await db.query(
      `DELETE FROM region_species WHERE species_id IN (SELECT id FROM species WHERE scientific_name = $1)`,
      [SPECIES],
    );
    await db.query(`DELETE FROM regions WHERE name = $1`, [NAMES.country]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [NAMES.continent]);
    await db.query(`DELETE FROM regions WHERE name = $1`, [NAMES.world]);
    await db.query(`DELETE FROM species WHERE scientific_name = $1`, [SPECIES]);
    await db.query(`DELETE FROM users WHERE id = $1`, [USER]);
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.SINGLE_USER_MODE = "0";
    process.env.APP_DATA_DIR = appData;
    process.env.PACK_INDEX_URL = "https://packs.invalid/pack-index.json";
    process.env.CATALOG_MANIFEST_URL = "https://packs.invalid/catalog-manifest.json";
    vi.stubGlobal("fetch", fetchMock);
    db = new pg.Pool({ connectionString: url });
    const { hashToken } = await import("../auth/session.js");
    ({ SESSION_COOKIE_NAME: cookieName } = await import("@lifer/core/config.js"));
    const { installSchemas } = await import("../lib/schema.js");
    const { apiRoutes } = await import("../apiRoutes.js");

    await cleanup();
    await db.query(`INSERT INTO users (id, email, password_hash) VALUES ($1, 'offline-app@test', 'x')`, [USER]);
    await db.query(`INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [
      hashToken(TOKEN),
      USER,
    ]);
    const species = await db.query<{ id: string }>(
      `INSERT INTO species (gbif_key, scientific_name, common_name, taxon_class, family, taxon_order, sort_order, reference_photo, reference_credit, reference_license)
       VALUES (980000581, $1, 'Offline Test Bird', 'aves', 'Testidae', 'Testiformes', 1, $2, 'Test', 'cc0') RETURNING id`,
      [SPECIES, PHOTO],
    );
    const world = await db.query<{ id: string }>(
      `INSERT INTO regions (name, has_children) VALUES ($1, true) RETURNING id`,
      [NAMES.world],
    );
    const continent = await db.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, has_children) VALUES ($1, $2, true) RETURNING id`,
      [NAMES.continent, world.rows[0].id],
    );
    const country = await db.query<{ id: string }>(
      `INSERT INTO regions (name, parent_id, external_codes, occurrence_computed_at)
       VALUES ($1, $2, '{OT}', now()) RETURNING id`,
      [NAMES.country, continent.rows[0].id],
    );
    ids.continent = continent.rows[0].id;
    ids.country = country.rows[0].id;
    await db.query(`INSERT INTO region_species (region_id, species_id, local_tier) VALUES ($1, $2, 'common')`, [
      ids.country,
      species.rows[0].id,
    ]);
    await db.query(
      `INSERT INTO downloaded_packs (pack_id, content_version, region, taxon, species_count, bytes)
       VALUES ($1, 'v1', $2, 'aves', 1, 1000)`,
      [PACK, NAMES.country],
    );

    app = Fastify();
    await app.register(cookie);
    installSchemas(app);
    await app.register(apiRoutes, { prefix: "/api" });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await cleanup();
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
    vi.unstubAllGlobals();
    rmSync(appData, { recursive: true, force: true });
  });

  it("lists the installed pack, flagged offline, with no update banner", async () => {
    expect((await get("/api/offline-packs/index")).statusCode).toBe(200);
    await refreshSettled();
    const index = await get("/api/offline-packs/index");
    expect(index.statusCode).toBe(200);
    expect(index.json().indexUnavailable).toBe(true);
    expect(index.json().remote).toBe("offline");
    expect(index.json().packs).toContainEqual(
      expect.objectContaining({ id: PACK, region: NAMES.country, downloaded: true }),
    );
    const updates = await get("/api/offline-packs/updates-summary");
    expect(updates.statusCode).toBe(200);
    expect(updates.json().updateCount).toBe(0);
  }, 60_000);

  it("with no index and no way to the host, refuses a new download only after trying, and says why", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/offline-packs/download-batch",
      cookies: { [cookieName]: TOKEN },
      payload: { regionNames: [NAMES.country], taxa: ["mammalia"] },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ code: "pack_index_unavailable", error: expect.stringMatching(/^Can't reach/) });
  }, 30_000);

  it("still shows the region tree and the installed country's species", async () => {
    const regions = (await get("/api/regions")).json() as { regions: Array<{ id: string }> };
    expect(regions.regions.map((r) => r.id)).toContain(ids.country);
    const species = await get(`/api/regions/${ids.country}/species`);
    expect(species.statusCode).toBe(200);
    expect(JSON.stringify(species.json())).toContain(SPECIES);
    const hub = await get(`/api/regions/${ids.continent}/aggregate-species`);
    expect(hub.statusCode).toBe(200);
    expect(JSON.stringify(hub.json())).toContain(SPECIES);
    expect((await get("/api/collection")).statusCode).toBe(200);
  });
});
