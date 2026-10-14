// The scene segmentation model as the rest of the app sees it: download, is-it-there, analyze,
// release. Gallery search reads what it finds (capture_scenes) for words like "water" or "fence".
// CPU only: one run per photo, at import or in a backfill.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { MODELS_DIR, SCENE_MODEL_FP32_URL, SCENE_MODEL_URL, SCENE_MODEL_VERSION } from "../config.js";
import { downloadResumable } from "../lib/resumableDownload.js";
import {
  analyzeScene,
  isInferenceStuck,
  releaseModels,
  type ImageSource,
  type Priority,
  type SceneResult,
} from "./inference.js";
import { expectedModelSha256 } from "./modelChecksums.js";

/** The scene model file this machine runs. Intel Macs bundle an onnxruntime that can't run the
 *  int8 file (see idModel.ts), so they download the full-precision one instead. */
export function sceneModelFile(
  platform: NodeJS.Platform,
  arch: string,
  dir: string,
  urls: { int8: string; fp32: string },
): { path: string; url: string } {
  if (platform === "darwin" && arch === "x64")
    return { path: path.join(dir, `${SCENE_MODEL_VERSION}-fp32.onnx`), url: urls.fp32 };
  return { path: path.join(dir, `${SCENE_MODEL_VERSION}.onnx`), url: urls.int8 };
}

// In MODELS_DIR, so offloading the species-matching models removes it too.
const file = sceneModelFile(process.platform, process.arch, MODELS_DIR, {
  int8: SCENE_MODEL_URL,
  fp32: SCENE_MODEL_FP32_URL,
});
const missingMessage = "The scene model hasn't been downloaded (Settings > Offline Data)";

export const sceneModel = {
  path: file.path,
  url: file.url,
  /** Cheap and sync, safe to call from a status endpoint on every poll. */
  isDownloaded: () => existsSync(file.path),
  async download(
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(path.dirname(file.path), { recursive: true });
    await downloadResumable(file.url, file.path, {
      signal,
      onProgress,
      label: "the scene model",
      expectedSha256: expectedModelSha256(file.url),
    });
  },
  release: () => releaseModels(file.path),
  isStuck: isInferenceStuck,
  analyze(image: ImageSource, priority: Priority = "background"): Promise<SceneResult> {
    // Checked here too, so a missing model fails fast without starting the worker.
    if (!existsSync(file.path)) return Promise.reject(new Error(missingMessage));
    return analyzeScene(image, { modelPath: file.path, missingMessage }, priority);
  },
};

/** Stores what the scene model finds in a capture's photo, replacing any earlier result. A no-op
 *  when the model isn't downloaded. */
export async function storeCaptureScene(
  client: Pool | PoolClient,
  captureId: string,
  photoId: string,
  image: ImageSource,
  opts: { priority?: Priority } = {},
): Promise<void> {
  if (!sceneModel.isDownloaded()) return;
  const { labels, colors } = await sceneModel.analyze(image, opts.priority ?? "background");
  await client.query(
    `INSERT INTO capture_scenes (capture_id, photo_id, model_version, labels, colors)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (capture_id) DO UPDATE SET photo_id = EXCLUDED.photo_id, model_version = EXCLUDED.model_version,
       labels = EXCLUDED.labels, colors = EXCLUDED.colors, computed_at = now()`,
    [captureId, photoId, SCENE_MODEL_VERSION, labels, colors],
  );
}
