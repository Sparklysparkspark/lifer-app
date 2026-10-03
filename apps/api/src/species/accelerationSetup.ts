// Runs the hardware self-test (accelerationSelect.ts) for this install's models. Only once species
// matching is set up: a machine that never matches species doesn't download GPU files. LIFER_GPU=off
// keeps everything on the CPU, for troubleshooting.
import { rmSync } from "node:fs";
import path from "node:path";
import { APP_DATA_DIR } from "../config.js";
import { cancelAcceleration, forgetAcceleration, selectAcceleration, type AcceleratedModel } from "./accelerationSelect.js";
import { clipModel } from "./embeddings.js";
import { idModel } from "./idModel.js";
import { DETECTOR_MODEL_PATH } from "./inference.js";
import type { OnnxImageModel } from "./onnxImageModel.js";

const CACHE_FILE = path.join(APP_DATA_DIR, "acceleration.json");
const GPU_RUNTIME_ROOT = path.join(APP_DATA_DIR, "gpu-runtime");
const ENCODER_DIMS = [1, 3, 224, 224];

const gpuDisabled = () => process.env.LIFER_GPU?.toLowerCase() === "off";

function encoder(model: OnnxImageModel): AcceleratedModel {
  return {
    family: model.family,
    cpuPath: model.path,
    gpuPath: model.gpuCopy?.path ?? null,
    downloadGpuCopy: (onProgress) => model.downloadGpuCopy(onProgress),
    dims: ENCODER_DIMS,
  };
}

/** Starts the self-test in the background, or applies the remembered result. Never throws. */
export function startAccelerationSelection(opts: { force?: boolean } = {}): void {
  if (gpuDisabled() || !(idModel.isDownloaded() || clipModel.isDownloaded())) return;
  if (opts.force) forgetAcceleration(CACHE_FILE);
  const models: AcceleratedModel[] = [
    { family: "detector", cpuPath: DETECTOR_MODEL_PATH, gpuPath: DETECTOR_MODEL_PATH, downloadGpuCopy: async () => {}, dims: [1, 3, 640, 640] },
    ...[idModel, clipModel].filter((m) => m.isDownloaded()).map(encoder),
  ];
  void selectAcceleration({ cacheFile: CACHE_FILE, gpuRuntimeRoot: GPU_RUNTIME_ROOT, models, force: opts.force });
}

/** With the models offloaded: back to the CPU, and the GPU files go too. */
export function offloadAcceleration(): void {
  cancelAcceleration();
  forgetAcceleration(CACHE_FILE);
  rmSync(GPU_RUNTIME_ROOT, { recursive: true, force: true });
}
