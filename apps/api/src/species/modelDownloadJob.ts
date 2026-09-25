// Settings > Species-matching model download as a shared job (see lib/job.ts). Phases:
// "downloading_model" (the ~307MB CLIP vision model, byte progress), "downloading_text_model"
// (no byte progress), "downloading_id_model" (the ~308MB species identification model, byte
// progress), then the reference vectors for both (galleryEmbeddingsAsset.ts phases). Suggestions
// work throughout, on whichever model and vectors are already there.
import type { Pool } from "pg";
import { createJob, type JobContext } from "../lib/job.js";
import { downloadModel, isModelDownloaded } from "./embeddings.js";
import { runEmbeddingBackfill, runIdEmbeddingBackfill, runSpeciesEmbeddingBackfill } from "./embeddingBackfill.js";
import { idModel } from "./idModel.js";
import { runGalleryEmbeddingsUpdate, type ReferenceVectorsResult } from "./galleryEmbeddingsAsset.js";
import { downloadTextModel } from "./textEmbedding.js";

export interface ModelDownloadResult {
  referenceVectors: ReferenceVectorsResult;
}

export const modelDownload = createJob<ModelDownloadResult>("embedding-model");

export function startModelDownloadJob(pool: Pool, log: { warn: (obj: object, msg: string) => void }): boolean {
  return modelDownload.start(async (ctx) => {
    ctx.update({ phase: "downloading_model", downloadedBytes: 0, totalBytes: null });
    await downloadModel((downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }), ctx.signal);
    ctx.throwIfCancelled();
    ctx.update({ phase: "downloading_text_model", downloadedBytes: null, totalBytes: null });
    await downloadTextModel();
    ctx.throwIfCancelled();
    await downloadIdModel(ctx);

    // Anything enriched or imported while the model was missing skipped its embedding; catch up now.
    runEmbeddingBackfill().catch((err) => log.warn({ err }, "Capture embedding catch-up backfill failed"));
    runSpeciesEmbeddingBackfill().catch((err) => log.warn({ err }, "Species embedding catch-up backfill failed"));

    // The model is usable already; a failure fetching the reference vectors is reported in the
    // result instead of failing the whole download. Startup retries it.
    let referenceVectors: ReferenceVectorsResult;
    try {
      referenceVectors = await runGalleryEmbeddingsUpdate(pool, ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      log.warn({ err }, "Reference vectors download failed");
      const failed = { status: "failed" as const, error: (err as Error).message };
      referenceVectors = { gallery: failed, speciesImage: failed, speciesText: failed };
    }
    runIdEmbeddingBackfill().catch((err) => log.warn({ err }, "Identification embedding catch-up backfill failed"));
    return { referenceVectors };
  });
}

async function downloadIdModel(ctx: JobContext<ModelDownloadResult>): Promise<void> {
  if (idModel.isDownloaded()) return;
  ctx.update({ phase: "downloading_id_model", downloadedBytes: 0, totalBytes: null });
  await idModel.download((downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }), ctx.signal);
  ctx.throwIfCancelled();
}

/** Installs that downloaded the species-matching model before the identification model existed
 * get it now, in the background: they already opted in to species matching, and this is the
 * same feature getting better, not a new download to ask about (same as the reference vectors,
 * which already refresh on their own). A no-op once it's there, or without the CLIP model. */
export function ensureIdModelOnStartup(pool: Pool, log: { warn: (obj: object, msg: string) => void }): void {
  if (!isModelDownloaded() || idModel.isDownloaded()) {
    if (idModel.isDownloaded()) runIdEmbeddingBackfill().catch((err) => log.warn({ err }, "Identification embedding backfill failed"));
    return;
  }
  modelDownload.start(async (ctx) => {
    await downloadIdModel(ctx);
    let referenceVectors: ReferenceVectorsResult;
    try {
      referenceVectors = await runGalleryEmbeddingsUpdate(pool, ctx);
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      log.warn({ err }, "Identification vectors download failed");
      const failed = { status: "failed" as const, error: (err as Error).message };
      referenceVectors = { gallery: failed, speciesImage: failed, speciesText: failed };
    }
    runIdEmbeddingBackfill().catch((err) => log.warn({ err }, "Identification embedding catch-up backfill failed"));
    return { referenceVectors };
  });
}
