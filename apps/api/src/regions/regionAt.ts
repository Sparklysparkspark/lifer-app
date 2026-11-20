import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import {
  exteriorRingsFromGeometry,
  pointInRing,
  ringBoundingBox,
  type BoundingBox,
  type Point,
} from "@lifer/core/lib/geometry.js";
import { requireAuth } from "../auth/session.js";
import { Nullable, Uuid, replies, withSchemas } from "../lib/schema.js";

interface RegionBox {
  id: string;
  name: string;
  depth: number;
  boxes: BoundingBox[];
}

type Geometry = { type: string; coordinates: unknown };
const geometryOf = (g: unknown) =>
  (g && typeof g === "object" && "geometry" in g ? (g as { geometry: unknown }).geometry : g) as Geometry | null;

// Only each outline's bounding boxes stay in memory, stamped like GET /regions/boundaries; the
// outlines themselves are read for the few regions whose box holds the point.
let boxesCache: { stamp: string; boxes: Promise<RegionBox[]> } | null = null;
const PAGE = 50;

async function regionBoxes(): Promise<RegionBox[]> {
  const stampRes = await pool.query<{ stamp: string }>(
    `SELECT count(*)::text || ':' || COALESCE(sum(xmin::text::bigint), 0)::text AS stamp FROM regions`,
  );
  const stamp = stampRes.rows[0].stamp;
  if (boxesCache?.stamp !== stamp) {
    boxesCache = { stamp, boxes: loadBoxes() };
    boxesCache.boxes.catch(() => (boxesCache = null));
  }
  return boxesCache.boxes;
}

async function loadBoxes(): Promise<RegionBox[]> {
  const parents = await pool.query<{ id: string; parent_id: string | null }>(`SELECT id, parent_id FROM regions`);
  const parentOf = new Map(parents.rows.map((r) => [r.id, r.parent_id]));
  const depthOf = (id: string) => {
    let depth = 0;
    for (let p = parentOf.get(id); p && depth < 10; p = parentOf.get(p)) depth++;
    return depth;
  };
  const out: RegionBox[] = [];
  // A page at a time, so every outline is never parsed at once.
  for (let after = ""; ;) {
    const res = await pool.query<{ id: string; name: string; boundary_geojson: unknown }>(
      `SELECT id::text AS id, name, boundary_geojson FROM regions
        WHERE boundary_geojson IS NOT NULL AND id::text > $1 ORDER BY id::text LIMIT ${PAGE}`,
      [after],
    );
    for (const r of res.rows) {
      const geometry = geometryOf(r.boundary_geojson);
      if (!geometry?.type) continue;
      const boxes = exteriorRingsFromGeometry(geometry).map(ringBoundingBox);
      if (boxes.length > 0) out.push({ id: r.id, name: r.name, depth: depthOf(r.id), boxes });
    }
    if (res.rows.length < PAGE) return out;
    after = res.rows[res.rows.length - 1].id;
  }
}

const inBox = (lat: number, lon: number, b: BoundingBox) =>
  lon >= b.minLon && lon <= b.maxLon && lat >= b.minLat && lat <= b.maxLat;

/** The most specific region (a province before its country) whose outline holds the point. */
export async function regionAt(lat: number, lon: number): Promise<{ id: string; name: string } | null> {
  const candidates = (await regionBoxes())
    .filter((r) => r.boxes.some((b) => inBox(lat, lon, b)))
    .sort((a, b) => b.depth - a.depth);
  for (const c of candidates) {
    const res = await pool.query<{ boundary_geojson: unknown }>(`SELECT boundary_geojson FROM regions WHERE id = $1`, [
      c.id,
    ]);
    const geometry = geometryOf(res.rows[0]?.boundary_geojson);
    if (geometry?.type && exteriorRingsFromGeometry(geometry).some((ring) => pointInRing([lon, lat] as Point, ring)))
      return { id: c.id, name: c.name };
  }
  return null;
}

/** Of these regions, the ones whose outline doesn't hold the point (no outline: not listed). */
export async function regionsNotHolding(regionIds: string[], lat: number, lon: number): Promise<string[]> {
  if (regionIds.length === 0) return [];
  const res = await pool.query<{ id: string; boundary_geojson: unknown }>(
    `SELECT id, boundary_geojson FROM regions WHERE id = ANY($1::uuid[])`,
    [regionIds],
  );
  return res.rows
    .filter((r) => {
      const geometry = geometryOf(r.boundary_geojson);
      return (
        !!geometry?.type && !exteriorRingsFromGeometry(geometry).some((ring) => pointInRing([lon, lat] as Point, ring))
      );
    })
    .map((r) => r.id);
}

export async function regionAtRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // A suggestion for a photo given coordinates; the user decides whether to set it.
  app.get(
    "/regions/at",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          lat: Type.Number({ minimum: -90, maximum: 90 }),
          lon: Type.Number({ minimum: -180, maximum: 180 }),
          within: Type.Optional(
            Type.Array(Uuid(), { maxItems: 500, description: "Also list which of these regions don't hold the point" }),
          ),
        }),
        response: replies(
          Type.Object({
            region: Nullable(Type.Object({ id: Uuid(), name: Type.String() })),
            outside: Type.Optional(
              Type.Array(Uuid(), { description: "With within: the ones whose outline doesn't hold the point" }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const { lat, lon, within } = request.query;
      const region = await regionAt(lat, lon);
      return within ? { region, outside: await regionsNotHolding(within, lat, lon) } : { region };
    },
  );
}
