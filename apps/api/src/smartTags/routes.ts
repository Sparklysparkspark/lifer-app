// Smart tags (docs/plans/smart-tags.md). ST-2 only reports how far the suggestion pass has got.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { requireScope } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { smartTagCounts, smartTagJob } from "./suggestionPass.js";

export async function smartTagRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  app.get(
    "/smart-tags/status",
    {
      preValidation: requireScope("photos.read"),
      schema: {
        response: replies(
          Type.Object({
            running: Type.Boolean({ description: "The suggestion pass is running now" }),
            total: Type.Integer({ description: "Your photos, trashed ones left out" }),
            evaluated: Type.Integer({ description: "Photos evaluated under the current vocabulary and data" }),
            pending: Type.Integer({ description: "Photos waiting for the pass" }),
          }),
        ),
      },
    },
    async (request) => {
      const { total, pending } = await smartTagCounts(request.user!.id);
      return { running: smartTagJob.status.running, total, evaluated: total - pending, pending };
    },
  );
}
