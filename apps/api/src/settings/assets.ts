import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { MAPS_DIR, MAP_DOWNLOAD_URL } from "@lifer/core/config.js";
import { offloadAcceleration } from "../species/accelerationSetup.js";
import { modelDownload, startModelDownloadJob } from "../species/modelDownloadJob.js";
import { activeSuggestionModel, isModelDownloaded, offloadModel, MODEL_DIR } from "@lifer/core/species/embeddings.js";
import { idModel } from "@lifer/core/species/idModel.js";
import { galleryEmbeddingsJob, vectorUpdateProgress } from "../species/galleryEmbeddingsAsset.js";
import { isTextModelDownloaded } from "@lifer/core/species/textEmbedding.js";
import { createJob } from "../lib/job.js";
import { downloadToFile } from "../lib/download.js";
import { Ok, replies, withSchemas } from "../lib/schema.js";

const Started = Type.Object({ started: Type.Boolean() });
const Cancelled = Type.Object({ cancelled: Type.Boolean() });

async function dirSizeBytes(dir: string): Promise<number> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    total += entry.isDirectory() ? await dirSizeBytes(entryPath) : (await stat(entryPath)).size;
  }
  return total;
}

// Opt-in downloads of app-wide assets: the offline basemap and the species-matching models.
// Available on every install (a server wants the same downloads), unlike requireDesktopMode routes.
// None of these routes take input; job status answers are left unschematized because the web app
// reads whatever fields the job reports.
export async function assetRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  // Streams straight to disk and reports byte counts, since the server may not send a length.
  const mapJob = createJob<{ bytes: number }>("offline-map");
  const MAP_FILE_PATH = path.join(MAPS_DIR, "world-z8.pmtiles");

  app.get("/settings/map/status", { preValidation: requireAuth, schema: {} }, async () => ({
    available: MAP_DOWNLOAD_URL != null,
    downloaded: existsSync(MAP_FILE_PATH),
    // The on-disk size: the job's downloadedBytes resets on every restart.
    sizeBytes: existsSync(MAP_FILE_PATH) ? statSync(MAP_FILE_PATH).size : null,
    ...mapJob.status,
    // Alias for `running`, still read by the web app's onboarding page.
    downloading: mapJob.status.running,
  }));

  app.post(
    "/settings/map/download",
    { preValidation: requireAuth, schema: { response: replies(Started) } },
    async (_request, reply) => {
      const url = MAP_DOWNLOAD_URL;
      if (!url) return reply.code(400).send({ error: "No offline map is configured for this instance" });
      const started = mapJob.start(
        async (ctx) => {
          const tmpPath = `${MAP_FILE_PATH}.download`;
          mkdirSync(MAPS_DIR, { recursive: true });
          const { bytes } = await downloadToFile(url, tmpPath, {
            signal: ctx.signal,
            onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
          });
          ctx.throwIfCancelled();
          renameSync(tmpPath, MAP_FILE_PATH);
          return { bytes };
        },
        { phase: "downloading", downloadedBytes: 0 },
      );
      if (!started) return reply.code(409).send({ error: "The map is already downloading" });
      return { started: true };
    },
  );

  app.post(
    "/settings/map/download/cancel",
    { preValidation: requireAuth, schema: { response: replies(Cancelled) } },
    async () => ({ cancelled: mapJob.cancel() }),
  );

  app.delete("/settings/map", { preValidation: requireAuth, schema: { response: replies(Ok) } }, async () => {
    rmSync(MAP_FILE_PATH, { force: true });
    return { ok: true };
  });

  // The status route is polled every second or two, so the model folder's size is cached until a
  // download or offload, and refreshed at most every few seconds while a download writes to it.
  const MODEL_SIZE_REFRESH_WHILE_RUNNING_MS = 5_000;
  let modelSizeCache: { bytes: number; at: number } | null = null;
  let modelDownloadWasRunning = false;
  function invalidateModelSize(): void {
    modelSizeCache = null;
  }
  async function modelDirSizeBytes(): Promise<number> {
    const running = modelDownload.status.running;
    // The download just finished: its final size hasn't been measured yet.
    if (modelDownloadWasRunning && !running) invalidateModelSize();
    modelDownloadWasRunning = running;
    const fresh = modelSizeCache && (!running || Date.now() - modelSizeCache.at < MODEL_SIZE_REFRESH_WHILE_RUNNING_MS);
    if (fresh) return modelSizeCache!.bytes;
    const bytes = await dirSizeBytes(MODEL_DIR).catch(() => 0);
    modelSizeCache = { bytes, at: Date.now() };
    return bytes;
  }

  function vectorProgressShown() {
    const progress = vectorUpdateProgress();
    const own = modelDownload.status;
    if (!progress || (own.running && own.phase !== "waiting_for_vectors")) return {};
    return {
      running: true,
      phase: progress.phase ?? null,
      downloadedBytes: progress.downloadedBytes ?? null,
      totalBytes: progress.totalBytes ?? null,
      processed: progress.processed ?? null,
      total: progress.total ?? null,
      currentItem: progress.currentItem ?? null,
    };
  }

  // JobStatus plus what's installed and how big it is.
  app.get("/settings/embedding-model/status", { preValidation: requireAuth, schema: {} }, async () => ({
    ...modelDownload.status,
    // While this download waits for the reference vectors, or another job installs them, show
    // that job's progress instead of a bare "waiting".
    ...vectorProgressShown(),
    activeModel: await activeSuggestionModel(pool),
    // All three models: without the identification model, suggestions fall back to the older,
    // less accurate CLIP-only matching, so the download prompt should still show.
    downloaded: isModelDownloaded() && isTextModelDownloaded() && idModel.isDownloaded(),
    idModelDownloaded: idModel.isDownloaded(),
    // Suggestions work on the CLIP models alone, just less accurately.
    usable: isModelDownloaded() && isTextModelDownloaded(),
    sizeBytes: (await modelDirSizeBytes()) || null,
  }));

  app.post(
    "/settings/embedding-model/download",
    { preValidation: requireAuth, schema: { response: replies(Started) } },
    async (request, reply) => {
      if (!startModelDownloadJob(pool, app.log)) {
        return reply.code(409).send({ error: "The model is already downloading" });
      }
      invalidateModelSize();
      // Offloading turned suggestions off for everyone; downloading again is the way back.
      await pool.query(`UPDATE users SET species_suggest_enabled = true WHERE id = $1`, [request.user!.id]);
      return { started: true };
    },
  );

  app.post(
    "/settings/embedding-model/download/cancel",
    { preValidation: requireAuth, schema: { response: replies(Cancelled) } },
    async () => {
      const download = modelDownload.cancel();
      const vectors = galleryEmbeddingsJob.cancel();
      return { cancelled: download || vectors };
    },
  );

  // Also turns species-suggest off for every user (there's one model per install), so no one is
  // left with a suggestion UI that can't return results.
  app.delete(
    "/settings/embedding-model",
    { preValidation: requireAuth, schema: { response: replies(Ok) } },
    async () => {
      // Stop a running download or vector install so it doesn't carry on against deleted files.
      modelDownload.cancel();
      galleryEmbeddingsJob.cancel();
      offloadModel();
      offloadAcceleration();
      invalidateModelSize();
      await pool.query(`UPDATE users SET species_suggest_enabled = false`);
      return { ok: true };
    },
  );
}
