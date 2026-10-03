// The "Name changed" card: a species you have photos of was split, and where they were taken
// doesn't settle which of the new species they are (species/speciesSplits.ts). You pick one, or
// keep the old name, for all of that species' photos still waiting.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { reassignCaptureSpecies } from "../captures/routes.js";
import { isUuid } from "../lib/validate.js";
import { splitOptions } from "./speciesSplits.js";

export async function splitRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/species/:id/split", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Species not found" });
    return splitOptions(request.user!.id, request.params.id);
  });

  // Body: { speciesId } to move the waiting photos to one of the new species, or { keep: true }
  // to say the old name is right for them.
  app.post<{ Params: { id: string }; Body: { speciesId?: string; keep?: boolean } }>(
    "/species/:id/split",
    { preHandler: requireScope("photos.write") },
    async (request, reply) => {
      const { id } = request.params;
      const { speciesId, keep } = request.body ?? {};
      const userId = request.user!.id;
      if (!isUuid(id)) return reply.code(404).send({ error: "Species not found" });
      if (speciesId !== undefined && !isUuid(speciesId)) return reply.code(400).send({ error: "Pick one of the species it was split into" });
      const options = await splitOptions(userId, id);
      if (keep === true) {
        await pool.query(`INSERT INTO species_split_kept (capture_id) SELECT unnest($1::uuid[]) ON CONFLICT DO NOTHING`, [options.captureIds]);
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
