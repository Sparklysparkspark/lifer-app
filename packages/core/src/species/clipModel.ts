// The CLIP image model: where it lives, its opt-in download and offload.
import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  EMBEDDING_MODEL_GPU_BYTES,
  EMBEDDING_MODEL_GPU_URL,
  EMBEDDING_MODEL_URL,
  EMBEDDING_MODEL_VERSION,
  MODELS_DIR,
} from "../config.js";
import { isInferenceStuck as inferenceStuck, releaseModels } from "./inference.js";
import { createOnnxImageModel } from "./onnxImageModel.js";

// Opt-in download, never bundled. Holds the CLIP and identification models plus the text
// encoder cache, and is deleted wholesale on offload. In the OS cache folder on desktop (config.ts).
export const MODEL_DIR = MODELS_DIR;

export const clipModel = createOnnxImageModel({
  path: path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}.onnx`),
  url: EMBEDDING_MODEL_URL,
  label: "the species-matching model",
  missingMessage: "The species-matching model hasn't been downloaded (Settings > Offline Data)",
  family: "clip",
  gpuCopy: EMBEDDING_MODEL_GPU_URL
    ? {
        path: path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}-fp32.onnx`),
        url: EMBEDDING_MODEL_GPU_URL,
        bytes: EMBEDDING_MODEL_GPU_BYTES,
      }
    : null,
});

/** Whether the CLIP vision model has been downloaded. Cheap enough to call on every poll. */
export function isModelDownloaded(): boolean {
  return clipModel.isDownloaded();
}

/** Deletes CLIP files left by an earlier EMBEDDING_MODEL_VERSION. True when there were any, which
 * means this install had opted in to species matching. */
export function dropOlderClipModels(): boolean {
  if (!existsSync(MODEL_DIR)) return false;
  const current = (f: string) =>
    f.startsWith(`${EMBEDDING_MODEL_VERSION}.`) || f.startsWith(`${EMBEDDING_MODEL_VERSION}-`);
  const older = readdirSync(MODEL_DIR).filter((f) => f.startsWith("clip-vit-") && !current(f));
  for (const f of older) rmSync(path.join(MODEL_DIR, f), { force: true });
  return older.length > 0;
}

/** Deletes the whole model directory and frees every loaded session. Safe if nothing was downloaded. */
export function offloadModel(): void {
  rmSync(MODEL_DIR, { recursive: true, force: true });
  releaseModels(null);
}

/** Downloads the CLIP vision model (~307MB), resuming a partial file. */
export async function downloadModel(
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
  signal?: AbortSignal,
): Promise<void> {
  await clipModel.download(onProgress, signal);
}

export function isInferenceStuck(): boolean {
  return inferenceStuck();
}
