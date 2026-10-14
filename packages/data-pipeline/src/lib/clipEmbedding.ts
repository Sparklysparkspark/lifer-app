// CLIP vectors for the catalog, from the app's own inference code (packages/core species/), so
// the preprocessing (orientation, grayscale, pixel limit) matches what installs compute. The
// catalog's vectors come from the full-precision weights, which GPUs run and the int8 copy CPUs
// run agrees with closely.
import sharp from "sharp";
import { setPlan } from "@lifer/core/species/acceleration.js";
import { clipModel } from "@lifer/core/species/embeddings.js";
import { stopInference } from "@lifer/core/species/inference.js";

/** Runs the "clip" model from the full-precision file on the CPU. */
export function forceFullPrecisionClip(fp32Path: string): void {
  setPlan({
    device: null,
    runtime: null,
    placements: { clip: { backend: "cpu", modelPath: fp32Path, providers: ["cpu"], force: true } },
  });
}

/** Downloads both CLIP files (checksum-verified, skipped when already there) and runs the
 *  full-precision one. computeEmbedding checks for the int8 file before running. */
export async function prepareClip(): Promise<void> {
  const fp32 = clipModel.gpuCopy;
  if (!fp32) throw new Error("No full-precision CLIP model is configured (EMBEDDING_MODEL_GPU_URL)");
  await clipModel.download();
  await clipModel.downloadGpuCopy();
  forceFullPrecisionClip(fp32.path);
}

/** Lets the process exit: the inference worker thread otherwise keeps it alive. */
export async function closeClip(): Promise<void> {
  await stopInference();
}

/** One channel, or gray plus alpha: lets a pass recompute just these photos' vectors. */
export async function isGrayscaleImage(filePath: string): Promise<boolean> {
  const { channels } = await sharp(filePath).metadata();
  return channels != null && channels < 3;
}
