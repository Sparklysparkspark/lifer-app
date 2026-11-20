import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { Uuid, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";

// Each action pairs with the one that reverses it, so Undo is the same call with the ids
// that actually changed.
const ACTIONS = ["target", "untarget", "seen", "unseen", "archive", "unarchive"] as const;

const BulkBody = Type.Object(
  { speciesIds: Type.Array(Uuid(), { minItems: 1, maxItems: 50000 }), action: Type.Enum(ACTIONS) },
  { additionalProperties: false },
);

const SQL: Record<(typeof ACTIONS)[number], string> = {
  // Only rows that change are returned, so Undo never touches what was already set.
  target: `INSERT INTO user_species (user_id, species_id, is_target) SELECT $1, UNNEST($2::uuid[]), true
           ON CONFLICT (user_id, species_id) DO UPDATE SET is_target = true WHERE NOT user_species.is_target
           RETURNING species_id`,
  untarget: `UPDATE user_species SET is_target = false WHERE user_id = $1 AND species_id = ANY($2) AND is_target
             RETURNING species_id`,
  // Seen never overwrites collected.
  seen: `INSERT INTO user_species (user_id, species_id, state) SELECT $1, UNNEST($2::uuid[]), 'seen'
         ON CONFLICT (user_id, species_id) DO UPDATE SET state = 'seen' WHERE user_species.state IS NULL
         RETURNING species_id`,
  unseen: `UPDATE user_species SET state = NULL WHERE user_id = $1 AND species_id = ANY($2) AND state = 'seen'
           RETURNING species_id`,
  // Same exemption as /archive/bulk: collected or seen species are never archived.
  archive: `INSERT INTO user_archived_species (user_id, species_id)
            SELECT $1, s.id FROM species s
            LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
            WHERE s.id = ANY($2) AND us.state IS NULL
            ON CONFLICT DO NOTHING RETURNING species_id`,
  unarchive: `DELETE FROM user_archived_species WHERE user_id = $1 AND species_id = ANY($2) RETURNING species_id`,
};

export async function collectionBulkRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // One transaction per call; the reply lists the species that changed, which is what Undo sends back.
  app.post(
    "/collection/bulk",
    {
      preValidation: requireAuth,
      schema: {
        body: BulkBody,
        response: replies(Type.Object({ ok: Type.Boolean(), changedIds: Type.Array(Uuid()) })),
      },
    },
    async (request) => {
      const { speciesIds, action } = request.body;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const res = await client.query<{ species_id: string }>(SQL[action], [request.user!.id, speciesIds]);
        if (action === "unseen") {
          // A row with no state and no target is gone, so "no row" still means "unseen".
          await client.query(
            `DELETE FROM user_species WHERE user_id = $1 AND species_id = ANY($2) AND state IS NULL AND NOT is_target
               AND cover_photo_id IS NULL`,
            [request.user!.id, speciesIds],
          );
        }
        await client.query("COMMIT");
        return { ok: true, changedIds: res.rows.map((r) => r.species_id) };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
