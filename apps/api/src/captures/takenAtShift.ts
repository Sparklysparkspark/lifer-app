// Moves many photos' capture time by the same amount, for a camera clock or time zone that was
// wrong. Undo is the same shift reversed on the same photos, so nothing extra is stored.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { createLimiter } from "@lifer/core/lib/concurrency.js";
import { log } from "@lifer/core/lib/log.js";
import { DateTime, Nullable, Open, Uuid, jobStatusFields, replies, withSchemas } from "../lib/schema.js";
import { requireScope } from "../auth/session.js";
import { createJob } from "../lib/job.js";
import { scheduleTripRecordsSave } from "../lib/libraryRecords.js";
import { shiftCaptureTime } from "../uploads/exif.js";

const MAX_IDS = 100_000;
// About a century either way: anything larger is a typo.
export const MAX_SHIFT_MINUTES = 100 * 366 * 24 * 60;
// Photos per transaction, so a huge selection never holds one long lock and progress moves.
export const SHIFT_PAGE_SIZE = 500;

export interface ShiftResult {
  shifted: number;
  /** Selected photos with no date, left alone. */
  undated: number;
  /** Files whose time couldn't be rewritten (read-only, missing); Lifer's date still moved. */
  filesFailed: number;
}

export const takenAtShiftJob = createJob<ShiftResult>("shift-taken-at");

const CaptureIds = Type.Array(Uuid(), { minItems: 1, maxItems: MAX_IDS });

// Each species' earliest photo date (primary or secondary tag): what first_collected came from.
const FIRST_DATES = `SELECT e.species_id, min(c.taken_at)::date AS first
  FROM captures c
  CROSS JOIN LATERAL (SELECT c.species_id UNION SELECT cs.species_id FROM capture_species cs WHERE cs.capture_id = c.id) e
  WHERE c.user_id = $1 AND e.species_id = ANY($2::uuid[]) AND c.taken_at IS NOT NULL
  GROUP BY e.species_id`;

/** Shifts one page of captures in Lifer. A species' first_collected follows only when it was
 *  its earliest photo's date, so a date entered by hand or imported stays. */
async function shiftPage(userId: string, ids: string[], minutes: number): Promise<string[]> {
  return withTransaction(async (client) => {
    const species = await client.query<{ species_id: string }>(
      `SELECT DISTINCT e.species_id FROM captures c
       CROSS JOIN LATERAL (SELECT c.species_id UNION SELECT cs.species_id FROM capture_species cs WHERE cs.capture_id = c.id) e
       WHERE c.id = ANY($1::uuid[]) AND c.user_id = $2 AND c.taken_at IS NOT NULL`,
      [ids, userId],
    );
    const speciesIds = species.rows.map((r) => r.species_id);
    const before = await client.query<{ species_id: string; first: string }>(
      `SELECT species_id, first::text FROM (${FIRST_DATES}) f`,
      [userId, speciesIds],
    );
    const moved = await client.query<{ id: string }>(
      // The user set the time themselves, so the sun can be placed from it.
      `UPDATE captures SET taken_at = taken_at + make_interval(mins => $3), taken_at_zoned = true
       WHERE id = ANY($1::uuid[]) AND user_id = $2 AND taken_at IS NOT NULL RETURNING id`,
      [ids, userId, minutes],
    );
    await client.query(
      `UPDATE user_species us SET first_collected = f.first
       FROM (${FIRST_DATES}) f, unnest($3::uuid[], $4::date[]) AS b(species_id, first)
       WHERE us.user_id = $1 AND us.species_id = f.species_id AND b.species_id = f.species_id
         AND us.first_collected = b.first AND f.first <> b.first`,
      [userId, speciesIds, before.rows.map((r) => r.species_id), before.rows.map((r) => r.first)],
    );
    return moved.rows.map((r) => r.id);
  });
}

