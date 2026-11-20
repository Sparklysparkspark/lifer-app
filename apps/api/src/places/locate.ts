// Finds a place without the internet, for putting photos on the map. With a search: the user's
// saved spots first, then regions (by name or alias) at the centre of their outline, then towns
// from the offline town list (places/gazetteer.ts; none until the catalog has it). With none:
// the user's places in groups (Nearby, Recent, then All A to Z in pages). `near` is the photos'
// point; it's a local parameter and never leaves the computer.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { Nullable, Open, Uuid, replies, withSchemas } from "../lib/schema.js";
import { NEARBY_METRES } from "./savedSpots.js";
import { searchTowns } from "./gazetteer.js";

const LIMIT = 8;
const TOWN_LIMIT = 5;
const GROUP_LIMIT = 5;
const PAGE = 50;
const NEARBY_KM = 50;
const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

const Found = Open({
  kind: Type.Union([Type.Literal("spot"), Type.Literal("region"), Type.Literal("town")], {
    description: "town: from the offline town list, listed after spots and regions",
  }),
  id: Type.String({ description: "A spot's or region's uuid; a town's GeoNames id" }),
  name: Type.String(),
  detail: Nullable(
    Type.String({
      description: "The region a spot is in, the country a region is part of, or a town's province and country",
    }),
  ),
  lat: Type.Number(),
  lon: Type.Number(),
  regionId: Nullable(Uuid()),
  bbox: Nullable(
    Type.Array(Type.Number(), {
      minItems: 4,
      maxItems: 4,
      description: "A region's outline box: west,south,east,north",
    }),
  ),
  group: Nullable(Type.Union([Type.Literal("nearby"), Type.Literal("recent"), Type.Literal("all")])),
  locality: Nullable(Type.String({ description: "A spot's locality; a town's \"Town, Province, Country\"" })),
  geoprivacy: Nullable(Type.Union([Type.Literal("open"), Type.Literal("obscured"), Type.Literal("private")])),
  radiusM: Nullable(Type.Integer()),
  distanceM: Nullable(Type.Number({ description: "From `near`, when given (spots and towns)" })),
  recognised: Type.Boolean({ description: "`near` is inside the spot, or within 150 m of a small one" }),
});

// Metres from ($2, $3) to the spot s; NULL without a point.
const DIST = `CASE WHEN $2::float8 IS NULL THEN NULL ELSE 6371000 * 2 * asin(sqrt(
    power(sin(radians(s.lat::float8 - $2::float8) / 2), 2) +
    cos(radians($2::float8)) * cos(radians(s.lat::float8)) *
    power(sin(radians(s.lon::float8 - $3::float8) / 2), 2))) END`;
const SPOT_COLUMNS = `s.id, s.name, s.lat::float8 AS lat, s.lon::float8 AS lon, s.region_id, r.name AS detail,
  s.locality, s.geoprivacy, s.radius_m, ${DIST} AS distance_m,
  COALESCE(${DIST} <= greatest(s.radius_m, ${NEARBY_METRES}), false) AS recognised`;
const SPOTS_FROM = `FROM saved_spots s LEFT JOIN regions r ON r.id = s.region_id WHERE s.user_id = $1`;

interface SpotRow {
  id: string;
  name: string;
  lat: number;
  lon: number;
  region_id: string | null;
  detail: string | null;
  locality: string | null;
  geoprivacy: "open" | "obscured" | "private";
  radius_m: number;
  distance_m: number | null;
  recognised: boolean;
}
const toFound = (group: "nearby" | "recent" | "all" | null) => (r: SpotRow) => ({
  kind: "spot" as const,
  id: r.id,
  name: r.name,
  detail: r.detail,
  lat: r.lat,
  lon: r.lon,
  regionId: r.region_id,
  bbox: null,
  group,
  locality: r.locality,
  geoprivacy: r.geoprivacy,
  radiusM: r.radius_m,
  distanceM: r.distance_m,
  recognised: r.recognised,
});

