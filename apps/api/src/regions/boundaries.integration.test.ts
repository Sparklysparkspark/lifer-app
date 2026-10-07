// Runs only with TEST_DATABASE_URL pointing at a migrated, disposable database:
//   TEST_DATABASE_URL=postgres://lifer@127.0.0.1:55432/lifer npx vitest run boundaries
// GET /regions/boundaries is served from a cache with an ETag, and rebuilt when a country changes.
import Fastify, { type FastifyInstance } from "fastify";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
});

const url = process.env.TEST_DATABASE_URL;
const REGION = "ffffffff-0000-4000-8000-0000000004b1";

vi.mock("../auth/session.js", () => {
  const asUser = async (request: { user?: unknown }) => {
    request.user = { id: "ffffffff-0000-4000-8000-000000000411", email: "b@test" };
  };
  return { requireAuth: asUser, requireScope: () => asUser };
});

const square = (n: number) => {
  // A dense ring: 200 points along each edge of a 1 degree square, all but the corners removable.
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) pts.push([i / n, 0]);
  for (let i = 0; i < n; i++) pts.push([1, i / n]);
  for (let i = 0; i < n; i++) pts.push([1 - i / n, 1]);
  for (let i = 0; i < n; i++) pts.push([0, 1 - i / n]);
  pts.push([0, 0]);
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [pts] } };
};

describe.skipIf(!url)("GET /regions/boundaries", () => {
  let app: FastifyInstance;
  let db: pg.Pool;

  beforeAll(async () => {
    db = new pg.Pool({ connectionString: url });
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.query(`INSERT INTO regions (id, name, external_codes, boundary_geojson) VALUES ($1, 'Zzboundary', '{ZZB}', $2)`, [REGION, JSON.stringify(square(200))]);
    const { regionRoutes } = await import("./routes.js");
    app = Fastify();
    await app.register(regionRoutes, { prefix: "/api" });
    await app.ready();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await db.query(`DELETE FROM regions WHERE id = $1`, [REGION]);
    await db.end();
    const { pool } = await import("@lifer/core/db.js");
    await pool.end();
  });

  it("simplifies, caches, and answers 304 until a country changes", async () => {
    const first = await app.inject({ method: "GET", url: "/api/regions/boundaries?level=country" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["cache-control"]).toBe("private, max-age=3600");
    const etag = first.headers.etag as string;
    const mine = first.json().regions.find((r: { id: string }) => r.id === REGION);
    expect(mine.name).toBe("Zzboundary");
    expect(mine.parentId).toBeNull();
    expect(mine.boundaryGeoJson.geometry.coordinates[0].length).toBe(5);

    const again = await app.inject({ method: "GET", url: "/api/regions/boundaries?level=country", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);

    await db.query(`UPDATE regions SET name = 'Zzboundary Renamed' WHERE id = $1`, [REGION]);
    const changed = await app.inject({ method: "GET", url: "/api/regions/boundaries?level=country", headers: { "if-none-match": etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().regions.find((r: { id: string }) => r.id === REGION).name).toBe("Zzboundary Renamed");
  }, 120_000);

  it("answers 404 for a malformed region id", async () => {
    for (const u of ["/regions/nope/photographed-taxa", "/regions/nope/species", "/regions/nope/hidden-species", `/regions/nope/species/${REGION}/hidden-children`]) {
      const res = await app.inject({ method: "GET", url: `/api${u}` });
      expect(res.statusCode, u).toBe(404);
      expect(res.json()).toEqual({ error: "Region not found" });
    }
  });

  it("refuses malformed ids in the query string", async () => {
    expect((await app.inject({ method: "GET", url: "/api/regions/taxon-presence?regionIds=nope" })).statusCode).toBe(400);
    const zones = await app.inject({ method: "GET", url: `/api/regions/${REGION}/species?seaZoneIds=nope` });
    expect(zones.statusCode).toBe(404);
    expect(zones.json()).toEqual({ error: "Sea zone not found" });
  });
});
