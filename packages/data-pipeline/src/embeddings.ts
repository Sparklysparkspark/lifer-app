// Standalone copy of packages/core/src/species/embeddings.ts's model download and CLIP preprocessing,
// for scripts/backfill-reference-embeddings.ts. Duplicated rather than shared, so neither
// data-pipeline nor @lifer/shared (used by the web app) has to carry sharp/onnxruntime-node.
//
// Keep EMBEDDING_MODEL_URL/EMBEDDING_MODEL_VERSION and the preprocessing constants in sync with
// packages/core/src/config.ts and species/embeddings.ts: both must produce identical vectors for the
// same model_version.
import { mkdirSync, existsSync, renameSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import * as ort from "onnxruntime-node";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..", "..", "..");

// The full-precision weights: the catalog's stored vectors must match what GPUs compute, and the
// int8 copy CPUs run agrees with them closely enough. Must match packages/core/src/config.ts.
export const EMBEDDING_MODEL_URL =
  process.env.EMBEDDING_MODEL_URL ??
  "https://huggingface.co/Xenova/clip-vit-large-patch14/resolve/c307790166907339eed5a9a53a249af534102536/onnx/vision_model.onnx";
export const EMBEDDING_MODEL_VERSION = "clip-vit-l14-v2";

const MODEL_DIR = path.join(REPO_ROOT, ".cache", "embedding-models");
const MODEL_PATH = path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}.onnx`);

const INPUT_SIZE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

let sessionPromise: Promise<ort.InferenceSession> | null = null;

async function ensureModelDownloaded(): Promise<void> {
  if (existsSync(MODEL_PATH)) return;
  mkdirSync(MODEL_DIR, { recursive: true });
  const res = await fetch(EMBEDDING_MODEL_URL);
  if (!res.ok || !res.body) throw new Error(`Couldn't download the embedding model (${res.status})`);
  const tmpPath = `${MODEL_PATH}.download`;
  await writeFile(tmpPath, Buffer.from(await res.arrayBuffer()));
  renameSync(tmpPath, MODEL_PATH);
}

async function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      await ensureModelDownloaded();
      return ort.InferenceSession.create(MODEL_PATH);
    })().catch((err) => {
      sessionPromise = null;
      throw err;
    });
  }
  return sessionPromise;
}

async function preprocessImage(buffer: Buffer): Promise<Float32Array> {
  const { data } = await sharp(buffer)
    .rotate()
    .resize(INPUT_SIZE, INPUT_SIZE, { fit: "cover" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const floats = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const pixelCount = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < pixelCount; i++) {
    for (let c = 0; c < 3; c++) {
      const value = data[i * 3 + c] / 255;
      floats[c * pixelCount + i] = (value - CLIP_MEAN[c]) / CLIP_STD[c];
    }
  }
  return floats;
}

function l2Normalize(vec: Float32Array): number[] {
  let sumSquares = 0;
  for (const v of vec) sumSquares += v * v;
  const norm = Math.sqrt(sumSquares) || 1;
  return Array.from(vec, (v) => v / norm);
}

export async function computeEmbedding(buffer: Buffer): Promise<number[]> {
  const session = await getSession();
  const inputName = session.inputNames[0];
  const outputName = session.outputNames[0];
  const tensor = new ort.Tensor("float32", await preprocessImage(buffer), [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const results = await session.run({ [inputName]: tensor });
  return l2Normalize(results[outputName].data as Float32Array);
}
