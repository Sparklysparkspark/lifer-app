// Moved photos: the places photos live (Settings > Storage), quiet relinking with Undo, the review
// list for matches Lifer won't guess, and trip folders that moved.
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { assertAllowedPath, isDirectory } from "@lifer/core/lib/allowedPaths.js";
import { canonicalPath } from "@lifer/core/lib/pathContainment.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { DateTime, IdParams, Nullable, Ok, Open, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { isTripBusy } from "../trips/jobs.js";
import {
  applyRelinks,
  autoMovedPhotos,
  movedPhotosJob,
  placesFor,
  startLook,
  undoBatch,
  useTripFolder,
} from "./relink.js";

const PassResult = Open({
  missing: Type.Integer(),
  relinked: Type.Integer(),
  review: Type.Integer(),
  proposals: Type.Integer(),
  batchId: Nullable(Type.String()),
  unreadableFolders: Type.Integer({ description: "Folders skipped because Lifer isn't allowed to read them" }),
  maxLagMs: Type.Integer({ description: "Longest event-loop delay during the pass" }),
});
const Proposal = Type.Object({
  tripId: Type.String(),
  tripName: Type.String(),
  folder: Type.String(),
  found: Type.Integer(),
  total: Type.Integer(),
  announced: Type.Boolean(),
});
const Status = Open({
  ...jobStatusFields(PassResult),
  manual: Type.Boolean({ description: "Started by the user, so its progress is shown" }),
  tripId: Nullable(Type.String()),
  notice: Nullable(
    Type.Object({ batchId: Type.String(), count: Type.Integer() }, { description: "Relinks not yet shown in a toast" }),
  ),
  reviewCount: Type.Integer(),
  proposals: Type.Array(Proposal),
});
const PathBody = Type.Object({ path: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const Place = Type.Object({ path: Type.String(), available: Type.Boolean() });

async function proposalsFor(userId: string) {
  const res = await pool.query<{
    tripId: string;
    tripName: string;
    folder: string;
    found: number;
    total: number;
    announced: boolean;
  }>(
    `SELECT p.trip_id AS "tripId", t.name AS "tripName", p.folder, p.found, p.total, p.announced
       FROM trip_folder_proposals p JOIN trips t ON t.id = p.trip_id
      WHERE p.user_id = $1 AND p.dismissed_at IS NULL ORDER BY p.created_at DESC LIMIT 50`,
    [userId],
  );
  return res.rows;
}

export async function movedPhotosRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/moved-photos/status",
    { preValidation: requireScope("photos.read"), schema: { response: replies(Status) } },
    async (request) => {
      const userId = request.user!.id;
      const notice = await pool.query<{ batchId: string; count: string }>(
        `SELECT b.id AS "batchId", count(ch.*) AS count FROM relink_batches b
           JOIN relink_changes ch ON ch.batch_id = b.id
          WHERE b.user_id = $1 AND NOT b.announced AND b.undone_at IS NULL
          GROUP BY b.id ORDER BY max(b.created_at) DESC LIMIT 1`,
        [userId],
      );
      const reviews = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM moved_photo_reviews WHERE user_id = $1 AND dismissed_at IS NULL`,
        [userId],
      );
      const status = movedPhotosJob.status;
      const mine = status.userId === userId;
      return {
        ...(mine ? status : { ...status, running: false, result: null, manual: false, tripId: null }),
        notice: notice.rows[0] ? { batchId: notice.rows[0].batchId, count: Number(notice.rows[0].count) } : null,
        reviewCount: Number(reviews.rows[0].n),
        proposals: await proposalsFor(userId),
      };
    },
  );

  app.post(
    "/moved-photos/look",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            tripId: Type.Optional(Type.String({ format: "uuid" })),
            manual: Type.Optional(
              Type.Boolean({ description: "The user asked: show progress, ignore the auto switch" }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ started: Type.Boolean() })),
      },
    },
    async (request, reply) => {
      const { tripId, manual } = request.body;
      if (manual && movedPhotosJob.status.running)
        return reply.code(409).send({ error: "Lifer is already looking for moved photos" });
      return { started: await startLook(request.user!.id, { tripId, manual }) };
    },
  );

  app.post(
    "/moved-photos/cancel",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ cancelled: Type.Boolean() })) } },
    async (request) => ({
      cancelled: movedPhotosJob.status.userId === request.user!.id && movedPhotosJob.cancel(),
    }),
  );

  // The toast for these was shown.
  app.post(
    "/moved-photos/ack",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            batchIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }))),
            tripIds: Type.Optional(Type.Array(Type.String({ format: "uuid" }))),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      await pool.query(`UPDATE relink_batches SET announced = true WHERE user_id = $1 AND id = ANY($2::uuid[])`, [
        userId,
        request.body.batchIds ?? [],
      ]);
      await pool.query(
        `UPDATE trip_folder_proposals SET announced = true WHERE user_id = $1 AND trip_id = ANY($2::uuid[])`,
        [userId, request.body.tripIds ?? []],
      );
      return { ok: true };
    },
  );

  app.get(
    "/moved-photos/settings",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            auto: Type.Boolean(),
            library: Type.String(),
            tripFolders: Type.Integer({ description: "Trips whose folders are included automatically" }),
            watched: Type.Array(Type.String()),
            places: Type.Array(Place),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const places = await placesFor(userId);
      return {
        auto: await autoMovedPhotos(userId),
        library: places.library,
        tripFolders: Number(
          (await pool.query<{ n: string }>(`SELECT count(*) AS n FROM trips WHERE user_id = $1`, [userId])).rows[0].n,
        ),
        watched: places.watched,
        places: await Promise.all(places.chosen.map(async (p) => ({ path: p, available: await isDirectory(p) }))),
      };
    },
  );

  app.put(
    "/moved-photos/settings",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object({ auto: Type.Boolean() }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request) => {
      await pool.query(`UPDATE users SET find_moved_photos = $2 WHERE id = $1`, [request.user!.id, request.body.auto]);
      if (!request.body.auto && movedPhotosJob.status.userId === request.user!.id && !movedPhotosJob.status.manual)
        movedPhotosJob.cancel();
      return { ok: true };
    },
  );

  app.post(
    "/moved-photos/places",
    { preValidation: requireAuth, schema: { body: PathBody, response: replies(Ok) } },
    async (request, reply) => {
      if (!(await isDirectory(request.body.path))) return reply.code(400).send({ error: "That folder doesn't exist" });
      const folder = assertAllowedPath(request.body.path);
      await pool.query(`INSERT INTO photo_places (user_id, path) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [
        request.user!.id,
        folder,
      ]);
      return { ok: true };
    },
  );

  app.post(
    "/moved-photos/places/remove",
    { preValidation: requireAuth, schema: { body: PathBody, response: replies(Ok) } },
    async (request) => {
      await pool.query(`DELETE FROM photo_places WHERE user_id = $1 AND path = $2`, [
        request.user!.id,
        request.body.path,
      ]);
      return { ok: true };
    },
  );

  app.get(
    "/moved-photos/batches",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            batches: Type.Array(
              Type.Object({
                id: Type.String(),
                createdAt: DateTime(),
                count: Type.Integer(),
                undone: Type.Boolean(),
                tripName: Nullable(Type.String()),
                folder: Nullable(Type.String({ description: "A trip's new folder, when the batch moved one" })),
              }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{
        id: string;
        createdAt: Date;
        count: string;
        undone: boolean;
        tripName: string | null;
        folder: string | null;
      }>(
        `SELECT b.id, b.created_at AS "createdAt", (SELECT count(*) FROM relink_changes ch WHERE ch.batch_id = b.id) AS count,
                b.undone_at IS NOT NULL AS undone, t.name AS "tripName", b.new_source_folder AS folder
           FROM relink_batches b LEFT JOIN trips t ON t.id = b.trip_id
          WHERE b.user_id = $1 ORDER BY b.created_at DESC LIMIT 20`,
        [request.user!.id],
      );
      return { batches: res.rows.map((r) => ({ ...r, count: Number(r.count) })) };
    },
  );

  app.post(
    "/moved-photos/batches/:id/undo",
    {
      preValidation: requireAuth,
      schema: { params: IdParams, response: replies(Type.Object({ undone: Type.Boolean() })) },
    },
    async (request) => ({ undone: await undoBatch(request.user!.id, request.params.id) }),
  );

  app.get(
    "/moved-photos/reviews",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            total: Type.Integer(),
            items: Type.Array(
              Type.Object({
                originalId: Type.String(),
                path: Type.String({ description: "Where Lifer last had the file" }),
                reason: Type.Enum(["several", "probably"]),
                photoId: Nullable(Type.String()),
                commonName: Nullable(Type.String()),
                scientificName: Nullable(Type.String()),
                candidates: Type.Array(Type.Object({ path: Type.String(), size: Nullable(Type.Number()) })),
              }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const res = await pool.query<{
        originalId: string;
        path: string;
        reason: "several" | "probably";
        photoId: string | null;
        commonName: string | null;
        scientificName: string | null;
        candidates: string[];
        total: string;
      }>(
        `SELECT r.original_id AS "originalId", o.ref AS path, r.reason, c.current_photo_id AS "photoId",
                s.common_name AS "commonName", s.scientific_name AS "scientificName", r.candidates,
                count(*) OVER () AS total
           FROM moved_photo_reviews r JOIN originals o ON o.id = r.original_id
           LEFT JOIN captures_all c ON c.id = o.capture_id
           LEFT JOIN species s ON s.id = COALESCE(c.species_id, o.species_id)
          WHERE r.user_id = $1 AND r.dismissed_at IS NULL
          ORDER BY o.ref LIMIT 500`,
        [request.user!.id],
      );
      const items = await Promise.all(
        res.rows.map(async ({ total: _total, candidates, ...r }) => ({
          ...r,
          candidates: await Promise.all(
            candidates.map(async (p) => ({ path: p, size: (await stat(p).catch(() => null))?.size ?? null })),
          ),
        })),
      );
      return { total: Number(res.rows[0]?.total ?? 0), items };
    },
  );

  app.post(
    "/moved-photos/reviews/:id/use",
    {
      preValidation: requireAuth,
      schema: { params: IdParams, body: PathBody, response: replies(Type.Object({ batchId: Type.String() })) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const row = (
        await pool.query<{
          ref: string;
          volume_id: string | null;
          volume_relative_path: string | null;
          capture_id: string | null;
          candidates: string[];
          trip_id: string | null;
        }>(
          `SELECT o.ref, o.volume_id, o.volume_relative_path, o.capture_id, r.candidates, c.trip_id
             FROM moved_photo_reviews r JOIN originals o ON o.id = r.original_id
             LEFT JOIN captures_all c ON c.id = o.capture_id
            WHERE r.original_id = $1 AND r.user_id = $2`,
          [request.params.id, userId],
        )
      ).rows[0];
      if (!row) return reply.code(404).send({ error: "Not found" });
      const chosen = request.body.path;
      // Only one of the files Lifer offered, still there, and not already another photo's.
      if (!row.candidates.includes(chosen)) return reply.code(400).send({ error: "Choose one of the files listed" });
      if (!existsSync(chosen)) return reply.code(400).send({ error: "That file isn't there any more" });
      if (row.trip_id && isTripBusy(row.trip_id))
        return reply.code(409).send({ error: "Wait for this trip's files to finish first" });
      const taken = await pool.query(`SELECT 1 FROM originals WHERE lower(ref) = lower($1) AND id <> $2 LIMIT 1`, [
        canonicalPath(chosen),
        request.params.id,
      ]);
      if (taken.rowCount) return reply.code(409).send({ error: "Another photo already uses that file" });
      const { batchId } = await applyRelinks(
        userId,
        [
          {
            originalId: request.params.id,
            captureId: row.capture_id,
            oldRef: row.ref,
            oldVolumeId: row.volume_id,
            oldVolumeRel: row.volume_relative_path,
            newRef: chosen,
          },
        ],
        { announced: true },
      );
      return { batchId };
    },
  );

  app.post(
    "/moved-photos/reviews/:id/dismiss",
    { preValidation: requireAuth, schema: { params: IdParams, response: replies(Ok) } },
    async (request) => {
      await pool.query(`UPDATE moved_photo_reviews SET dismissed_at = now() WHERE original_id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      return { ok: true };
    },
  );

  app.post(
    "/moved-photos/trip-folders/:id/use",
    {
      preValidation: requireAuth,
      schema: {
        params: IdParams,
        response: replies(Type.Object({ batchId: Type.String(), count: Type.Integer() })),
      },
    },
    async (request, reply) => {
      try {
        const done = await useTripFolder(request.user!.id, request.params.id);
        if (!done) return reply.code(404).send({ error: "That folder isn't there any more" });
        return done;
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 409)
          return reply.code(409).send({ error: (err as Error).message });
        throw err;
      }
    },
  );

  app.post(
    "/moved-photos/trip-folders/:id/dismiss",
    { preValidation: requireAuth, schema: { params: IdParams, response: replies(Ok) } },
    async (request) => {
      await pool.query(`UPDATE trip_folder_proposals SET dismissed_at = now() WHERE trip_id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
      ]);
      return { ok: true };
    },
  );
}
