// Species-matching endpoints that aren't about one species.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { isUuid } from "../lib/validate.js";
import { EMBED_PIPELINE_VERSION } from "@lifer/shared";
import { EMBEDDING_MODEL_URL, EMBEDDING_MODEL_VERSION, ID_MODEL_GPU_URL, ID_MODEL_URL, ID_MODEL_VERSION } from "../config.js";
import { CLIENT_VECTOR_DIMS } from "./clientVectors.js";
import { activeSuggestionModel, isModelDownloaded, warmSuggestions, type PhotoVectorKind } from "./embeddings.js";
import { idModel } from "./idModel.js";
import { inferenceRuntime } from "./inference.js";
import { accelerationStatus } from "./accelerationSelect.js";
import { startAccelerationSelection } from "./accelerationSetup.js";
import { expectedModelSha256, YOLO_MODEL_SHA256, YOLO_MODEL_VERSION } from "./modelChecksums.js";
import { TEXT_MODEL, isTextModelDownloaded } from "./textEmbedding.js";

export async function matchingRoutes(app: FastifyInstance): Promise<void> {
  // Called when the import page opens, so models and candidates are loaded before the first photo
  // is checked. Returns at once; the work runs at background priority.
  app.post<{ Body: { regionId?: string | null } | null }>("/species/matching/warm", { preHandler: requireAuth }, async (request, reply) => {
    const regionId = request.body?.regionId ?? null;
    if (regionId !== null && !isUuid(regionId)) return reply.code(400).send({ error: "regionId must be a region id" });
    const userId = request.user!.id;
    warmSuggestions(pool, userId, regionId, isTextModelDownloaded() ? TEXT_MODEL : null).catch((err) =>
      request.log.warn({ err }, "Couldn't warm up species matching"),
    );
    return reply.code(202).send({ warming: true });
  });

  // Where matching runs on this install (the CPU or a GPU) and how fast, for Settings.
  app.get("/species/matching-hardware", { preHandler: requireAuth }, async () => accelerationStatus());
  app.post("/species/matching-hardware/retest", { preHandler: requireAuth }, async (_request, reply) => {
    startAccelerationSelection({ force: true });
    return reply.code(202).send(accelerationStatus());
  });

  // What a desktop app needs to compute import vectors exactly as this server would: model files
  // (URL and sha256), the preprocessing version, and which vectors this server uses (`targets`).
  app.get("/species/matching-info", { preHandler: requireAuth }, async () => {
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
        clip: { version: EMBEDDING_MODEL_VERSION, url: EMBEDDING_MODEL_URL, sha256: expectedModelSha256(EMBEDDING_MODEL_URL) },
        ...(idModel.isDownloaded()
          ? {
              bioclip: {
                version: ID_MODEL_VERSION,
                url: ID_MODEL_URL,
                sha256: expectedModelSha256(ID_MODEL_URL),
                // The full-precision copy a desktop app runs if its own GPU is faster (acceleration.ts).
                gpu: { url: ID_MODEL_GPU_URL, sha256: expectedModelSha256(ID_MODEL_GPU_URL) },
              },
            }
          : {}),
        yolo: { version: YOLO_MODEL_VERSION, sha256: YOLO_MODEL_SHA256 },
      },
      dims: CLIENT_VECTOR_DIMS,
    };
  });
}
