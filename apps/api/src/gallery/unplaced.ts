// The map's "Needs placing" list: the filtered photos without coordinates, grouped the way they
// were shot. Trips first, then sessions: a gap over an hour starts a new one (the rule of
// lib/clusterEncounters.ts), as does a change of region or day, so region-only and
// no-location photos never share a group. Photos with no date go in chunks per trip and region.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { Nullable, Uuid, replies, withSchemas } from "../lib/schema.js";
import {
  GALLERY_ITEM_JOINS,
  GalleryFilterQuery,
  galleryCapturesSource,
  galleryFilterSql,
  galleryFiltersFor,
} from "./routes.js";

const SESSION_GAP = "1 hour";
const NO_DATE_CHUNK = 1000;
const PAGE = 50;
// A photo's time as whole microseconds, so a group's range round-trips through its key exactly.
const MICROS = (col: string) => `(extract(epoch FROM ${col}) * 1000000)::bigint`;

const UnplacedQuery = Type.Object({
  ...GalleryFilterQuery.properties,
  state: Type.Optional(
    Type.Enum(["all", "region", "none"], {
      description: "region: photos with only a region; none: photos with no location at all",
    }),
  ),
  cursor: Type.Optional(Type.String({ pattern: "^[0-9]{1,9}$", description: "nextCursor of the previous page" })),
});

const Group = Type.Object({
  key: Type.String({ description: "Pass to GET /gallery/map/unplaced/photos for the group's photos" }),
  tripId: Nullable(Uuid()),
  tripName: Nullable(Type.String()),
  tripCount: Type.Integer({ description: "Photos needing placement in the whole trip" }),
  regionId: Nullable(Uuid()),
  regionName: Nullable(Type.String()),
  count: Type.Integer(),
  coverPhotoIds: Type.Array(Uuid(), { description: "Up to four, best rated first" }),
  from: Nullable(Type.String({ format: "date-time" })),
  to: Nullable(Type.String({ format: "date-time" })),
});

interface Key {
  tripId: string | null;
  regionId: string | null;
  dated: boolean;
  from: string;
  to: string;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const KEY_RE = new RegExp(`^(${UUID})?~(${UUID})?~(?:t~(-?\\d{1,19})~(-?\\d{1,19})|n~(${UUID})~(${UUID}))$`);

export const groupKey = (k: Key) => `${k.tripId ?? ""}~${k.regionId ?? ""}~${k.dated ? "t" : "n"}~${k.from}~${k.to}`;

export function parseGroupKey(key: string): Key | null {
  const m = KEY_RE.exec(key);
  if (!m) return null;
  const dated = m[3] !== undefined;
  return {
    tripId: m[1] ?? null,
    regionId: m[2] ?? null,
    dated,
    from: dated ? m[3] : m[5],
    to: dated ? m[4] : m[6],
  };
}

interface GroupRow {
  trip_id: string | null;
  trip_name: string | null;
  trip_count: number;
  region_id: string | null;
  region_name: string | null;
  n: number;
  covers: string[];
  from_at: Date | null;
  to_at: Date | null;
  from_us: string | null;
  to_us: string | null;
  first_id: string;
  last_id: string;
}

export async function unplacedRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  async function unplacedSource(query: GalleryFilterQuery, userId: string) {
    const filters = await galleryFiltersFor(query, userId);
    if ("error" in filters) return filters;
    const params: unknown[] = [userId];
    const param = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const from = `FROM ${galleryCapturesSource(filters)} c ${GALLERY_ITEM_JOINS}
      WHERE c.user_id = $1 ${galleryFilterSql(filters, param)} AND (c.lat IS NULL OR c.lon IS NULL)`;
    return { from, params, param };
  }

