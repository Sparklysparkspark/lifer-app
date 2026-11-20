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
}
