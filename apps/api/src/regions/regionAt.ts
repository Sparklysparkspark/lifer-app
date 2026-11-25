import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { exteriorRingsFromGeometry, pointInRing, type BoundingBox, type Point } from "@lifer/core/lib/geometry.js";
import { requireAuth } from "../auth/session.js";
import { NEAR_KM, nearOutline, parseOutline } from "../collection/pinOutline.js";
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

// Only each outline's bounding boxes (migration 200) stay in memory, stamped like GET
// /regions/boundaries; the outlines themselves are read for the few regions whose box holds the point.
let boxesCache: { stamp: string; boxes: Promise<RegionBox[]> } | null = null;

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
  const res = await pool.query<{ id: string; name: string; outline_boxes: number[][] }>(
    `SELECT id::text AS id, name, outline_boxes FROM regions WHERE jsonb_array_length(outline_boxes) > 0`,
  );
  return res.rows.map((r) => ({
    id: r.id,
    name: r.name,
    depth: depthOf(r.id),
    boxes: r.outline_boxes.map(([minLon, minLat, maxLon, maxLat]) => ({ minLon, minLat, maxLon, maxLat })),
  }));
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

/** The region holding the point, else the most specific one whose outline is within NEAR_KM (a
 *  photo from a boat off the coast, as the Collection map counts it). Never a guess further out. */
export async function regionNear(lat: number, lon: number): Promise<{ id: string; name: string } | null> {
  const inside = await regionAt(lat, lon);
  if (inside) return inside;
  // A box grown by NEAR_KM picks the few outlines worth reading; nearOutline measures exactly.
  // shortcut: a box isn't grown across the antimeridian, fine until a Fiji coast photo misses.
  const dLat = NEAR_KM / 111;
  const dLon = dLat / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const candidates = (await regionBoxes())
    .filter((r) =>
      r.boxes.some((b) =>
        inBox(lat, lon, {
          minLon: b.minLon - dLon,
          maxLon: b.maxLon + dLon,
          minLat: b.minLat - dLat,
          maxLat: b.maxLat + dLat,
        }),
      ),
    )
    .sort((a, b) => b.depth - a.depth);
  for (const c of candidates) {
    const res = await pool.query<{ boundary_geojson: unknown }>(`SELECT boundary_geojson FROM regions WHERE id = $1`, [
      c.id,
    ]);
    const outline = parseOutline(res.rows[0]?.boundary_geojson);
    if (outline && nearOutline(outline, lon, lat)) return { id: c.id, name: c.name };
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
