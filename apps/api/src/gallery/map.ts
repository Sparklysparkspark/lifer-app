// The Gallery's map view: how many of the filtered photos are in each region, and where the ones
// with coordinates are, aggregated on a grid so a 100k-photo library stays a small payload.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { replies, Uuid, withSchemas, Nullable } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import {
  GALLERY_ITEM_JOINS,
  GalleryFilterQuery,
  galleryCapturesSource,
  galleryFilterSql,
  galleryFiltersFor,
} from "./routes.js";
import { unplacedRoutes } from "./unplaced.js";
import { sensitiveForKey } from "../companion/privacy.js";
import { SPOTS_CTE, SPOT_OF_PHOTO } from "../places/spotArea.js";

/** Most grid cells sent; past it the grid coarsens a decimal place at a time. */
export const MAP_CELL_CAP = 20_000;
// 3 decimals is about 100 m: bursts and repeats from one spot share a cell.
const FINEST_PRECISION = 3;

type Ring = Array<[number, number]>;

/** The centre of a region's largest outline (an area-weighted polygon centroid), as [lat, lon]. */
export function boundaryCentroid(geojson: unknown): [number, number] | null {
  const g = (geojson as { geometry?: { type?: string; coordinates?: unknown } } | null)?.geometry;
  if (!g || !Array.isArray(g.coordinates)) return null;
  const rings: Ring[] =
    g.type === "Polygon"
      ? [(g.coordinates as Ring[])[0]]
      : g.type === "MultiPolygon"
        ? (g.coordinates as Ring[][]).map((p) => p[0])
        : [];
  let best: { area: number; lat: number; lon: number } | null = null;
  for (const ring of rings) {
    if (!ring || ring.length < 3) continue;
    let a = 0;
    let cx = 0;
    let cy = 0;
    for (let i = 0; i < ring.length; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[(i + 1) % ring.length];
      const cross = x0 * y1 - x1 * y0;
      a += cross;
      cx += (x0 + x1) * cross;
      cy += (y0 + y1) * cross;
    }
    if (a === 0) continue;
    const area = Math.abs(a / 2);
    if (!best || area > best.area) best = { area, lon: cx / (3 * a), lat: cy / (3 * a) };
  }
  return best ? [Math.round(best.lat * 1e4) / 1e4, Math.round(best.lon * 1e4) / 1e4] : null;
}

// Region outlines only change with a catalog update, which keeps region ids, so a centroid is
// worked out once per process.
const centroidCache = new Map<string, [number, number] | null>();

async function centroids(ids: string[]): Promise<Map<string, [number, number] | null>> {
  const missing = ids.filter((id) => !centroidCache.has(id));
  if (missing.length > 0) {
    const res = await pool.query<{ id: string; boundary_geojson: unknown }>(
      `SELECT id, boundary_geojson FROM regions WHERE id = ANY($1::uuid[])`,
      [missing],
    );
    for (const r of res.rows) centroidCache.set(r.id, boundaryCentroid(r.boundary_geojson));
  }
  return new Map(ids.map((id) => [id, centroidCache.get(id) ?? null]));
}

const MapRegion = Type.Object({
  id: Uuid(),
  name: Type.String(),
  parentId: Nullable(Uuid()),
  kind: Type.Enum(["country", "province"], {
    description: "A country, or a region inside one (a province, state or group of them)",
  }),
  count: Type.Integer({ description: "Photos in the region and everything inside it" }),
  ownCount: Type.Integer({ description: "Photos set to exactly this region" }),
  regionOnlyCount: Type.Integer({ description: "Of ownCount, the ones with no coordinates" }),
  lat: Nullable(Type.Number({ description: "Centre of the region's outline" })),
  lon: Nullable(Type.Number()),
});

const MapCell = Type.Object({
  lat: Type.Number(),
  lon: Type.Number(),
  count: Type.Integer(),
  photoId: Uuid({ description: "One of the cell's photos, the best rated" }),
  taxonClass: Nullable(Type.String({ description: "Taxon class most of the cell's photos are of" })),
  iconicTaxon: Nullable(Type.String({ description: "iNaturalist iconic taxon of that majority, for other taxa" })),
});

