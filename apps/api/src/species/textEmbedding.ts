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
import { existsSync, readdirSync } from "node:fs";
import type { PreTrainedTokenizer, CLIPTextModelWithProjection } from "@xenova/transformers";
import { APP_DATA_DIR } from "../config.js";

// Same repo as the vision model (EMBEDDING_MODEL_URL) — a different file within it, not a
// different model, so its text embeddings land in the exact same space as every already-stored
// capture_embeddings row (both tagged with this same EMBEDDING_MODEL_VERSION for that reason).
const TEXT_MODEL_ID = "Xenova/clip-vit-large-patch14";
// Pinned to the exact same commit EMBEDDING_MODEL_URL pins its vision half to — @xenova/
// transformers' from_pretrained defaults to the `main` branch (a mutable git ref) when no
// revision is given, the same real bug fixed on the vision side: two installs downloading this
// text model at different times could otherwise silently get different underlying weights while
// both still claim the same TEXT_MODEL_VERSION, since that string is a constant WE control, not
// something tied to what Hugging Face actually serves. Keep in sync with config.ts's
// EMBEDDING_MODEL_URL commit hash — they're the two halves of the same repo/model.
const MODEL_REVISION = "c307790166907339eed5a9a53a249af534102536";
const CACHE_DIR = path.join(APP_DATA_DIR, "models", "clip-text-cache");
// Versions species_text_embeddings rows (migration 102) the same way EMBEDDING_MODEL_VERSION
// versions image ones — a distinct string since these two tables hold different halves of the
// same underlying CLIP model, so a future text-model swap can't accidentally collide with a
// vision-model version bump.
export const TEXT_MODEL_VERSION = "clip-vit-l14-text-v1";

interface TextModel {
  tokenizer: PreTrainedTokenizer;
  textModel: CLIPTextModelWithProjection;
}

let modelPromise: Promise<TextModel> | null = null;

// Same idle-unload reasoning as embeddings.ts's own vision session (see that file's comment) —
// this text encoder is the OTHER half of the same "keep it warm while in use, drop it after
// real inactivity" tradeoff, kept independent of the vision session's own timer since Gallery
// search and species-suggest are used on different schedules (a library search-heavy session
// might never touch the vision side, or vice versa).
const IDLE_UNLOAD_MS = 15 * 60 * 1000;
let activeInferences = 0;
let idleUnloadTimer: ReturnType<typeof setTimeout> | null = null;

function cancelIdleUnload(): void {
  if (idleUnloadTimer) {
    clearTimeout(idleUnloadTimer);
    idleUnloadTimer = null;
  }
}

function armIdleUnload(): void {
  cancelIdleUnload();
  idleUnloadTimer = setTimeout(() => {
    idleUnloadTimer = null;
    const promise = modelPromise;
    modelPromise = null;
    promise?.then(({ textModel }) => textModel.dispose()).catch(() => {});
  }, IDLE_UNLOAD_MS);
  idleUnloadTimer.unref?.();
}

/** Whether the text encoder half has already been cached locally — cheap, sync, safe to call
 * from a status endpoint on every poll. A non-empty directory is the only signal
 * @xenova/transformers exposes short of re-parsing its own cache-key scheme. */
export function isTextModelDownloaded(): boolean {
  return existsSync(CACHE_DIR) && readdirSync(CACHE_DIR).length > 0;
}

/** Forces the text encoder to download/load now, for the explicit Settings > Offline Data
 * download flow (embeddings.ts's downloadModel() handles the vision half; this is the other
 * half of "the embedding model" as far as the user is concerned). No byte-level progress is
 * available here — @xenova/transformers doesn't expose one — so callers show an indeterminate
 * step for this part. */
export async function downloadTextModel(): Promise<void> {
  await getModel(true);
}

// Deliberately does NOT auto-download on ordinary use — same opt-in contract as
// embeddings.ts's resolveModelPath (see its comment). Only downloadTextModel() (the explicit
// Settings flow) is allowed to trigger @xenova/transformers' own auto-fetch; embedQueryText
// below refuses to call this at all unless the cache is already populated.
async function getModel(forceDownload = false): Promise<TextModel> {
  cancelIdleUnload(); // never unload while a caller is about to (or currently) using it
  if (!forceDownload && !isTextModelDownloaded()) {
    throw new Error("The species-matching model hasn't been downloaded (Settings > Offline Data)");
  }
  if (!modelPromise) {
    modelPromise = (async () => {
      const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import("@xenova/transformers");
      env.cacheDir = CACHE_DIR;
      const [tokenizer, textModel] = await Promise.all([
        AutoTokenizer.from_pretrained(TEXT_MODEL_ID, { revision: MODEL_REVISION }),
        CLIPTextModelWithProjection.from_pretrained(TEXT_MODEL_ID, { quantized: true, revision: MODEL_REVISION }),
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
  // See embeddings.ts's own computeEmbedding for why this is tied to `work` finishing, not to
  // the race below settling — a timed-out-but-still-running inference must keep the model alive
  // until it actually completes, not just until this call gives up waiting on it.
  activeInferences++;
  const work = (async () => {
    const { tokenizer, textModel } = await getModel();
    const inputs = tokenizer(query, { padding: true, truncation: true });
    const output = await textModel(inputs);
    return l2Normalize(output.text_embeds.data);
  })();
  work.finally(() => {
    activeInferences--;
    if (activeInferences === 0) armIdleUnload();
  });
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