  app.get(
    "/gallery/map/unplaced",
    {
      preValidation: requireScope("gallery.read"),
      schema: {
        querystring: UnplacedQuery,
        response: replies(Type.Object({ groups: Type.Array(Group), nextCursor: Nullable(Type.String()) })),
      },
    },
    async (request, reply) => {
      const source = await unplacedSource(request.query, request.user!.id);
      if ("error" in source) return reply.code(400).send({ error: source.error });
      const { from, params, param } = source;
      const state = request.query.state ?? "all";
      const offset = Number(request.query.cursor ?? 0);
      // Sessions are worked out over every unplaced photo, whatever the state filter, so a group
      // and its key mean the same photos in every view.
      const res = await pool.query<GroupRow>(
        `WITH u AS (
           SELECT c.id, c.taken_at, c.trip_id, c.region_id, c.quality_rating, p.id AS photo_id ${from}
         ),
         marked AS (
           SELECT u.*,
             CASE WHEN lag(u.taken_at) OVER w IS NULL
                    OR u.taken_at - lag(u.taken_at) OVER w > interval '${SESSION_GAP}'
                    OR u.region_id IS DISTINCT FROM lag(u.region_id) OVER w
                    OR date_trunc('day', u.taken_at) <> date_trunc('day', lag(u.taken_at) OVER w)
                  THEN 1 ELSE 0 END AS brk,
             (row_number() OVER (PARTITION BY u.trip_id, u.region_id, u.taken_at IS NULL ORDER BY u.id) - 1)
               / ${NO_DATE_CHUNK} AS chunk
           FROM u
           WINDOW w AS (PARTITION BY u.trip_id, u.taken_at IS NULL ORDER BY u.taken_at, u.id)
         ),
         sessions AS (
           SELECT m.*, CASE WHEN m.taken_at IS NULL THEN -1 - m.chunk
             ELSE sum(m.brk) OVER (PARTITION BY m.trip_id, m.taken_at IS NULL ORDER BY m.taken_at, m.id
                                   ROWS UNBOUNDED PRECEDING) END AS session
           FROM marked m
         ),
         groups AS (
           SELECT s.trip_id, s.region_id, s.session, count(*)::int AS n,
             (array_agg(s.photo_id::text ORDER BY s.quality_rating DESC NULLS LAST, s.taken_at, s.id))[1:4] AS covers,
             min(s.taken_at) AS from_at, max(s.taken_at) AS to_at,
             min(${MICROS("s.taken_at")})::text AS from_us, max(${MICROS("s.taken_at")})::text AS to_us,
             min(s.id::text) AS first_id, max(s.id::text) AS last_id
           FROM sessions s GROUP BY s.trip_id, s.region_id, s.session
         )
         SELECT g.*, t.name AS trip_name, r.name AS region_name,
           sum(g.n) OVER (PARTITION BY g.trip_id)::int AS trip_count,
           max(g.to_at) OVER (PARTITION BY g.trip_id) AS trip_last
         FROM groups g
         LEFT JOIN trips t ON t.id = g.trip_id
         LEFT JOIN regions r ON r.id = g.region_id
         WHERE ${state === "region" ? "g.region_id IS NOT NULL" : state === "none" ? "g.region_id IS NULL" : "true"}
         ORDER BY g.trip_id IS NULL, trip_last DESC NULLS LAST, g.trip_id,
           CASE WHEN g.trip_id IS NOT NULL THEN g.from_at END ASC NULLS LAST,
           g.from_at DESC NULLS LAST, r.name NULLS LAST, g.first_id
         LIMIT ${param(PAGE + 1)} OFFSET ${param(offset)}`,
        params,
      );
      const rows = res.rows.slice(0, PAGE);
      return {
        groups: rows.map((g) => {
          const dated = g.from_us !== null;
          return {
            key: groupKey({
              tripId: g.trip_id,
              regionId: g.region_id,
              dated,
              from: dated ? g.from_us! : g.first_id,
              to: dated ? g.to_us! : g.last_id,
            }),
            tripId: g.trip_id,
            tripName: g.trip_name,
            tripCount: g.trip_count,
            regionId: g.region_id,
            regionName: g.region_name,
            count: g.n,
            coverPhotoIds: g.covers,
            from: g.from_at?.toISOString() ?? null,
            to: g.to_at?.toISOString() ?? null,
          };
        }),
        nextCursor: res.rows.length > PAGE ? String(offset + PAGE) : null,
      };
    },
  );

  app.get(
    "/gallery/map/unplaced/photos",
    {
      preValidation: requireScope("gallery.read"),
      schema: {
        querystring: Type.Object({
          ...GalleryFilterQuery.properties,
          key: Type.String({ maxLength: 200, description: "A group's key" }),
        }),
        response: replies(
          Type.Object({
            captureIds: Type.Array(Uuid()),
            photoIds: Type.Array(Uuid(), { description: "Each capture's photo, in the same order" }),
          }),
        ),
      },
    },
    async (request, reply) => {
      const key = parseGroupKey(request.query.key);
      if (!key) return reply.code(400).send({ error: "Unknown group" });
      const source = await unplacedSource(request.query, request.user!.id);
      if ("error" in source) return reply.code(400).send({ error: source.error });
      const { from, params, param } = source;
      const range = key.dated
        ? `AND c.taken_at IS NOT NULL AND ${MICROS("c.taken_at")} BETWEEN ${param(key.from)}::bigint AND ${param(key.to)}::bigint`
        : `AND c.taken_at IS NULL AND c.id BETWEEN ${param(key.from)}::uuid AND ${param(key.to)}::uuid`;
      const res = await pool.query<{ capture_id: string; photo_id: string }>(
        `SELECT c.id AS capture_id, p.id AS photo_id ${from}
           AND c.trip_id IS NOT DISTINCT FROM ${param(key.tripId)}::uuid
           AND c.region_id IS NOT DISTINCT FROM ${param(key.regionId)}::uuid
           ${range}
         ORDER BY c.quality_rating DESC NULLS LAST, c.taken_at, c.id`,
        params,
      );
      return {
        captureIds: res.rows.map((r) => r.capture_id),
        photoIds: res.rows.map((r) => r.photo_id),
      };
    },
  );
}
