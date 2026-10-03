// Natural-language photo search. CLIP's image and text encoders share one space, so the query
// is embedded with the text encoder and ranked against existing capture_embeddings.
import path from "node:path";
import { APP_DATA_DIR } from "../config.js";
import { embedTexts, type Priority, type TextModelSpec } from "./inference.js";
import { isTextCachePopulated } from "./inferenceWorker.js";

// Same repo as the vision model, so text embeddings land in the same space.
const TEXT_MODEL_ID = "Xenova/clip-vit-large-patch14";
// Pinned to the same commit as EMBEDDING_MODEL_URL (keep in sync), since `main` is mutable.
const MODEL_REVISION = "c307790166907339eed5a9a53a249af534102536";
const CACHE_DIR = path.join(APP_DATA_DIR, "models", "clip-text-cache");
// Distinct from EMBEDDING_MODEL_VERSION so a text-model swap can't collide with a vision bump.
export const TEXT_MODEL_VERSION = "clip-vit-l14-text-v1";

/** What the inference worker needs to load the text encoder. */
export const TEXT_MODEL: TextModelSpec = {
  modelId: TEXT_MODEL_ID,
  revision: MODEL_REVISION,
  cacheDir: CACHE_DIR,
  missingMessage: "The species-matching model hasn't been downloaded (Settings > Offline Data)",
};

/** Whether the text encoder is cached locally. Cheap enough to call on every poll. */
export function isTextModelDownloaded(): boolean {
  return isTextCachePopulated(CACHE_DIR);
}

/** Downloads and loads the text encoder now, for the explicit Settings > Offline Data flow.
 * No byte progress is available. */
export async function downloadTextModel(): Promise<void> {
  await embedTexts(["warm-up"], TEXT_MODEL, { priority: "background", allowDownload: true });
}

/** Embeds text into the capture_embeddings space, one vector per text, in one worker job. */
export function embedTextVectors(texts: string[], priority: Priority = "interactive"): Promise<Float32Array[]> {
  if (texts.length === 0) return Promise.resolve([]);
  if (!isTextModelDownloaded()) return Promise.reject(new Error(TEXT_MODEL.missingMessage));
  return embedTexts(texts, TEXT_MODEL, { priority });
}

/** One query as a plain array. Takes one parameter so it can be passed to Array.map. */
export async function embedQueryText(query: string): Promise<number[]> {
  const [v] = await embedTextVectors([query]);
  return Array.from(v);
}
