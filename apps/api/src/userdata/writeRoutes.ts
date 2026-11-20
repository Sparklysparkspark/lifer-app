// The userdata.write routes: the few marks a companion app may set on the user's own photos and
// species (rating, pick or reject, colour label; a species' featured photo and crop; "needs a better
// photo"). Nothing that deletes, moves, reassigns or changes settings. A key's every change goes
// into the change log (migration 166) under the app's name, with the steps that undo it, and
// Settings > Connected apps lists and undoes them.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { CULL_LABELS } from "@lifer/shared";
import { IdParams, Nullable, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { isRateLimited, recordAttempt } from "../auth/rateLimiter.js";
import { syncCaptureXmpSidecarsLogged } from "../uploads/xmpSidecarSync.js";
import { setSpeciesCover, syncCoverCaptureXmp } from "../collection/routes.js";

// Plenty for marking a card's worth of photos one by one, not enough to flood the change log.
const WRITES_PER_MINUTE = 600;

type Flag = "pick" | "reject" | null;
type PhotoMarks = { rating?: number | null; flag?: Flag; label?: string | null };
type Crop = { x: number | null; y: number | null; size: number | null };

/** The steps that undo a companion app's change, stored in change_batches.undo. Only Lifer writes
 *  these (POST /changes accepts album steps only), and each runs for the batch's own user. */
export type AppUndoStep =
  | ({ op: "restorePhotoMarks"; captureId: string } & PhotoMarks)
  | {
      op: "restoreSpecies";
      speciesId: string;
      cover?: { photoId: string | null; chosenPhotoId: string | null } & Crop;
      crop?: Crop;
      needsBetterPhoto?: boolean;
    };

const MARK_COLUMNS = { rating: "quality_rating", flag: "cull_verdict", label: "cull_label" } as const;

/** Writes the marks given (a key left out stays as it is) on one of the user's visible captures. */
async function applyPhotoMarks(userId: string, captureId: string, marks: PhotoMarks): Promise<boolean> {
  const keys = (Object.keys(MARK_COLUMNS) as (keyof PhotoMarks)[]).filter((k) => k in marks);
  if (keys.length === 0) return true;
  const params: unknown[] = [captureId, userId];
  const sets = keys.map((k) => {
    params.push(marks[k]);
    return `${MARK_COLUMNS[k]} = $${params.length}`;
  });
  const res = await pool.query<{ species_id: string }>(
    `UPDATE captures SET ${sets.join(", ")} WHERE id = $1 AND user_id = $2 RETURNING species_id`,
    params,
  );
  const speciesId = res.rows[0]?.species_id;
  if (!speciesId) return false;
  // As PATCH /captures/:id/rating: best_quality is the species' highest rating.
  if ("rating" in marks)
    await pool.query(
      `UPDATE user_species SET best_quality = (
         SELECT MAX(quality_rating) FROM captures WHERE user_id = $1 AND species_id = $2
       ) WHERE user_id = $1 AND species_id = $2`,
      [userId, speciesId],
    );
  await syncCaptureXmpSidecarsLogged(userId, captureId);
  return true;
}

/** Puts a species' featured photo, crop or mark back as an undo step recorded it. */
async function restoreSpecies(userId: string, step: Extract<AppUndoStep, { op: "restoreSpecies" }>): Promise<void> {
  const { speciesId } = step;
  if (step.cover) {
    const before = await pool.query<{ cover_photo_id: string | null }>(
      `SELECT cover_photo_id FROM user_species WHERE user_id = $1 AND species_id = $2`,
      [userId, speciesId],
    );
    // A photo deleted since can't come back as the cover.
    const { cover } = step;
    await pool.query(
      `UPDATE user_species SET
         cover_photo_id = (SELECT p.id FROM photos p JOIN captures_all c ON c.id = p.capture_id WHERE p.id = $3 AND c.user_id = $1),
         cover_chosen_photo_id = (SELECT p.id FROM photos p JOIN captures_all c ON c.id = p.capture_id WHERE p.id = $4 AND c.user_id = $1),
         card_crop_x = $5, card_crop_y = $6, card_crop_size = $7
       WHERE user_id = $1 AND species_id = $2`,
      [userId, speciesId, cover.photoId, cover.chosenPhotoId, cover.x, cover.y, cover.size],
    );
    await syncCoverCaptureXmp(userId, before.rows[0]?.cover_photo_id ?? null);
    await syncCoverCaptureXmp(userId, cover.photoId);
  }
  if (step.crop)
    await pool.query(
      `UPDATE user_species SET card_crop_x = $3, card_crop_y = $4, card_crop_size = $5
       WHERE user_id = $1 AND species_id = $2 AND cover_photo_id IS NOT NULL`,
      [userId, speciesId, step.crop.x, step.crop.y, step.crop.size],
    );
  if (step.needsBetterPhoto !== undefined)
    await pool.query(`UPDATE user_species SET needs_better_photo = $3 WHERE user_id = $1 AND species_id = $2`, [
      userId,
      speciesId,
      step.needsBetterPhoto,
    ]);
}

export async function runAppUndoStep(userId: string, step: AppUndoStep): Promise<void> {
  if (step.op === "restoreSpecies") return restoreSpecies(userId, step);
  const { op: _op, captureId, ...marks } = step;
  await applyPhotoMarks(userId, captureId, marks);
}

/** Records a key's change under its app's name. Lifer's own requests (a session) aren't logged:
 *  the user made them and undoes them where they made them. */
async function recordChange(request: FastifyRequest, summary: string, undo: AppUndoStep[]): Promise<string | null> {
  if (!request.apiKeyName) return null;
  const res = await pool.query<{ id: string }>(
    `INSERT INTO change_batches (user_id, summary, undo, app_name) VALUES ($1, $2, $3::jsonb, $4) RETURNING id`,
    [request.user!.id, summary, JSON.stringify(undo), request.apiKeyName],
  );
  return res.rows[0].id;
}

// Per app and user. Lifer's own requests aren't limited here.
async function writeBudget(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.apiKeyName) return;
  const key = `userdata-write:${request.user!.id}:${request.apiKeyName}`;
  if (isRateLimited(key, WRITES_PER_MINUTE, 60_000)) {
    reply.code(429).header("Retry-After", "60").send({ error: "Too many changes. Try again in a minute." });
    return;
  }
  recordAttempt(key);
}

