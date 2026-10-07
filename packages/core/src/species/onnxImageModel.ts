// One locally-run ONNX image encoder as the rest of the app sees it: download, is-it-there,
// embed, release. Shared by the CLIP model and the identification model (both ViT-L/14 with the
// same input and normalization). The session itself lives in the inference worker.
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { downloadResumable } from "../lib/resumableDownload.js";
import { placementFor, type ModelFamily } from "./acceleration.js";
import {
  analyzeImage,
  isInferenceStuck,
  releaseModels,
  type EmbedTarget,
  type ImageSource,
  type Priority,
} from "./inference.js";
import { expectedModelSha256 } from "./modelChecksums.js";

export { l2Normalize, preprocessImage } from "./inferenceWorker.js";

export interface OnnxImageModel {
  /** Where the .onnx file lives once downloaded. */
  readonly path: string;
  readonly url: string;
  /** Cheap and sync, safe to call from a status endpoint on every poll. */
  isDownloaded(): boolean;
  /** Streams to disk with an atomic rename on completion, resuming a partial file, and checks
   *  the file's sha256 when the default URL's checksum is known (modelChecksums.ts). */
  download(
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** Drops the loaded session (after its file was deleted). */
  release(): void;
  /** L2-normalized embedding of the whole photo. */
  embedVector(image: ImageSource, opts?: { priority?: Priority; key?: string | null }): Promise<Float32Array>;
  /** embedVector as a plain array, for callers that store it straight into Postgres (node-postgres
   *  would send a Float32Array as bytea). Background priority. */
  embed(buffer: Buffer): Promise<number[]>;
  /** The worker keeps timing out: refuse new background work until it recovers. */
  isStuck(): boolean;
  /** This model as an inference target, on the backend and copy it runs on (acceleration.ts). */
  target(crop: boolean): EmbedTarget;
  readonly family: ModelFamily;
  /** The full-precision copy GPUs run, when one is published. Downloaded only on a machine with a
   *  GPU that passes the hardware self-test (accelerationSelect.ts). */
  readonly gpuCopy: { path: string; url: string; bytes: number } | null;
  downloadGpuCopy(
    onProgress?: (downloadedBytes: number, totalBytes: number | null) => void,
    signal?: AbortSignal,
  ): Promise<void>;
}

export function createOnnxImageModel(opts: {
  path: string;
  url: string;
  family: ModelFamily;
  gpuCopy?: { path: string; url: string; bytes: number } | null;
  /** For download errors, e.g. "the species-matching model". */
  label: string;
  /** Thrown by embed() when the file isn't there. */
  missingMessage: string;
}): OnnxImageModel {
  const target = (crop: boolean): EmbedTarget => ({
    ...placementFor(opts.family, opts.path),
    missingMessage: opts.missingMessage,
    crop,
  });
  const embedVector: OnnxImageModel["embedVector"] = async (image, o = {}) => {
    // Checked here too, so a missing model fails fast without starting the worker.
    if (!existsSync(opts.path)) throw new Error(opts.missingMessage);
    const { vectors } = await analyzeImage(image, {
      targets: [target(false)],
      key: o.key,
      priority: o.priority ?? "background",
    });
    const v = vectors[0];
    if (!(v instanceof Float32Array)) throw new Error(v.error);
    return v;
  };
  return {
    path: opts.path,
    url: opts.url,
    // Never auto-downloads: the model is an opt-in download.
    isDownloaded: () => existsSync(opts.path),
    async download(onProgress, signal) {
      mkdirSync(path.dirname(opts.path), { recursive: true });
      await downloadResumable(opts.url, opts.path, {
        signal,
        onProgress,
        label: opts.label,
        expectedSha256: expectedModelSha256(opts.url),
      });
    },
    release: () => releaseModels(opts.path),
    embedVector,
    embed: async (buffer) => Array.from(await embedVector(buffer)),
    isStuck: isInferenceStuck,
    target,
    family: opts.family,
    gpuCopy: opts.gpuCopy ?? null,
    async downloadGpuCopy(onProgress, signal) {
      const copy = opts.gpuCopy;
      if (!copy) return;
      mkdirSync(path.dirname(copy.path), { recursive: true });
      await downloadResumable(copy.url, copy.path, {
        signal,
        onProgress,
        label: opts.label,
        expectedSha256: expectedModelSha256(copy.url),
      });
    },
  };
}
