// POST /uploads/space: whether the drives an import writes to have room for a batch, so the
// Import page can match in smaller batches when space is tight and pause before the disk fills.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { requireScope } from "../auth/session.js";
import { checkImportSpace } from "../lib/importSpace.js";
import { Nullable, replies, withSchemas } from "../lib/schema.js";

export async function importSpaceRoutes(fastify: FastifyInstance): Promise<void> {
  withSchemas(fastify).post(
    "/uploads/space",
    {
      preValidation: requireScope("photos.write", ["imports.write"]),
      schema: {
        body: Type.Object(
          {
            files: Type.Integer({ minimum: 0, description: "Photos still to check or import" }),
            bytes: Type.Number({ minimum: 0, description: "Their total size" }),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            tier: Type.Enum(["ok", "tight", "critical"]),
            free: Nullable(Type.Number({ description: "Bytes free on the fullest drive involved" })),
            volume: Nullable(Type.Number({ description: "Device id of that drive" })),
            toFree: Type.Number({ description: "Bytes to free so the rest of the batch fits" }),
          }),
        ),
      },
    },
    // Only an import's own batch is remembered (files > 0); the app-wide check passes none.
    async (request) => checkImportSpace(request.body.files, request.body.bytes, request.body.files > 0),
  );
}
