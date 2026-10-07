// The species identification model (BioCLIP 2) as a local ONNX image encoder. Suggestions use it
// whenever it's downloaded and its reference vectors are installed; otherwise they fall back to
// the CLIP model (embeddings.ts). See packages/shared/src/idModel.ts for why there are two.
import path from "node:path";
import { APP_DATA_DIR, ID_MODEL_GPU_BYTES, ID_MODEL_GPU_URL, ID_MODEL_URL, ID_MODEL_VERSION } from "../config.js";
import { createOnnxImageModel } from "./onnxImageModel.js";

interface ModelFile {
  path: string;
  url: string;
  bytes: number;
}

/** Which BioCLIP file this machine runs on its CPU, and the full-precision copy a GPU would run
 *  (null when the CPU file already is that copy).
 *
 *  Intel Macs bundle onnxruntime 1.23.2 (the last with Intel macOS builds; see
 *  apps/desktop/scripts/retarget-natives.js), which can't run the int8 file ("no ConvInteger(10)"
 *  kernel). They run the full-precision file on the CPU instead, downloading only that one. */
export function idModelFiles(
  platform: NodeJS.Platform,
  arch: string,
  dir: string,
  urls: { cpu: string; gpu: string; gpuBytes: number },
): { cpu: Pick<ModelFile, "path" | "url">; gpuCopy: ModelFile | null } {
  const fullPrecision: ModelFile = {
    path: path.join(dir, `${ID_MODEL_VERSION}-fp32.onnx`),
    url: urls.gpu,
    bytes: urls.gpuBytes,
  };
  if (platform === "darwin" && arch === "x64")
    return { cpu: { path: fullPrecision.path, url: fullPrecision.url }, gpuCopy: null };
  return { cpu: { path: path.join(dir, `${ID_MODEL_VERSION}.onnx`), url: urls.cpu }, gpuCopy: fullPrecision };
}

// Same directory as the CLIP model, so offloading the species-matching model removes both.
const files = idModelFiles(process.platform, process.arch, path.join(APP_DATA_DIR, "models"), {
  cpu: ID_MODEL_URL,
  gpu: ID_MODEL_GPU_URL,
  gpuBytes: ID_MODEL_GPU_BYTES,
});

export const idModel = createOnnxImageModel({
  path: files.cpu.path,
  url: files.cpu.url,
  label: "the species identification model",
  missingMessage: "The species identification model hasn't been downloaded (Settings > Offline Data)",
  family: "id",
  gpuCopy: files.gpuCopy,
});
