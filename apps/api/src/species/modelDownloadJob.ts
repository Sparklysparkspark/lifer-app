// Settings > Species-matching model download as a shared job. Phases: "downloading_model",
// "downloading_text_model" (no byte progress), "downloading_id_model", then the reference vectors.
// Suggestions keep working on whatever is already there.
import type { Pool } from "pg";
import { startAccelerationSelection } from "./accelerationSetup.js";
import { createJob, type JobContext } from "../lib/job.js";
import { clipModel, downloadModel, dropOlderClipModels, isModelDownloaded } from "./embeddings.js";
import { runEmbeddingBackfill, runIdEmbeddingBackfill, runSpeciesEmbeddingBackfill } from "./embeddingBackfill.js";
import { idModel } from "./idModel.js";
import { runGalleryEmbeddingsUpdate, type ReferenceVectorsResult } from "./galleryEmbeddingsAsset.js";
import { downloadTextModel } from "./textEmbedding.js";
import { verifyModelFile } from "./modelChecksums.js";
import type { OnnxImageModel } from "./onnxImageModel.js";

export interface ModelDownloadResult {
  referenceVectors: ReferenceVectorsResult;
}

export const modelDownload = createJob<ModelDownloadResult>("embedding-model");

export function startModelDownloadJob(pool: Pool, log: { warn: (obj: object, msg: string) => void }): boolean {
  return modelDownload.start(async (ctx) => {
    // Only what's missing is downloaded. A file already there is checked against its sha256
    // first, so a corrupt one downloads again.
    await dropIfCorrupt(clipModel);
    if (!isModelDownloaded()) {
      ctx.update({ phase: "downloading_model", downloadedBytes: 0, totalBytes: null });
      await downloadModel((downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }), ctx.signal);
      ctx.throwIfCancelled();
    }
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
    startAccelerationSelection();
    return { referenceVectors };
  });
}

/** Deletes a downloaded model file whose sha256 doesn't match (no-op without a known checksum). */
async function dropIfCorrupt(model: OnnxImageModel): Promise<void> {
  if (!model.isDownloaded()) return;
  if (!(await verifyModelFile(model.path, model.url))) model.release();
}

async function downloadIdModel(ctx: JobContext<ModelDownloadResult>): Promise<void> {
  await dropIfCorrupt(idModel);
  if (idModel.isDownloaded()) return;
  ctx.update({ phase: "downloading_id_model", downloadedBytes: 0, totalBytes: null });
  await idModel.download((downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }), ctx.signal);
  ctx.throwIfCancelled();
}

/** Installs that already opted in to species matching get the identification model, and a new
 * CLIP version, in the background. A no-op once they're there, or for an install that never opted in. */
export function ensureIdModelOnStartup(pool: Pool, log: { warn: (obj: object, msg: string) => void }): void {
  if (dropOlderClipModels() && !isModelDownloaded()) {
    startModelDownloadJob(pool, log);
    return;
  }
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
    startAccelerationSelection();
    return { referenceVectors };
  });
}
