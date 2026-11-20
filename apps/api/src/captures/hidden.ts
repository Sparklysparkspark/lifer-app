// Hidden photos: imported hidden because a culling app rejected them (cullMarks.ts), or hidden by
// the user from a photo's menu. They stay out of the `captures` view, so out of the gallery, the
// life list and the stats, until unhidden here. The Gallery's "Hidden" filter lists them.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { requireAuth } from "../auth/session.js";
import { Uuid, replies, withSchemas } from "../lib/schema.js";
import { markCollected, repointCoversOffTrashedCaptures, syncCollectedState } from "../lib/userSpecies.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";

const MAX_BATCH = 5000;

/** SQL: capture `c` is not a photo version hidden behind its group's capture, which only a
 *  split brings back, so the Hidden filter leaves it out. */
export const NOT_A_LINKED_VERSION = `NOT EXISTS (SELECT 1 FROM capture_versions cv WHERE cv.capture_id = c.id AND cv.state = 'linked')`;

export interface HiddenCover {
  speciesId: string;
  photoId: string;
}

/** Hides the user's visible photos among captureIds, with the same species bookkeeping as moving
 *  them to the Trash. Returns how many were hidden, and the hand-picked featured photos that
 *  went with them so an undo can put them back. */
async function hideCaptures(userId: string, captureIds: string[]): Promise<{ hidden: number; covers: HiddenCover[] }> {
  const recropSpecies: string[] = [];
  const covers: HiddenCover[] = [];
  const hidden = await withTransaction(
    async (client) => (await hideCapturesTx(client, userId, captureIds, covers, recropSpecies)).length,
  );
  if (hidden > 0) invalidateUserVectors(userId);
  for (const speciesId of recropSpecies) ensureDefaultCardCropLater(userId, speciesId);
  return { hidden, covers };
}

/** hideCaptures inside the caller's transaction: returns the ids hidden. The caller refreshes
 *  vectors and re-crops recropSpecies after commit. */
export async function hideCapturesTx(
  client: PoolClient,
  userId: string,
  captureIds: string[],
  covers: HiddenCover[],
  recropSpecies: string[],
): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `UPDATE captures_all SET hidden_at = now()
     WHERE id = ANY($1::uuid[]) AND user_id = $2 AND hidden_at IS NULL AND deleted_at IS NULL
     RETURNING id`,
    [captureIds, userId],
  );
  const ids = res.rows.map((r) => r.id);
  // Only featured photos the user picked: an automatic one is chosen again by the usual rules.
  const coverRes = await client.query<HiddenCover>(
    `SELECT us.species_id AS "speciesId", us.cover_photo_id AS "photoId"
     FROM user_species us JOIN photos p ON p.id = us.cover_photo_id
     WHERE us.user_id = $1 AND p.capture_id = ANY($2::uuid[])
       AND us.cover_photo_id = us.cover_chosen_photo_id`,
    [userId, ids],
  );
  covers.push(...coverRes.rows);
  await syncCollectedState(client, userId, ids);
  recropSpecies.push(...(await repointCoversOffTrashedCaptures(client, userId, ids)));
  return ids;
}

/** Unhides the user's hidden photos among captureIds, adding their species to the life list as
 *  an import would have. Returns how many were unhidden. */
export async function unhideCaptures(userId: string, captureIds: string[]): Promise<number> {
  const species = new Set<string>();
  const unhidden = await withTransaction(async (client) => unhideCapturesTx(client, userId, captureIds, species));
  if (unhidden > 0) invalidateUserVectors(userId);
  for (const speciesId of species) ensureDefaultCardCropLater(userId, speciesId);
  return unhidden;
}

/** unhideCaptures inside the caller's transaction. Linked photo versions stay hidden behind their
 *  group (uploads/versionGrouping.ts). The caller refreshes vectors and re-crops after commit. */
export async function unhideCapturesTx(
  client: PoolClient,
  userId: string,
  captureIds: string[],
  species: Set<string>,
): Promise<number> {
  const res = await client.query<{
    id: string;
    species_id: string;
    current_photo_id: string | null;
    taken_at: string | null;
  }>(
    `UPDATE captures_all c SET hidden_at = NULL
     WHERE id = ANY($1::uuid[]) AND user_id = $2 AND hidden_at IS NOT NULL AND deleted_at IS NULL
       AND ${NOT_A_LINKED_VERSION}
     RETURNING id, species_id, current_photo_id, taken_at`,
    [captureIds, userId],
  );
  for (const row of res.rows) {
    await markCollected(client, userId, row.species_id, row.current_photo_id, row.taken_at);
    species.add(row.species_id);
    const extra = await client.query<{ species_id: string }>(
      `SELECT species_id FROM capture_species WHERE capture_id = $1`,
      [row.id],
    );
    for (const { species_id } of extra.rows) {
      await markCollected(client, userId, species_id, row.current_photo_id, row.taken_at);
      species.add(species_id);
    }
  }
  return res.rows.length;
}

export async function hiddenCaptureRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/captures/hide",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_BATCH }) },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            hidden: Type.Integer(),
            covers: Type.Array(Type.Object({ speciesId: Uuid(), photoId: Uuid() }), {
              description: "Species whose hand-picked featured photo was hidden, for an undo to set it again",
            }),
          }),
        ),
      },
    },
    async (request) => hideCaptures(request.user!.id, request.body.captureIds),
  );

  app.post(
    "/captures/unhide",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_BATCH }) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ unhidden: Type.Integer() })),
      },
    },
    async (request) => ({ unhidden: await unhideCaptures(request.user!.id, request.body.captureIds) }),
  );

  // How many hidden photos there are, so the Gallery only offers its "Hidden" filter when useful.
  app.get(
    "/captures/hidden-count",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ count: Type.Integer() })) } },
    async (request) => {
      const res = await pool.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM captures_all c
         WHERE user_id = $1 AND hidden_at IS NOT NULL AND deleted_at IS NULL AND ${NOT_A_LINKED_VERSION}`,
        [request.user!.id],
      );
      return { count: res.rows[0]?.count ?? 0 };
    },
  );
}
