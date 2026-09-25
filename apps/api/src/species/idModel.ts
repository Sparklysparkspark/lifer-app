// The species identification model (BioCLIP 2) as a local ONNX image encoder. Suggestions use it
// whenever it's downloaded and its reference vectors are installed; otherwise they fall back to
// the CLIP model (embeddings.ts). See packages/shared/src/idModel.ts for why there are two.
import path from "node:path";
import { APP_DATA_DIR, ID_MODEL_URL, ID_MODEL_VERSION } from "../config.js";
import { createOnnxImageModel } from "./onnxImageModel.js";

// Same directory as the CLIP model, so offloading the species-matching model removes both.
const ID_MODEL_PATH = path.join(APP_DATA_DIR, "models", `${ID_MODEL_VERSION}.onnx`);

export const idModel = createOnnxImageModel({
  path: ID_MODEL_PATH,
  url: ID_MODEL_URL,
  label: "the species identification model",
  missingMessage: "The species identification model hasn't been downloaded (Settings > Offline Data)",
});
