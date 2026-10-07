// Flags an imported photo that shows no wildlife at all (a person, a screenshot, light trails)
// so the import screen leaves it out instead of offering a meaningless species match.
//
// Two signals, both already computed on import:
//   - CLIP compares the whole photo with short descriptions of non-wildlife and wildlife
//     subjects; the softmaxed share going to non-wildlife is the score.
//   - The animal detector. It knows only ten animal kinds, so finding none means little, but
//     finding one vetoes the flag (a person feeding ducks is still wildlife).
// Needs the CLIP model: the detector alone isn't reliable enough.
import { detectSubjectPresence } from "./detectAndCrop.js";
import { embedTextVectors, isTextModelDownloaded } from "@lifer/core/species/textEmbedding.js";

const NOT_WILDLIFE = [
  "a photo of a person",
  "a portrait of a person",
  "a selfie",
  "a group of people",
  "a crowd of people",
  "a screenshot",
  "a document with text",
  "a painting",
  "a sculpture",
  "food on a plate",
  "a car",
  "a building",
  "a room interior",
  "a city street",
  "light trails at night",
  "a road at night",
  "an empty road",
  "a landscape",
  "a mountain landscape",
  "a night sky with stars",
  "a sunset sky",
  "a blurry abstract photo",
  "a dark photo",
];
const WILDLIFE = [
  "a photo of a bird",
  "a photo of a wild animal",
  "a photo of a mammal",
  "a photo of an insect",
  "a photo of a butterfly",
  "a photo of a spider",
  "a photo of a reptile",
  "a photo of a frog",
  "a photo of a fish",
  "a photo of a plant",
  "a photo of a flower",
  "a photo of a mushroom",
  "a photo of a tree",
  "wildlife in nature",
];
const NOT_WILDLIFE_MIN = 0.75;
// Any animal the detector is at least this sure of keeps the photo.
const ANIMAL_VETO = 0.25;
// CLIP's own logit scale, which turns cosine similarities into a sharp reading.
const LOGIT_SCALE = 100;

// Embedded once, in one worker job; a failure is retried on the next photo.
let promptVectors: Promise<{ not: Float32Array[]; wild: Float32Array[] }> | null = null;
function prompts() {
  promptVectors ??= embedTextVectors([...NOT_WILDLIFE, ...WILDLIFE]).then(
    (vectors) => ({ not: vectors.slice(0, NOT_WILDLIFE.length), wild: vectors.slice(NOT_WILDLIFE.length) }),
    (err) => {
      promptVectors = null;
      throw err;
    },
  );
  return promptVectors;
}

const dot = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

export interface NotWildlife {
  /** What the photo looks like instead, e.g. "light trails at night". */
  looksLike: string;
}

/** `clipEmbedding` is the photo's whole-frame CLIP vector (uncropped). Null when the photo
 * looks like wildlife, or when it can't be told (no CLIP model). Never throws. */
export async function checkNotWildlife(buffer: Buffer, clipEmbedding: number[] | null): Promise<NotWildlife | null> {
  if (!clipEmbedding || !isTextModelDownloaded()) return null;
  try {
    const { not, wild } = await prompts();
    const sims = [...not.map((v) => dot(clipEmbedding, v)), ...wild.map((v) => dot(clipEmbedding, v))];
    const max = Math.max(...sims);
    const weights = sims.map((s) => Math.exp(LOGIT_SCALE * (s - max)));
    const total = weights.reduce((a, b) => a + b, 0);
    const notShare = weights.slice(0, not.length).reduce((a, b) => a + b, 0) / total;
    if (notShare < NOT_WILDLIFE_MIN) return null;
    const presence = await detectSubjectPresence(buffer);
    if (presence.animal >= ANIMAL_VETO) return null;
    const top = sims.slice(0, not.length).indexOf(Math.max(...sims.slice(0, not.length)));
    return { looksLike: NOT_WILDLIFE[top].replace(/^a photo of /, "") };
  } catch {
    return null;
  }
}
