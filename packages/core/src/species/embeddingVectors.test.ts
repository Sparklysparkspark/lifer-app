// Guards the vectors themselves. Stored catalog vectors (reference photos, species_text_embeddings)
// are compared with vectors computed on each install, so a library or onnxruntime upgrade that
// shifts them quietly degrades matching and search. This runs the real models on fixed inputs and
// compares with __fixtures__/embeddingVectors.json. The text vectors are also checked against the
// full-precision model, so a fixture regenerated on a worse runtime setting can't pass silently.
//
// Needs the model files, so it's skipped unless LIFER_TEST_MODEL_DIR points at a folder with
// clip-vit-l14-v2.onnx, bioclip-2-v1.onnx and clip-text-cache/ (an APP_DATA_DIR/models folder).
// After a deliberate model change, rerun with LIFER_UPDATE_VECTOR_FIXTURE=1 to rewrite the fixture.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { EMBEDDING_MODEL_VERSION, ID_MODEL_VERSION } from "../config.js";
import { handleRequest, type AnalyzeResult, type RunHooks } from "./inferenceWorker.js";
import { TEXT_MODEL } from "./textEmbedding.js";

interface Fixture {
  texts: string[];
  /** Text vectors from the fp32 text_model.onnx at the same pinned revision (no graph
   * optimization), as the accuracy reference for the int8 model. */
  fullPrecisionText: number[][];
  expected: { text: number[][]; clip: number[]; id: number[] };
}

const FIXTURE_PATH = fileURLToPath(new URL("./__fixtures__/embeddingVectors.json", import.meta.url));
const MODEL_DIR = process.env.LIFER_TEST_MODEL_DIR ?? "";
const UPDATE = process.env.LIFER_UPDATE_VECTOR_FIXTURE === "1";
const clipPath = path.join(MODEL_DIR, `${EMBEDDING_MODEL_VERSION}.onnx`);
const idPath = path.join(MODEL_DIR, `${ID_MODEL_VERSION}.onnx`);
const textCache = path.join(MODEL_DIR, "clip-text-cache");
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Fixture;
const hooks: RunHooks = { runStarted: () => {}, runEnded: () => {} };

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

// Generated rather than committed: gradients, hard edges and a disc, so resizing, cropping and
// normalization all show up in the vector.
async function testImage(): Promise<Buffer> {
  const width = 640;
  const height = 480;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3;
      const inDisc = (x - 400) ** 2 + (y - 220) ** 2 < 110 ** 2;
      pixels[i] = inDisc ? 200 : Math.round((x / width) * 255);
      pixels[i + 1] = inDisc ? 120 : Math.round((y / height) * 255);
      pixels[i + 2] = (Math.floor(x / 40) + Math.floor(y / 40)) % 2 ? 60 : 180;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png()
    .toBuffer();
}

// Loading a 300 MB model takes a few seconds.
const MODEL_TIMEOUT_MS = 120_000;

const round = (v: ArrayLike<number>) => Array.from(v, (x) => Number(x.toPrecision(6)));

describe.skipIf(!MODEL_DIR)("embedding vectors", () => {
  it.skipIf(!existsSync(clipPath) || !existsSync(idPath))(
    "image vectors match the fixture",
    async () => {
      const target = (modelPath: string) => ({ modelPath, missingMessage: `missing ${modelPath}`, crop: false });
      const result = (await handleRequest(
        {
          op: "analyze",
          image: { bytes: await testImage() },
          key: null,
          targets: [target(clipPath), target(idPath)],
          detectorPath: "",
          presence: false,
          cardCrop: false,
          subject: false,
        },
        hooks,
      )) as AnalyzeResult;
      const [clip, id] = result.vectors.map((v) => {
        if (!(v instanceof Float32Array)) throw new Error(v.error);
        return v;
      });
      if (UPDATE) {
        fixture.expected.clip = round(clip);
        fixture.expected.id = round(id);
        return;
      }
      expect(cosine(clip, fixture.expected.clip)).toBeGreaterThan(0.9999);
      expect(cosine(id, fixture.expected.id)).toBeGreaterThan(0.9999);
    },
    MODEL_TIMEOUT_MS,
  );

  it.skipIf(!existsSync(textCache))(
    "text vectors match the fixture and stay close to full precision",
    async () => {
      const model = { ...TEXT_MODEL, cacheDir: textCache };
      const vectors = (await handleRequest(
        { op: "text", texts: fixture.texts, model, allowDownload: false },
        hooks,
      )) as Float32Array[];
      if (UPDATE) {
        fixture.expected.text = vectors.map(round);
        return;
      }
      vectors.forEach((v, i) => {
        expect(cosine(v, fixture.expected.text[i]), fixture.texts[i]).toBeGreaterThan(0.9999);
        // The int8 model at graphOptimizationLevel "all" averages 0.990 here (worst 0.971, the
        // non-Latin text). "basic", like the old onnxruntime 1.14 catalog vectors, drops to 0.67.
        expect(cosine(v, fixture.fullPrecisionText[i]), fixture.texts[i]).toBeGreaterThan(0.96);
      });
    },
    MODEL_TIMEOUT_MS,
  );

  it.runIf(UPDATE)("writes the fixture", () => {
    writeFileSync(FIXTURE_PATH, `${JSON.stringify(fixture)}\n`);
  });
});
