import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { runAppUndoStep, type AppUndoStep } from "../userdata/writeRoutes.js";
import { syncAlbumIndexForCaptures } from "../albums/albumIndex.js";
import { IdParams, Nullable, Open, Ok, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";

// The change-batch log (migration 166): an assistant records each change with the steps that undo
// it, and "undo last" runs the newest unused batch. An assistant can only send album steps, so a
// key that can't write albums can't use it, and every step is limited to the signed-in owner's
// albums. Companion apps' changes (app_name set, userdata/writeRoutes.ts) share the table but stay
// out of the assistant's list; Lifer lists and undoes them in Settings > Connected apps.
const MAX_CAPTURES = 500;
const UndoStep = Type.Union([
  Type.Object({ op: Type.Literal("deleteAlbum"), albumId: Uuid() }, { additionalProperties: false }),
  Type.Object(
    {
      op: Type.Literal("removeFromAlbum"),
      albumId: Uuid(),
      captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_CAPTURES }),
    },
    { additionalProperties: false },
  ),
]);
type UndoStep = Static<typeof UndoStep>;

const Batch = Open({
  id: Uuid(),
  summary: Type.String(),
  createdAt: Type.String(),
  undoneAt: Nullable(Type.String()),
});

async function runStep(userId: string, step: UndoStep | AppUndoStep): Promise<void> {
  if (step.op === "restorePhotoMarks" || step.op === "restoreSpecies") return runAppUndoStep(userId, step);
  if (step.op === "deleteAlbum") {
    await pool.query(`DELETE FROM albums WHERE id = $1 AND user_id = $2`, [step.albumId, userId]);
    return;
  }
  // Only a hand-picked album the user owns: a smart album's members come from its rules.
  const res = await pool.query(
    `DELETE FROM album_captures ac USING albums a
     WHERE ac.album_id = a.id AND a.id = $1 AND a.user_id = $2 AND a.rules IS NULL AND ac.capture_id = ANY($3)`,
    [step.albumId, userId, step.captureIds],
  );
  if (res.rowCount)
    syncAlbumIndexForCaptures(step.captureIds).catch((err: unknown) =>
      log.warn({ err: err instanceof Error ? err.message : err }, "Couldn't update the album recovery index"),
    );
}

export async function changeRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/changes",
    { preValidation: requireScope("album.read"), schema: { response: replies(Open({ changes: Type.Array(Batch) })) } },
    async (request) => {
      const res = await pool.query(
        `SELECT id, summary, created_at, undone_at FROM change_batches WHERE user_id = $1 AND app_name IS NULL
         ORDER BY created_at DESC LIMIT 20`,
        [request.user!.id],
      );
      return {
        changes: res.rows.map((r) => ({
          id: r.id,
          summary: r.summary,
          createdAt: r.created_at,
          undoneAt: r.undone_at,
        })),
      };
    },
  );

  app.post(
    "/changes",
    {
      preValidation: requireScope("album.write"),
      schema: {
        body: Type.Object(
          {
            summary: Type.String({
              minLength: 1,
              maxLength: 200,
              description: "What the assistant did, in a sentence",
            }),
            undo: Type.Array(UndoStep, { minItems: 1, maxItems: 5, description: "Steps that reverse the change" }),
          },
          { additionalProperties: false },
        ),
        response: replies(Open({ id: Uuid() })),
      },
    },
    async (request) => {
      const res = await pool.query<{ id: string }>(
        `INSERT INTO change_batches (user_id, summary, undo) VALUES ($1, $2, $3::jsonb) RETURNING id`,
        [request.user!.id, request.body.summary, JSON.stringify(request.body.undo)],
      );
      return { id: res.rows[0].id };
    },
  );

  app.post(
    "/changes/undo-last",
    {
      preValidation: requireScope("album.write"),
      schema: { response: replies(Open({ undone: Nullable(Open({ id: Uuid(), summary: Type.String() })) })) },
    },
    async (request) => {
      const userId = request.user!.id;
      const client = await pool.connect();
      let batch: { id: string; summary: string; undo: UndoStep[] } | undefined;
      try {
        await client.query("BEGIN");
        batch = (
          await client.query(
            `SELECT id, summary, undo FROM change_batches WHERE user_id = $1 AND undone_at IS NULL AND app_name IS NULL
             ORDER BY created_at DESC LIMIT 1 FOR UPDATE SKIP LOCKED`,
            [userId],
          )
        ).rows[0];
        if (batch) await client.query(`UPDATE change_batches SET undone_at = now() WHERE id = $1`, [batch.id]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
      if (!batch) return { undone: null };
      for (const step of batch.undo) await runStep(userId, step);
      return { undone: { id: batch.id, summary: batch.summary } };
    },
  );

  // Lifer's own list of what connected apps changed. Session only: an app can't read or undo it.
  app.get(
    "/changes/apps",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(Open({ changes: Type.Array(Open({ ...Batch.properties, appName: Type.String() })) })),
      },
    },
    async (request) => {
      const res = await pool.query(
        `SELECT id, app_name, summary, created_at, undone_at FROM change_batches WHERE user_id = $1 AND app_name IS NOT NULL
         ORDER BY created_at DESC LIMIT 50`,
        [request.user!.id],
      );
      return {
        changes: res.rows.map((r) => ({
          id: r.id,
          appName: r.app_name,
          summary: r.summary,
          createdAt: r.created_at,
          undoneAt: r.undone_at,
        })),
      };
    },
  );

  app.post(
    "/changes/:id/undo",
    {
      preValidation: requireAuth,
      config: notFoundOnInvalidId("Change not found"),
      schema: { params: IdParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      // Claimed in one statement, so a double click can't run the steps twice.
      const res = await pool.query<{ undo: (UndoStep | AppUndoStep)[] }>(
        `UPDATE change_batches SET undone_at = now() WHERE id = $1 AND user_id = $2 AND undone_at IS NULL RETURNING undo`,
        [request.params.id, userId],
      );
      const batch = res.rows[0];
      if (!batch) return reply.code(404).send({ error: "Change not found or already undone" });
      for (const step of batch.undo) await runStep(userId, step);
      return { ok: true };
    },
  );
}