export async function locateRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/places/locate",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          q: Type.Optional(Type.String({ maxLength: 200 })),
          near: Type.Optional(
            Type.String({ pattern: "^-?\\d+(\\.\\d+)?,-?\\d+(\\.\\d+)?$", description: "lat,lon of the photos" }),
          ),
          offset: Type.Optional(
            Type.Integer({ minimum: 0, description: "With no search: the next page of All places only" }),
          ),
        }),
        response: replies(
          Open({ places: Type.Array(Found), nextOffset: Nullable(Type.Integer({ description: "More in All" })) }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const q = request.query.q?.trim() ?? "";
      const [nearLat, nearLon] = request.query.near ? request.query.near.split(",").map(Number) : [null, null];
      const at = [userId, nearLat, nearLon];

      if (!q) {
        // Nearby (recognised first), then Recent and All without repeating them.
        const nearby =
          nearLat === null
            ? { rows: [] as SpotRow[] }
            : await pool.query<SpotRow>(
                `SELECT ${SPOT_COLUMNS} ${SPOTS_FROM} AND ${DIST} <= ${NEARBY_KM * 1000}
           ORDER BY recognised DESC, distance_m, lower(s.name) LIMIT ${GROUP_LIMIT}`,
                at,
              );
        const recent = await pool.query<SpotRow>(
          `SELECT ${SPOT_COLUMNS} ${SPOTS_FROM} AND s.last_used_at IS NOT NULL AND NOT (s.id = ANY($4::uuid[]))
           ORDER BY s.last_used_at DESC LIMIT ${GROUP_LIMIT}`,
          [...at, nearby.rows.map((r) => r.id)],
        );
        const shown = [...nearby.rows, ...recent.rows].map((r) => r.id);
        const offset = request.query.offset ?? 0;
        const all = await pool.query<SpotRow>(
          `SELECT ${SPOT_COLUMNS} ${SPOTS_FROM} AND NOT (s.id = ANY($4::uuid[]))
           ORDER BY lower(s.name), s.id LIMIT ${PAGE + 1} OFFSET $5`,
          [...at, shown, offset],
        );
        const page = all.rows.slice(0, PAGE).map(toFound("all"));
        const places =
          offset > 0 ? page : [...nearby.rows.map(toFound("nearby")), ...recent.rows.map(toFound("recent")), ...page];
        return { places, nextOffset: all.rows.length > PAGE ? offset + PAGE : null };
      }

      const like = `%${escapeLike(q)}%`;
      const spots = await pool.query<SpotRow>(
        `SELECT ${SPOT_COLUMNS} ${SPOTS_FROM} AND s.name ILIKE $4
         ORDER BY s.name ILIKE $5 DESC, recognised DESC, distance_m NULLS LAST, length(s.name), s.name LIMIT ${LIMIT}`,
        [...at, like, like.slice(1)],
      );
      // The centre of the outline's bounding box: close enough to start from, and the user can refine it.
      const regions = await pool.query(
        `SELECT r.id, r.name, p.name AS detail, r.boundary_geojson->'bbox' AS bbox,
                (((r.boundary_geojson->'bbox'->>1)::float8 + (r.boundary_geojson->'bbox'->>3)::float8) / 2) AS lat,
                (((r.boundary_geojson->'bbox'->>0)::float8 + (r.boundary_geojson->'bbox'->>2)::float8) / 2) AS lon
         FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
         WHERE jsonb_array_length(COALESCE(r.boundary_geojson->'bbox', '[]'::jsonb)) = 4
           AND (r.name ILIKE $1 OR EXISTS (SELECT 1 FROM unnest(r.aliases) a WHERE a ILIKE $1))
         ORDER BY r.name ILIKE $2 DESC, length(r.name), r.name LIMIT ${LIMIT}`,
        [like, like.slice(1)],
      );
      const towns = await searchTowns(q, nearLat === null ? null : { lat: nearLat, lon: nearLon! }, TOWN_LIMIT);
      return {
        places: [
          ...[
            ...spots.rows.map(toFound(null)),
            ...regions.rows.map((r) => ({
              kind: "region" as const,
              id: r.id,
              name: r.name,
              detail: r.detail,
              lat: r.lat,
              lon: r.lon,
              regionId: r.id,
              bbox: r.bbox,
              group: null,
              locality: null,
              geoprivacy: null,
              radiusM: null,
              distanceM: null,
              recognised: false,
            })),
          ].slice(0, LIMIT),
          ...towns.map((t) => ({
            kind: "town" as const,
            id: String(t.geonameId),
            name: t.name,
            detail: t.detail,
            lat: t.lat,
            lon: t.lon,
            regionId: t.regionId,
            bbox: null,
            group: null,
            locality: t.locality,
            geoprivacy: null,
            radiusM: null,
            distanceM: t.distanceM,
            recognised: false,
          })),
        ],
        nextOffset: null,
      };
    },
  );
}
