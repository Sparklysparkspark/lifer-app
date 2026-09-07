// Natural-language content search (see ~/.claude/plans — "fox playing" should find fox kits
// mid-play, not just any Red Fox photo). CLIP's image and text encoders share one embedding
// space by construction, so this reuses capture_embeddings (embeddings.ts, already computed for
// every confirmed capture as a side effect of species auto-suggest) as-is: embed the typed query
// with CLIP's TEXT encoder, then rank existing capture embeddings by plain cosine similarity —
// no new image processing, no per-photo tagging step, nothing to backfill.
//
// Validated live before building this (2026-09-01): "young fox kits playing" ranked an actual
// photo of two fox kits mid-leap above a calm adult-fox portrait that a plain "Red Fox" query
// ranked first instead — real behavior/scene discrimination from the text alone.
//
// Uses @xenova/transformers rather than hand-rolling a CLIP BPE tokenizer against raw
// onnxruntime-node (the pattern embeddings.ts's vision side uses) — the tokenizer is the
// genuinely fiddly part to get bit-for-bit right, and this library already ships both the
// tokenizer and the paired text encoder for the exact same "Xenova/clip-vit-large-patch14" repo
// EMBEDDING_MODEL_URL's vision half comes from, guaranteeing the two embedding spaces actually
// match. Downloaded lazily into APP_DATA_DIR on first real use, same "don't pay this cost unless
// a self-hosted deployment actually uses image search" reasoning as embeddings.ts's own model.
import path from "node:path";
import type { PreTrainedTokenizer, CLIPTextModelWithProjection } from "@xenova/transformers";
import { APP_DATA_DIR } from "../config.js";

// Same repo as the vision model (EMBEDDING_MODEL_URL) — a different file within it, not a
// different model, so its text embeddings land in the exact same space as every already-stored
// capture_embeddings row (both tagged with this same EMBEDDING_MODEL_VERSION for that reason).
const TEXT_MODEL_ID = "Xenova/clip-vit-large-patch14";
const CACHE_DIR = path.join(APP_DATA_DIR, "models", "clip-text-cache");

interface TextModel {
  tokenizer: PreTrainedTokenizer;
  textModel: CLIPTextModelWithProjection;
}

let modelPromise: Promise<TextModel> | null = null;

async function getModel(): Promise<TextModel> {
  if (!modelPromise) {
    modelPromise = (async () => {
      const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import("@xenova/transformers");
      env.cacheDir = CACHE_DIR;
      const [tokenizer, textModel] = await Promise.all([
        AutoTokenizer.from_pretrained(TEXT_MODEL_ID),
        CLIPTextModelWithProjection.from_pretrained(TEXT_MODEL_ID, { quantized: true }),
      ]);
      return { tokenizer, textModel };
    })().catch((err) => {
      modelPromise = null; // let the next caller retry instead of caching a permanent failure
      throw err;
    });
  }
  return modelPromise;
}

function l2Normalize(data: ArrayLike<number>): number[] {
  let sumSquares = 0;
  for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i];
  const norm = Math.sqrt(sumSquares) || 1;
  return Array.from(data, (v) => v / norm);
}

const INFERENCE_TIMEOUT_MS = 20_000;

/** Embeds a natural-language query into the same 768-dim space capture_embeddings already lives
 * in (confirmed live — see this file's own header comment), so a caller just cosineSimilarity()s
 * the result against every row already in that table, same as embeddings.ts's own image-vs-image
 * ranking. Guarded by the same hard-timeout shape as computeEmbedding, for the same reason: a
 * hung native/WASM inference call must never hang an HTTP request forever. */
export async function embedQueryText(query: string): Promise<number[]> {
  const work = (async () => {
    const { tokenizer, textModel } = await getModel();
    const inputs = tokenizer(query, { padding: true, truncation: true });
    const output = await textModel(inputs);
    return l2Normalize(output.text_embeds.data);
  })();
  work.catch(() => {});

  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<number[]>((_, reject) => {
    timer = setTimeout(() => reject(new Error("text embedding inference timed out")), INFERENCE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
