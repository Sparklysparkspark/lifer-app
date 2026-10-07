// Species-matching endpoints that aren't about one species.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { Nullable, Uuid, withSchemas } from "../lib/schema.js";
import { EMBED_PIPELINE_VERSION } from "@lifer/shared";
import { EMBEDDING_MODEL_URL, EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "@lifer/core/config.js";
import { CLIENT_VECTOR_DIMS } from "@lifer/core/species/clientVectors.js";
import {
  activeSuggestionModel,
  isModelDownloaded,
  warmSuggestions,
  type PhotoVectorKind,
} from "@lifer/core/species/embeddings.js";
import { idModel } from "@lifer/core/species/idModel.js";
import { inferenceRuntime } from "@lifer/core/species/inference.js";
import { accelerationStatus } from "./accelerationSelect.js";
import { startAccelerationSelection } from "./accelerationSetup.js";
import { expectedModelSha256, YOLO_MODEL_SHA256, YOLO_MODEL_VERSION } from "@lifer/core/species/modelChecksums.js";
import { TEXT_MODEL, isTextModelDownloaded } from "@lifer/core/species/textEmbedding.js";

export async function matchingRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Called when the import page opens, so models and candidates are loaded before the first photo
  // is checked. Returns at once; the work runs at background priority.
  const warmOptions = {
    preValidation: requireAuth,
    schema: { body: Type.Object({ regionId: Type.Optional(Nullable(Uuid())) }, { additionalProperties: false }) },
  };
  app.post("/species/matching/warm", warmOptions, async (request, reply) => {
    const regionId = request.body.regionId ?? null;
    const userId = request.user!.id;
    warmSuggestions(pool, userId, regionId, isTextModelDownloaded() ? TEXT_MODEL : null).catch((err) =>
      request.log.warn({ err }, "Couldn't warm up species matching"),
    );
    return reply.code(202).send({ warming: true });
  });

  // Where matching runs on this install (the CPU or a GPU) and how fast, for Settings.
  app.get("/species/matching-hardware", { preValidation: requireAuth, schema: {} }, async () => accelerationStatus());
  app.post("/species/matching-hardware/retest", { preValidation: requireAuth, schema: {} }, async (_request, reply) => {
    startAccelerationSelection({ force: true });
    return reply.code(202).send(accelerationStatus());
  });

  // What a desktop app needs to compute import vectors exactly as this server would: model files
  // (URL and sha256), the preprocessing version, and which vectors this server uses (`targets`).
  app.get("/species/matching-info", { preValidation: requireAuth, schema: {} }, async () => {
    const activeModel = await activeSuggestionModel(pool);
    const targets: PhotoVectorKind[] = [];
    if (isModelDownloaded()) targets.push("clip");
    if (idModel.isDownloaded()) targets.push("id-crop");
    if (activeModel === "general") targets.push("clip-crop");
    return {
      pipelineVersion: EMBED_PIPELINE_VERSION,
      runtime: inferenceRuntime(),
      activeModel,
      targets,
      models: {
        clip: {
          version: EMBEDDING_MODEL_VERSION,
          url: EMBEDDING_MODEL_URL,
          sha256: expectedModelSha256(EMBEDDING_MODEL_URL),
        },
        ...(idModel.isDownloaded()
          ? {
              bioclip: {
                version: ID_MODEL_VERSION,
                // The file this server runs on its CPU (full precision on an Intel Mac, see idModel.ts).
                url: idModel.url,
                sha256: expectedModelSha256(idModel.url),
                // The full-precision copy a desktop app runs if its own GPU is faster (acceleration.ts),
                // when the CPU file isn't already that copy.
                ...(idModel.gpuCopy
                  ? { gpu: { url: idModel.gpuCopy.url, sha256: expectedModelSha256(idModel.gpuCopy.url) } }
                  : {}),
              },
            }
          : {}),
        yolo: { version: YOLO_MODEL_VERSION, sha256: YOLO_MODEL_SHA256 },
      },
      dims: CLIENT_VECTOR_DIMS,
    };
  });
}
