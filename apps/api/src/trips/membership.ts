// Which photos are in a trip, changed by hand: photos taken during a trip are suggested for it,
// never added on their own; the user adds some, dismisses some (they stay dismissed), or removes
// photos. A photo whose trip changes has its managed files moved into or out of trip folders.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import {
  DateTime,
  IdParams,
  Nullable,
  Ok,
  Open,
  Uuid,
  notFoundOnInvalidId,
  replies,
  withSchemas,
} from "../lib/schema.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { refileCaptures } from "../uploads/reorganizeOriginals.js";
import { tripSpan, tripsToOffer, type Point, type TripFacts } from "./tripFit.js";

const tripNotFound = notFoundOnInvalidId("Trip not found");
const CaptureIds = Type.Object(
  { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: 10000 }) },
  { additionalProperties: false },
);
const Changed = Type.Object({
  changed: Type.Integer(),
  movingFiles: Type.Boolean({ description: "Files are moving to their new folders; see /places/file-moves/status" }),
});

// Photo c was taken during trip t, is in no trip, and wasn't dismissed for it. Hidden photos are left out.
// Photos don't carry their time zone, so a photo counts when its day falls within the trip's
// dates anywhere on Earth (UTC-12 to UTC+14). Generous on purpose: these are only suggestions.
const DURING_TRIP = `c.user_id = t.user_id AND c.trip_id IS NULL AND c.hidden_at IS NULL
  AND t.start_date IS NOT NULL AND c.taken_at >= (t.start_date::timestamp AT TIME ZONE 'UTC') - interval '14 hours'
  AND (t.end_date IS NULL OR c.taken_at < ((t.end_date + 1)::timestamp AT TIME ZONE 'UTC') + interval '12 hours')
  AND NOT EXISTS (SELECT 1 FROM trip_suggestion_dismissals d WHERE d.trip_id = t.id AND d.capture_id = c.id)`;

async function ownsTrip(tripId: string, userId: string): Promise<boolean> {
  return !!(await pool.query(`SELECT 1 FROM trips WHERE id = $1 AND user_id = $2`, [tripId, userId])).rowCount;
}

/** Moves the changed photos' files to match their new trip, in the background. */
function followTripChange(userId: string, captureIds: string[]) {
  refileCaptures(userId, { captureIds, followTrip: true });
  return { changed: captureIds.length, movingFiles: captureIds.length > 0 };
}

