// Settings > Species-matching model download as a shared job (see lib/job.ts). Phases:
// "downloading_model" (the ~307MB vision model, byte progress), "downloading_text_model" (no
// byte progress), then the gallery vectors (galleryEmbeddingsAsset.ts phases
// "downloading_gallery_embeddings" and "applying_gallery_embeddings"). Suggestions work during
// that last phase using the one-per-species vectors already in the catalog.
import type { Pool } from "pg";
import { createJob } from "../lib/job.js";
import { downloadModel } from "./embeddings.js";
import { runEmbeddingBackfill, runSpeciesEmbeddingBackfill } from "./embeddingBackfill.js";
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
    return { referenceVectors };
  });
}