/** Runs the shift as the one background job: Lifer's dates page by page, then each page's files. */
export function startTakenAtShift(userId: string, captureIds: string[], minutes: number): boolean {
  const ids = [...new Set(captureIds)];
  return takenAtShiftJob.start(
    async (ctx) => {
      const result: ShiftResult = { shifted: 0, undated: 0, filesFailed: 0 };
      const limit = createLimiter(4);
      for (let i = 0; i < ids.length; i += SHIFT_PAGE_SIZE) {
        ctx.throwIfCancelled();
        const page = ids.slice(i, i + SHIFT_PAGE_SIZE);
        const moved = await shiftPage(userId, page, minutes);
        result.shifted += moved.length;
        result.undated += page.length - moved.length;
        // Only Lifer's own copies: a linked file in someone's folder is never rewritten.
        const files = await pool.query<{ ref: string }>(
          `SELECT ref FROM originals WHERE capture_id = ANY($1::uuid[]) AND managed = true`,
          [moved],
        );
        await Promise.all(
          files.rows.map((f) =>
            limit(() =>
              shiftCaptureTime(f.ref, minutes).catch((err) => {
                result.filesFailed++;
                log.warn({ ref: f.ref, err: err instanceof Error ? err.message : err }, "Couldn't shift a file's time");
              }),
            ),
          ),
        );
        ctx.update({ processed: Math.min(ids.length, i + SHIFT_PAGE_SIZE) });
      }
      // Trip records list their photos in time order.
      if (result.shifted > 0) scheduleTripRecordsSave(userId);
      return result;
    },
    { phase: "shifting", processed: 0, total: ids.length },
  );
}

export async function takenAtShiftRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // What the dialog shows before applying: the date range, how many have no date, and the first
  // dated photo in selection order for "Set this photo's time".
  app.post(
    "/captures/taken-at/preview",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        body: Type.Object({ captureIds: CaptureIds }, { additionalProperties: false }),
        response: replies(
          Type.Object({
            dated: Type.Integer(),
            undated: Type.Integer(),
            earliest: Nullable(DateTime()),
            latest: Nullable(DateTime()),
            first: Nullable(Type.Object({ captureId: Uuid(), photoId: Nullable(Uuid()), takenAt: DateTime() })),
          }),
        ),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { captureIds } = request.body;
      const range = await pool.query<{ dated: number; undated: number; earliest: Date | null; latest: Date | null }>(
        `SELECT count(taken_at)::int AS dated, (count(*) - count(taken_at))::int AS undated,
                min(taken_at) AS earliest, max(taken_at) AS latest
         FROM captures WHERE id = ANY($1::uuid[]) AND user_id = $2`,
        [captureIds, userId],
      );
      const first = await pool.query<{ capture_id: string; photo_id: string | null; taken_at: Date }>(
        `SELECT c.id AS capture_id, c.current_photo_id AS photo_id, c.taken_at
         FROM unnest($1::uuid[]) WITH ORDINALITY AS u(id, n)
         JOIN captures c ON c.id = u.id
         WHERE c.user_id = $2 AND c.taken_at IS NOT NULL
         ORDER BY u.n LIMIT 1`,
        [captureIds, userId],
      );
      const f = first.rows[0];
      return {
        ...range.rows[0],
        first: f ? { captureId: f.capture_id, photoId: f.photo_id, takenAt: f.taken_at } : null,
      };
    },
  );

  app.post(
    "/captures/taken-at/shift",
    {
      preValidation: requireScope("photos.write"),
      schema: {
        body: Type.Object(
          {
            captureIds: CaptureIds,
            minutes: Type.Integer({
              minimum: -MAX_SHIFT_MINUTES,
              maximum: MAX_SHIFT_MINUTES,
              description: "Negative moves the photos earlier. Undo by sending the opposite.",
            }),
          },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ started: Type.Boolean() }), 202),
      },
    },
    async (request, reply) => {
      const { captureIds, minutes } = request.body;
      if (minutes === 0) return reply.code(400).send({ error: "Choose a time difference first" });
      if (!startTakenAtShift(request.user!.id, captureIds, minutes)) {
        return reply.code(409).send({ error: "Another date change is still running. Try again when it finishes." });
      }
      return reply.code(202).send({ started: true });
    },
  );

  app.get(
    "/captures/taken-at/shift/status",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        response: replies(
          Open(
            jobStatusFields(
              Type.Object({ shifted: Type.Integer(), undated: Type.Integer(), filesFailed: Type.Integer() }),
            ),
          ),
        ),
      },
    },
    async () => takenAtShiftJob.status,
  );
}