const PhotoMap = Type.Object({
  total: Type.Integer({ description: "Photos the filters match" }),
  withoutCoordinates: Type.Integer({ description: "Photos that need placing: no coordinates, whatever the region" }),
  regionOnly: Type.Integer({ description: "Of withoutCoordinates, the ones with a region" }),
  withoutRegion: Type.Integer(),
  regions: Type.Array(MapRegion),
  cells: Type.Array(MapCell),
  gridDegrees: Type.Number({ description: "Width of a grid cell; a cell covers its lat/lon plus or minus half of it" }),
  truncated: Type.Boolean({ description: "The grid was coarsened, or cut at the cap, to keep the reply small" }),
  places: Type.Array(
    Type.Object({
      spotId: Uuid(),
      count: Type.Integer({ description: "Photos whose point is inside the place; they're left out of cells" }),
      photoId: Uuid({ description: "One of them, the best rated" }),
    }),
  ),
});

interface RegionRow {
  id: string;
  name: string;
  parent_id: string | null;
  home_country_id: string | null;
  code: string | null;
}

export async function galleryMapRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  await app.register(unplacedRoutes);
  app.get(
    "/gallery/map",
    {
      preValidation: requireScope("gallery.read"),
      schema: { querystring: GalleryFilterQuery, response: replies(PhotoMap) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const filters = await galleryFiltersFor(request.query, userId);
      if ("error" in filters) return reply.code(400).send({ error: filters.error });
      const params: unknown[] = [userId];
      const param = (v: unknown) => {
        params.push(v);
        return `$${params.length}`;
      };
      const from = `FROM ${galleryCapturesSource(filters)} c ${GALLERY_ITEM_JOINS}
        WHERE c.user_id = $1 ${galleryFilterSql(filters, param)}`;
      let placed = "c.lat IS NOT NULL AND c.lon IS NOT NULL";
      if (request.apiKeyName !== undefined) {
        // An API key gets a sensitive species' photos by region only, as a share would.
        // shortcut: checks every located photo in memory; move the rule into SQL if key maps get slow.
        const located = await pool.query<{ capture_id: string; species_id: string; region_id: string | null }>(
          `SELECT c.id AS capture_id, c.species_id, c.region_id ${from} AND ${placed}`,
          params,
        );
        const hidden = (await sensitiveForKey(request, located.rows)) ?? new Set<string>();
        placed += ` AND c.id <> ALL(${param([...hidden])}::uuid[])`;
      }

      const [byRegion, precisions] = await Promise.all([
        pool.query<{ region_id: string | null; n: number; no_coords: number }>(
          `SELECT c.region_id, count(*)::int AS n,
                  count(*) FILTER (WHERE NOT (${placed}))::int AS no_coords
           ${from} GROUP BY c.region_id`,
          params,
        ),
        // How many cells each grid would need, in one pass, to pick the finest that fits the cap.
        pool.query<Record<string, number>>(
          `WITH ${SPOTS_CTE} SELECT ${[3, 2, 1, 0].map((d) => `count(DISTINCT (round(c.lat, ${d}), round(c.lon, ${d})))::int AS p${d}`).join(", ")}
           ${from} AND ${placed} AND ${SPOT_OF_PHOTO} IS NULL`,
          params,
        ),
      ]);
      // A place's photos are one mark with its name, at every zoom, however they got their point.
      const placesRes = await pool.query<{ spot_id: string; n: number; photo_id: string }>(
        `WITH ${SPOTS_CTE}
         SELECT x.spot_id, count(*)::int AS n,
                (array_agg(x.photo_id ORDER BY x.rating DESC NULLS LAST, x.taken_at DESC NULLS LAST))[1] AS photo_id
         FROM (SELECT ${SPOT_OF_PHOTO} AS spot_id, p.id::text AS photo_id, c.quality_rating AS rating, c.taken_at
               ${from} AND ${placed}) x
         WHERE x.spot_id IS NOT NULL GROUP BY x.spot_id`,
        params,
      );
      const sizes = precisions.rows[0] ?? {};
      const precision = [3, 2, 1, 0].find((d) => (sizes[`p${d}`] ?? 0) <= MAP_CELL_CAP) ?? 0;
      const cellsRes = await pool.query<{ lat: number; lon: number; n: number; photo_id: string; top: string }>(
        `WITH ${SPOTS_CTE} SELECT round(c.lat, ${precision})::float8 AS lat, round(c.lon, ${precision})::float8 AS lon, count(*)::int AS n,
                (array_agg(p.id::text ORDER BY c.quality_rating DESC NULLS LAST, c.taken_at DESC NULLS LAST))[1] AS photo_id,
                mode() WITHIN GROUP (ORDER BY coalesce(s.taxon_class::text, '') || '|' || coalesce(s.inat_iconic_taxon, '')) AS top
         ${from} AND ${placed} AND ${SPOT_OF_PHOTO} IS NULL
         GROUP BY 1, 2 ORDER BY n DESC LIMIT ${MAP_CELL_CAP + 1}`,
        params,
      );

      let total = 0;
      let withoutCoordinates = 0;
      let withoutRegion = 0;
      let regionOnly = 0;
      const own = new Map<string, number>();
      const ownRegionOnly = new Map<string, number>();
      for (const r of byRegion.rows) {
        total += r.n;
        withoutCoordinates += r.no_coords;
        if (r.region_id) {
          own.set(r.region_id, r.n);
          ownRegionOnly.set(r.region_id, r.no_coords);
          regionOnly += r.no_coords;
        } else withoutRegion += r.n;
      }

      // Every region with photos plus what it sits in, by parent and by home country (a province
      // filed under its continent still belongs to its country).
      const tree = own.size
        ? (
            await pool.query<RegionRow>(
              `WITH RECURSIVE tree AS (
                 SELECT id, name, parent_id, home_country_id, external_codes[1] AS code FROM regions WHERE id = ANY($1::uuid[])
                 UNION
                 SELECT r.id, r.name, r.parent_id, r.home_country_id, r.external_codes[1]
                 FROM regions r JOIN tree t ON r.id = t.parent_id OR r.id = t.home_country_id
               )
               SELECT * FROM tree`,
              [[...own.keys()]],
            )
          ).rows
        : [];
      const byId = new Map(tree.map((r) => [r.id, r]));
      const isCountry = (r: RegionRow) => !!r.code && /^[A-Z]{3}$/.test(r.code) && r.code !== "USG";
      const ancestors = (id: string): RegionRow[] => {
        const seen = new Set<string>([id]);
        const out: RegionRow[] = [];
        const queue = [id];
        while (queue.length) {
          const r = byId.get(queue.shift()!);
          for (const next of [r?.parent_id, r?.home_country_id]) {
            if (!next || seen.has(next) || !byId.has(next)) continue;
            seen.add(next);
            out.push(byId.get(next)!);
            queue.push(next);
          }
        }
        return out;
      };
      const rolled = new Map<string, number>();
      const kinds = new Map<string, "country" | "province">();
      for (const r of tree) {
        const up = ancestors(r.id);
        if (isCountry(r)) kinds.set(r.id, "country");
        else if (up.some(isCountry)) kinds.set(r.id, "province");
      }
      for (const [id, n] of own) {
        for (const r of [byId.get(id), ...ancestors(id)]) if (r) rolled.set(r.id, (rolled.get(r.id) ?? 0) + n);
      }
      const shown = [...kinds.keys()];
      const centres = await centroids(shown);
      const regions = shown
        .map((id) => {
          const r = byId.get(id)!;
          const centre = centres.get(id);
          return {
            id,
            name: r.name,
            parentId: r.parent_id,
            kind: kinds.get(id)!,
            count: rolled.get(id) ?? 0,
            ownCount: own.get(id) ?? 0,
            regionOnlyCount: ownRegionOnly.get(id) ?? 0,
            lat: centre?.[0] ?? null,
            lon: centre?.[1] ?? null,
          };
        })
        .sort((a, b) => b.count - a.count);

      const cells = cellsRes.rows.slice(0, MAP_CELL_CAP);
      return {
        total,
        withoutCoordinates,
        regionOnly,
        withoutRegion,
        regions,
        cells: cells.map((c) => {
          const [taxonClass, iconicTaxon] = c.top.split("|");
          return {
            lat: c.lat,
            lon: c.lon,
            count: c.n,
            photoId: c.photo_id,
            taxonClass: taxonClass || null,
            iconicTaxon: iconicTaxon || null,
          };
        }),
        places: placesRes.rows.map((r) => ({ spotId: r.spot_id, count: r.n, photoId: r.photo_id })),
        gridDegrees: 10 ** -precision,
        truncated: precision < FINEST_PRECISION || cellsRes.rows.length > MAP_CELL_CAP,
      };
    },
  );
}
