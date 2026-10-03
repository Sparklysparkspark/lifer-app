import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { simplifyRing, type Point } from "data-pipeline/src/geometry.js";

// USG (the Guantanamo Bay naval base) is left out, as in GET /regions.
const COUNTRY_BOUNDARY_WHERE = `external_codes IS NOT NULL AND array_length(external_codes, 1) > 0
  AND external_codes[1] ~ '^[A-Z]{3}$' AND external_codes[1] != 'USG' AND boundary_geojson IS NOT NULL`;

// ~0.01 degrees is about 1 km, invisible at the packs map's country zoom, and shrinks the payload
// several times over. Done in JS since the desktop has no PostGIS.
const BOUNDARY_SIMPLIFY_DEGREES = 0.01;

function simplifyPolygonRings(rings: Point[][]): Point[][] {
  return rings.map((ring) => {
    const simplified = simplifyRing(ring, BOUNDARY_SIMPLIFY_DEGREES);
    // A tiny island collapses below a valid ring; keep it as it was.
    return (simplified.length >= 4 ? simplified : ring).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4] as Point);
  });
}

export function simplifyBoundaryFeature(feature: unknown): unknown {
  const f = feature as { geometry?: { type?: string; coordinates?: unknown } } | null;
  const g = f?.geometry;
  if (!g || !Array.isArray(g.coordinates)) return feature;
  if (g.type === "Polygon") {
    return { ...f, geometry: { ...g, coordinates: simplifyPolygonRings(g.coordinates as Point[][]) } };
  }
  if (g.type === "MultiPolygon") {
    return { ...f, geometry: { ...g, coordinates: (g.coordinates as Point[][][]).map(simplifyPolygonRings) } };
  }
  return feature;
}

// Serialized once and reused until a country row changes. The stamp (row count plus the sum of
// each row's xmin, which changes on every insert, update or delete) is cheap because it never
// reads the TOASTed geometry. The body is read after the stamp, so it is never older than it.
let boundariesCache: { stamp: string; body: string; etag: string } | null = null;

async function countryBoundariesBody(): Promise<{ body: string; etag: string }> {
  const stampRes = await pool.query<{ stamp: string }>(
    `SELECT count(*)::text || ':' || COALESCE(sum(xmin::text::bigint), 0)::text AS stamp FROM regions WHERE ${COUNTRY_BOUNDARY_WHERE}`,
  );
  const stamp = stampRes.rows[0].stamp;
  if (boundariesCache?.stamp === stamp) return boundariesCache;
  const res = await pool.query<{ id: string; name: string; parent_id: string | null; boundary_geojson: unknown }>(
    `SELECT id, name, parent_id, boundary_geojson FROM regions WHERE ${COUNTRY_BOUNDARY_WHERE}`,
  );
  const body = JSON.stringify({
    regions: res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      parentId: r.parent_id,
      boundaryGeoJson: simplifyBoundaryFeature(r.boundary_geojson),
    })),
  });
  const etag = `W/"b-${createHash("sha1").update(body).digest("base64url").slice(0, 22)}"`;
  boundariesCache = { stamp, body, etag };
  return boundariesCache;
}

export async function regionBoundaryRoutes(app: FastifyInstance): Promise<void> {
  // Every country's outline at once, for the offline packs map. GET /regions leaves boundaries
  // out, so this is the one place that sends them all.
  app.get<{ Querystring: { level?: string } }>("/regions/boundaries", { preHandler: requireAuth }, async (request, reply) => {
    if (request.query.level && request.query.level !== "country") {
      return reply.code(400).send({ error: 'only level=country is supported' });
    }
    const cached = await countryBoundariesBody();
    reply.header("ETag", cached.etag);
    reply.header("Cache-Control", "private, max-age=3600");
    const inm = request.headers["if-none-match"];
    if (inm && inm.split(",").some((t) => t.trim() === cached.etag)) return reply.code(304).send();
    return reply.type("application/json; charset=utf-8").send(cached.body);
  });
}
