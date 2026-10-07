// Photos imported hidden: a culling app rejected them and the import was set to "import rejected
// photos hidden" (cullMarks.ts). They stay out of the `captures` view, so out of the gallery, the
// life list and the stats, until unhidden here. The Gallery's "Hidden" filter lists them.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { invalidateUserVectors } from "@lifer/core/species/embeddings.js";
import { requireAuth } from "../auth/session.js";
import { Uuid, replies, withSchemas } from "../lib/schema.js";
import { markCollected } from "../lib/userSpecies.js";
import { ensureDefaultCardCropLater } from "../collection/defaultCardCrop.js";

const MAX_BATCH_UNHIDE = 5000;

/** Unhides the user's hidden photos among captureIds, adding their species to the life list as
 *  an import would have. Returns how many were unhidden. */
export async function unhideCaptures(userId: string, captureIds: string[]): Promise<number> {
  const species = new Set<string>();
  const unhidden = await withTransaction(async (client) => {
    const res = await client.query<{
      id: string;
      species_id: string;
      current_photo_id: string | null;
      taken_at: string | null;
    }>(
      `UPDATE captures_all SET hidden_at = NULL
       WHERE id = ANY($1::uuid[]) AND user_id = $2 AND hidden_at IS NOT NULL AND deleted_at IS NULL
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
  });
  if (unhidden > 0) invalidateUserVectors(userId);
  for (const speciesId of species) ensureDefaultCardCropLater(userId, speciesId);
  return unhidden;
}

export async function hiddenCaptureRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/captures/unhide",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { captureIds: Type.Array(Uuid(), { minItems: 1, maxItems: MAX_BATCH_UNHIDE }) },
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
        `SELECT count(*)::int AS count FROM captures_all WHERE user_id = $1 AND hidden_at IS NOT NULL AND deleted_at IS NULL`,
        [request.user!.id],
      );
      return { count: res.rows[0]?.count ?? 0 };
    },
  );
}
