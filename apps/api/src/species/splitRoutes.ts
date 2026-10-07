// The "Name changed" card: a species you have photos of was split, and where they were taken
// doesn't settle which of the new species they are (species/speciesSplits.ts). You pick one, or
// keep the old name, for all of that species' photos still waiting.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { reassignCaptureSpecies } from "../captures/routes.js";
import { IdParams, Uuid, notFoundOnInvalidId, withSchemas } from "../lib/schema.js";
import { splitOptions } from "./speciesSplits.js";

const speciesNotFound = notFoundOnInvalidId("Species not found");

export async function splitRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  const optionsRoute = { preValidation: requireAuth, config: speciesNotFound, schema: { params: IdParams } };
  app.get("/species/:id/split", optionsRoute, async (request) => splitOptions(request.user!.id, request.params.id));

  // Body: { speciesId } to move the waiting photos to one of the new species, or { keep: true }
  // to say the old name is right for them.
  app.post(
    "/species/:id/split",
    {
      preValidation: requireScope("photos.write"),
      config: speciesNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            speciesId: Type.Optional(Uuid({ description: "One of the species it was split into" })),
            keep: Type.Optional(Type.Boolean({ description: "True to keep the old name for these photos" })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { speciesId, keep } = request.body;
      const userId = request.user!.id;
      const options = await splitOptions(userId, id);
      if (keep === true) {
        await pool.query(
          `INSERT INTO species_split_kept (capture_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`,
          [options.captureIds],
        );
        return { ok: true, updated: options.captureIds.length };
      }
      if (!speciesId || !options.species.some((s) => s.id === speciesId)) {
        return reply.code(400).send({ error: "Pick one of the species it was split into" });
      }
      let updated = 0;
      for (const captureId of options.captureIds) {
        const result = await reassignCaptureSpecies(userId, captureId, speciesId, request.log);
        if (!result.ok) return reply.code(result.status).send({ error: result.error });
        updated++;
      }
      return { ok: true, updated };
    },
  );
}