export async function tripMembershipRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/trips/:id/suggestions",
    {
      preValidation: requireScope("trips.read"),
      config: tripNotFound,
      schema: {
        params: IdParams,
        response: replies(
          Open({
            items: Type.Array(
              Open({
                captureId: Uuid(),
                photoId: Nullable(Uuid()),
                takenAt: Nullable(DateTime()),
                scientificName: Type.String(),
                commonName: Nullable(Type.String()),
              }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await ownsTrip(request.params.id, userId))) return reply.code(404).send({ error: "Trip not found" });
      const res = await pool.query(
        `SELECT c.id, c.current_photo_id, c.taken_at, s.scientific_name, s.common_name
           FROM trips t
           JOIN captures c ON ${DURING_TRIP}
           JOIN species s ON s.id = c.species_id
          WHERE t.id = $1
          ORDER BY c.taken_at, c.id`,
        [request.params.id],
      );
      return {
        items: res.rows.map((r) => ({
          captureId: r.id,
          photoId: r.current_photo_id,
          takenAt: r.taken_at,
          scientificName: r.scientific_name,
          commonName: r.common_name,
        })),
      };
    },
  );

  app.post(
    "/trips/:id/suggestions/dismiss",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, body: CaptureIds, response: replies(Ok) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await ownsTrip(request.params.id, userId))) return reply.code(404).send({ error: "Trip not found" });
      await pool.query(
        `INSERT INTO trip_suggestion_dismissals (trip_id, capture_id)
         SELECT $1, c.id FROM captures c WHERE c.id = ANY($2::uuid[]) AND c.user_id = $3
         ON CONFLICT DO NOTHING`,
        [request.params.id, request.body.captureIds, userId],
      );
      return { ok: true };
    },
  );

  // Adds photos to the trip, taking them out of any other.
  app.post(
    "/trips/:id/captures",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, body: CaptureIds, response: replies(Changed) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await ownsTrip(request.params.id, userId))) return reply.code(404).send({ error: "Trip not found" });
      const res = await pool.query<{ id: string }>(
        `UPDATE captures SET trip_id = $1
          WHERE id = ANY($2::uuid[]) AND user_id = $3 AND trip_id IS DISTINCT FROM $1
          RETURNING id`,
        [request.params.id, request.body.captureIds, userId],
      );
      return followTripChange(
        userId,
        res.rows.map((r) => r.id),
      );
    },
  );

  app.post(
    "/trips/:id/captures/remove",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, body: CaptureIds, response: replies(Changed) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      if (!(await ownsTrip(request.params.id, userId))) return reply.code(404).send({ error: "Trip not found" });
      const res = await pool.query<{ id: string }>(
        `UPDATE captures SET trip_id = NULL WHERE id = ANY($2::uuid[]) AND user_id = $3 AND trip_id = $1 RETURNING id`,
        [request.params.id, request.body.captureIds, userId],
      );
      return followTripChange(
        userId,
        res.rows.map((r) => r.id),
      );
    },
  );

  // After an import: the trips some of these photos were taken during, for a hint to review them.
  app.post(
    "/trips/matching",
    {
      preValidation: requireScope("trips.read"),
      schema: {
        body: CaptureIds,
        response: replies(
          Open({ trips: Type.Array(Open({ id: Uuid(), name: Type.String(), count: Type.Integer() })) }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{ id: string; name: string; count: string }>(
        `SELECT t.id, t.name, count(*) AS count
           FROM trips t
           JOIN captures c ON ${DURING_TRIP}
          WHERE t.user_id = $1 AND c.id = ANY($2::uuid[])
          GROUP BY t.id
          ORDER BY count(*) DESC, t.name`,
        [request.user!.id, request.body.captureIds],
      );
      return { trips: res.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) })) };
    },
  );

  // Before an import with no trip: for each day's photos, the trips they clearly belong to
  // (tripFit.ts), so the Import page can ask. Nothing is changed.
  app.post(
    "/trips/import-suggestions",
    {
      preValidation: requireScope("trips.read"),
      schema: {
        body: Type.Object(
          {
            groups: Type.Array(
              Type.Object(
                {
                  key: Type.String({ minLength: 1, maxLength: 512 }),
                  times: Type.Array(DateTime(), { minItems: 1, maxItems: 10000 }),
                  points: Type.Array(
                    Type.Object(
                      {
                        lat: Type.Number({ minimum: -90, maximum: 90 }),
                        lon: Type.Number({ minimum: -180, maximum: 180 }),
                      },
                      { additionalProperties: false },
                    ),
                    { maxItems: 10000 },
                  ),
                  regionIds: Type.Array(Uuid(), { maxItems: 1000 }),
                },
                { additionalProperties: false },
              ),
              { maxItems: 2000 },
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Open({
            groups: Type.Array(
              Open({
                key: Type.String(),
                trips: Type.Array(Open({ id: Uuid(), name: Type.String(), from: DateTime(), to: DateTime() }), {
                  description: "One or two trips; none means no clear fit",
                }),
              }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { groups } = request.body;
      const [tripRes, pointRes, upRes] = await Promise.all([
        pool.query<{
          id: string;
          name: string;
          start_date: string | null;
          end_date: string | null;
          first: Date | null;
          last: Date | null;
          region_ids: string[];
        }>(
          `SELECT t.id, t.name, t.start_date::text, t.end_date::text, min(c.taken_at) AS first, max(c.taken_at) AS last,
                  array_remove(array_agg(DISTINCT c.region_id) || t.region_id, NULL)::text[] AS region_ids
             FROM trips t LEFT JOIN captures c ON c.trip_id = t.id
            WHERE t.user_id = $1
            GROUP BY t.id`,
          [userId],
        ),
        // Photos within a kilometre or so are one point.
        pool.query<{ trip_id: string; lat: number; lon: number }>(
          `SELECT DISTINCT trip_id, round(lat::numeric, 2)::float8 AS lat, round(lon::numeric, 2)::float8 AS lon
             FROM captures WHERE user_id = $1 AND trip_id IS NOT NULL AND lat IS NOT NULL AND lon IS NOT NULL`,
          [userId],
        ),
        // Each region the photos are in, with every region holding it.
        pool.query<{ start: string; ids: string[] }>(
          `WITH RECURSIVE up AS (
             SELECT id, parent_id, id AS start FROM regions WHERE id = ANY($1::uuid[])
             UNION SELECT r.id, r.parent_id, up.start FROM regions r JOIN up ON r.id = up.parent_id)
           SELECT start::text, array_agg(id)::text[] AS ids FROM up GROUP BY start`,
          [[...new Set(groups.flatMap((g) => g.regionIds))]],
        ),
      ]);
      const points = new Map<string, Point[]>();
      for (const p of pointRes.rows) points.set(p.trip_id, [...(points.get(p.trip_id) ?? []), p]);
      const up = new Map(upRes.rows.map((r) => [r.start, r.ids]));
      const trips: Array<TripFacts & { name: string }> = tripRes.rows.map((t) => ({
        id: t.id,
        name: t.name,
        startDate: t.start_date,
        endDate: t.end_date,
        firstTaken: t.first,
        lastTaken: t.last,
        regionIds: t.region_ids,
        points: points.get(t.id) ?? [],
      }));
      const now = new Date();
      return {
        groups: groups.flatMap((g) => {
          const offer = tripsToOffer(
            {
              times: g.times.map((d) => new Date(d)),
              points: g.points,
              regionIds: g.regionIds.flatMap((r) => up.get(r) ?? [r]),
            },
            trips,
            now,
          ) as Array<TripFacts & { name: string }>;
          return offer.length === 0
            ? []
            : [
                {
                  key: g.key,
                  trips: offer.map((t) => {
                    const span = tripSpan(t, now)!;
                    return {
                      id: t.id,
                      name: t.name,
                      from: new Date(span.from).toISOString(),
                      to: new Date(span.to - 1).toISOString(),
                    };
                  }),
                },
              ];
        }),
      };
    },
  );
}