async function speciesName(speciesId: string): Promise<string> {
  const res = await pool.query<{ name: string }>(
    `SELECT COALESCE(common_name, scientific_name) AS name FROM species WHERE id = $1`,
    [speciesId],
  );
  return res.rows[0]?.name ?? "a species";
}

function marksSummary(marks: PhotoMarks): string {
  const parts: string[] = [];
  if ("rating" in marks) parts.push(marks.rating ? `rated a photo ${marks.rating} stars` : "cleared a photo's rating");
  if ("flag" in marks)
    parts.push(marks.flag ? `marked a photo as a ${marks.flag}` : "cleared a photo's pick or reject");
  if ("label" in marks)
    parts.push(marks.label ? `gave a photo a ${marks.label} label` : "cleared a photo's colour label");
  const text = parts.join(", ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const Changed = Type.Object({
  ok: Type.Boolean(),
  changeId: Nullable(
    Uuid({ description: "The change as Lifer lists it in Connected apps; null when nothing changed" }),
  ),
});
const Percent = Type.Number({ minimum: 0, maximum: 100 });
const speciesNotFound = notFoundOnInvalidId("Species not found");

export async function userdataWriteRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const auth = { preValidation: requireScope("userdata.write"), preHandler: writeBudget };

  // Rating, pick or reject, and colour label on one of the user's photos. A field left out stays.
  app.patch(
    "/userdata/v1/photos/:id",
    {
      ...auth,
      config: notFoundOnInvalidId("Photo not found"),
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            rating: Type.Optional(Nullable(Type.Integer({ minimum: 1, maximum: 5, description: "1-5, or null" }))),
            flag: Type.Optional(Nullable(Type.Enum(["pick", "reject"], { description: "Pick, reject, or null" }))),
            label: Type.Optional(Nullable(Type.Enum([...CULL_LABELS], { description: "Colour label, or null" }))),
          },
          { additionalProperties: false, minProperties: 1 },
        ),
        response: replies(Changed),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const res = await pool.query<{
        id: string;
        quality_rating: number | null;
        cull_verdict: Flag;
        cull_label: string | null;
      }>(
        `SELECT c.id, c.quality_rating, c.cull_verdict, c.cull_label FROM photos p JOIN captures c ON c.id = p.capture_id
         WHERE p.id = $1 AND c.user_id = $2`,
        [request.params.id, userId],
      );
      const before = res.rows[0];
      if (!before) return reply.code(404).send({ error: "Photo not found" });
      const was: Required<PhotoMarks> = {
        rating: before.quality_rating,
        flag: before.cull_verdict,
        label: before.cull_label,
      };
      const changed = (Object.keys(request.body) as (keyof PhotoMarks)[]).filter((k) => request.body[k] !== was[k]);
      if (changed.length === 0) return { ok: true, changeId: null };
      const marks = Object.fromEntries(changed.map((k) => [k, request.body[k]])) as PhotoMarks;
      await applyPhotoMarks(userId, before.id, marks);
      const undo = Object.fromEntries(changed.map((k) => [k, was[k]])) as PhotoMarks;
      const changeId = await recordChange(request, marksSummary(marks), [
        { op: "restorePhotoMarks", captureId: before.id, ...undo },
      ]);
      return { ok: true, changeId };
    },
  );

  // The species' featured photo: one of the user's photos of it. Lifer frames a fresh default crop.
  app.put(
    "/userdata/v1/species/:id/featured",
    {
      ...auth,
      config: speciesNotFound,
      schema: {
        params: IdParams,
        body: Type.Object({ photoId: Uuid() }, { additionalProperties: false }),
        response: replies(Changed),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const speciesId = request.params.id;
      const res = await pool.query<{
        cover_photo_id: string | null;
        cover_chosen_photo_id: string | null;
        card_crop_x: string | null;
        card_crop_y: string | null;
        card_crop_size: string | null;
      }>(
        `SELECT cover_photo_id, cover_chosen_photo_id, card_crop_x, card_crop_y, card_crop_size
         FROM user_species WHERE user_id = $1 AND species_id = $2`,
        [userId, speciesId],
      );
      const before = res.rows[0];
      if (!before) return reply.code(404).send({ error: "Species not found" });
      if (before.cover_photo_id === request.body.photoId) return { ok: true, changeId: null };
      if (!(await setSpeciesCover(userId, speciesId, request.body.photoId)))
        return reply.code(403).send({ error: "That photo doesn't belong to you for this species" });
      const changeId = await recordChange(request, `Chose the featured photo for ${await speciesName(speciesId)}`, [
        {
          op: "restoreSpecies",
          speciesId,
          cover: {
            photoId: before.cover_photo_id,
            chosenPhotoId: before.cover_chosen_photo_id,
            ...cropOf(before),
          },
        },
      ]);
      return { ok: true, changeId };
    },
  );

  // The card crop of the species' featured photo, in percent of the photo.
  app.put(
    "/userdata/v1/species/:id/card-crop",
    {
      ...auth,
      config: speciesNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          { x: Percent, y: Percent, size: Type.Number({ exclusiveMinimum: 0, maximum: 100 }) },
          { additionalProperties: false },
        ),
        response: replies(Changed),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const speciesId = request.params.id;
      const { x, y, size } = request.body;
      const res = await pool.query<{
        card_crop_x: string | null;
        card_crop_y: string | null;
        card_crop_size: string | null;
      }>(
        `SELECT card_crop_x, card_crop_y, card_crop_size FROM user_species
         WHERE user_id = $1 AND species_id = $2 AND cover_photo_id IS NOT NULL`,
        [userId, speciesId],
      );
      const before = res.rows[0];
      if (!before) return reply.code(404).send({ error: "No featured photo set for this species yet" });
      await pool.query(
        `UPDATE user_species SET card_crop_x = $3, card_crop_y = $4, card_crop_size = $5 WHERE user_id = $1 AND species_id = $2`,
        [userId, speciesId, x, y, size],
      );
      const changeId = await recordChange(request, `Changed the card crop for ${await speciesName(speciesId)}`, [
        { op: "restoreSpecies", speciesId, crop: cropOf(before) },
      ]);
      return { ok: true, changeId };
    },
  );

  // "Needs a better photo": PUT sets the mark, DELETE clears it.
  const needsBetter =
    (on: boolean) => async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      const userId = request.user!.id;
      const speciesId = request.params.id;
      // The self-join reads the row as it was before this update.
      const res = await pool.query<{ was: boolean }>(
        `UPDATE user_species us SET needs_better_photo = $3 FROM user_species old
       WHERE us.user_id = $1 AND us.species_id = $2 AND old.user_id = us.user_id AND old.species_id = us.species_id
       RETURNING old.needs_better_photo AS was`,
        [userId, speciesId, on],
      );
      const row = res.rows[0];
      if (!row) return reply.code(404).send({ error: "Species not found" });
      if (row.was === on) return { ok: true, changeId: null };
      const name = await speciesName(speciesId);
      const changeId = await recordChange(
        request,
        on ? `Marked ${name} as needing a better photo` : `Cleared "needs a better photo" on ${name}`,
        [{ op: "restoreSpecies", speciesId, needsBetterPhoto: row.was }],
      );
      return { ok: true, changeId };
    };
  const needsBetterOptions = {
    ...auth,
    config: speciesNotFound,
    schema: { params: IdParams, response: replies(Changed) },
  };
  app.put("/userdata/v1/species/:id/needs-better-photo", needsBetterOptions, needsBetter(true));
  app.delete("/userdata/v1/species/:id/needs-better-photo", needsBetterOptions, needsBetter(false));
}

function cropOf(r: { card_crop_x: string | null; card_crop_y: string | null; card_crop_size: string | null }): Crop {
  const n = (v: string | null) => (v === null ? null : Number(v));
  return { x: n(r.card_crop_x), y: n(r.card_crop_y), size: n(r.card_crop_size) };
}
