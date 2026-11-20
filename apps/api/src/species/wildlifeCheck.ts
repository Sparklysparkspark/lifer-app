// Reads what an imported photo shows before any species is suggested:
//   - no wildlife at all (a person, a screenshot, light trails), so the import screen leaves it
//     out instead of offering a meaningless species match;
//   - an insect, spider or other small invertebrate, which most regional checklists don't cover,
//     so the import screen points to adding the species from iNaturalist instead.
//
// Two signals, both already computed on import:
//   - CLIP compares the whole photo with short descriptions of non-wildlife and wildlife
//     subjects; the softmaxed share going to each group is the score.
//   - The person and animal detector. It knows only ten animal kinds, so finding none means
//     little, but finding one vetoes the flag (a person feeding ducks is still wildlife).
// Needs the CLIP model: the detector alone isn't reliable enough.
import { detectSubjectPresence, type SubjectPresence } from "./detectAndCrop.js";
import { embedTextVectors, isTextModelDownloaded } from "@lifer/core/species/textEmbedding.js";

// The first PEOPLE_PROMPTS entries describe people.
const PEOPLE_PROMPTS = 5;
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
  // Vehicles, buildings and signs: a parked bus or a ruin otherwise matches some animal's shape.
  "a bus",
  "a truck",
  "a boat",
  "an abandoned vehicle",
  "a house",
  "ruins of a building",
  "a sign with text",
];
// Small invertebrates, named for the import screen ("This looks like a bee").
const INVERTEBRATES = [
  "a photo of an insect",
  "a photo of a butterfly",
  "a photo of a moth",
  "a photo of a caterpillar",
  "a photo of a bee",
  "a photo of a wasp",
  "a photo of a fly",
  "a photo of a beetle",
  "a photo of a dragonfly",
  "a photo of a grasshopper",
  "a photo of an ant",
  "a photo of a spider",
  "a photo of a snail",
];
// Animals, invertebrates first. The hidden bird and the bird on a trunk keep a warbler deep in
// foliage or a woodpecker in a wide forest shot on the animal side.
const ANIMALS = [
  ...INVERTEBRATES,
  "a photo of a bird",
  "a small bird hidden among leaves and branches",
  "a bird on a tree trunk",
  "a photo of a wild animal",
  "a photo of a mammal",
  "a photo of a reptile",
  "a photo of a frog",
  "a photo of a fish",
];
const PLANTS = ["a photo of a plant", "a photo of a flower", "a photo of a mushroom", "a photo of a tree"];
// Counted only by the scenery rule, which needs no animal anywhere: without them a river or lake
// shot reads its reflections as "a fish" and is kept.
const WATER_SCENERY = ["trees reflected in calm water", "a river", "a lake"];
const WILDLIFE = [...ANIMALS, ...PLANTS, ...WATER_SCENERY, "wildlife in nature"];
const NOT_WILDLIFE_MIN = 0.75;
// A person the detector is this sure of, with CLIP at least this sure the photo is about people,
// flags the photo even when the scene around them (a trail, a lake shore) reads as nature.
const PERSON_MIN = 0.6;
const PEOPLE_SHARE_MIN = 0.3;
// A person the detector is this sure of, filling at least this much of the frame, flags the photo
// on its own: CLIP can read a portrait among blossoms as "a flower", which counts as wildlife.
const CLEAR_PERSON_MIN = 0.8;
const CLEAR_PERSON_AREA = 0.1;
const INVERTEBRATE_MIN = 0.6;
// Plants alone (a tree, a flower) with no animal description standing out and nothing detected:
// Lifer catalogues animals, so it's flagged like other non-wildlife and can still be imported.
// The strongest single animal description counts, not their sum: a dozen insect and bird
// descriptions each pick up a little from any green photo.
const PLANTS_MIN = 0.7;
// Scenery and plants together, with no animal anywhere: a wide landscape splits its reading
// between "a landscape" and "a tree", leaving each under its own rule.
const SCENERY_MIN = 0.85;
const ANIMAL_PROMPT_MAX = 0.1;
// Nothing the detector calls an animal: stricter than the veto, for the rules that flag on less.
const NO_ANIMAL = 0.05;
// Any animal the detector is at least this sure of keeps the photo.
const ANIMAL_VETO = 0.25;
// Short of a flag: a reading still this much of a scene (and some of it not wildlife) with no animal
// standing out makes the photo a "maybe", which the import asks about instead of leaving out.
const MAYBE_MIN = 0.5;
const MAYBE_NOT_WILDLIFE_MIN = 0.25;
// See animalEvidence in judgeSubject.
const SCENE_NEEDS_DETECTOR = 0.5;
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

export interface SubjectCheck {
  notWildlife: NotWildlife | null;
  /** An insect, spider or the like, e.g. { looksLike: "a bee" }. */
  invertebrate: { looksLike: string } | null;
  /** Probably not wildlife, short of `notWildlife`'s confidence: asked about, never left out.
   *  `share` is the reading's share (0 to 1) that went to the scene. */
  maybeNotWildlife?: (NotWildlife & { share: number }) | null;
  /** The detector found an animal, or the photo reads as one. False: a species match can only be a
   *  guess (see unsureWithoutAnimal). Absent when it couldn't be told. */
  animalEvidence?: boolean;
}

/** No confident species (nor genus or family) for a photo with no sign of an animal, or one that
 *  reads as not wildlife: a nearest neighbour always returns something, and a river or a bus then
 *  gets a manatee or a monkey. */
export function unsureWithoutAnimal<T extends { confident?: boolean; probably?: unknown }>(
  suggestions: T[],
  check: SubjectCheck,
): T[] {
  const notWild = !!check.notWildlife || !!check.maybeNotWildlife;
  if (!notWild && check.animalEvidence !== false) return suggestions;
  return suggestions.map((s, i) => {
    if (i > 0) return s;
    const { probably: _probably, ...rest } = s;
    return { ...rest, confident: false } as T;
  });
}

/** For an invertebrate: a checklist built for birds and mammals only offers the nearest bird, so
 * suggestions stay only when one confidently matches (an insect you've added and photographed). */
export function unlessLikelyMatch<T extends { confident?: boolean }>(suggestions: T[]): T[] {
  return suggestions[0]?.confident ? suggestions : [];
}

const NOTHING: SubjectCheck = { notWildlife: null, invertebrate: null };
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const label = (prompt: string) => prompt.replace(/^a photo of /, "");

/** `clipEmbedding` is the photo's whole-frame CLIP vector (uncropped). Both null when the photo
 * is ordinary wildlife, or when it can't be told (no CLIP model). Never throws. */
export async function checkSubject(buffer: Buffer, clipEmbedding: number[] | null): Promise<SubjectCheck> {
  if (!clipEmbedding || !isTextModelDownloaded()) return NOTHING;
  try {
    // Detection is cached per photo, and import usually runs it already for the subject crop.
    return await judgeSubject(clipEmbedding, await prompts(), () => detectSubjectPresence(buffer));
  } catch {
    return NOTHING;
  }
}

/** The prompt vectors judgeSubject compares with (for the calibration script). */
export const subjectPromptVectors = () => prompts();

/** checkSubject's reading from the photo's CLIP vector and the detector's presence reading
 *  (asked for only when needed). */
export async function judgeSubject(
  clipEmbedding: ArrayLike<number>,
  { not, wild }: { not: Float32Array[]; wild: Float32Array[] },
  presenceOf: () => Promise<SubjectPresence>,
): Promise<SubjectCheck> {
  const sims = [...not.map((v) => dot(clipEmbedding, v)), ...wild.map((v) => dot(clipEmbedding, v))];
  const max = Math.max(...sims);
  const weights = sims.map((s) => Math.exp(LOGIT_SCALE * (s - max)));
  const total = sum(weights);
  const share = (from: number, to: number) => sum(weights.slice(from, to)) / total;
  const topOf = (prompts: string[], offset: number) => {
    const part = sims.slice(offset, offset + prompts.length);
    return label(prompts[part.indexOf(Math.max(...part))]);
  };

  const invertebrateShare = share(not.length, not.length + INVERTEBRATES.length);
  if (invertebrateShare >= INVERTEBRATE_MIN)
    return { notWildlife: null, invertebrate: { looksLike: topOf(INVERTEBRATES, not.length) }, animalEvidence: true };

  const notShare = share(0, not.length);
  const peopleShare = share(0, PEOPLE_PROMPTS);
  const presence = await presenceOf();
  if (presence.animal >= ANIMAL_VETO) return { ...NOTHING, animalEvidence: true };
  const peopleLabel = () => topOf(NOT_WILDLIFE.slice(0, PEOPLE_PROMPTS), 0);
  const strongestAnimal = Math.max(...weights.slice(not.length, not.length + ANIMALS.length)) / total;
  const noAnimal = presence.animal < NO_ANIMAL && strongestAnimal < ANIMAL_PROMPT_MAX;
  const plantOffset = not.length + ANIMALS.length;
  const waterOffset = plantOffset + PLANTS.length;
  const plantShare = share(plantOffset, waterOffset);
  const waterShare = share(waterOffset, waterOffset + WATER_SCENERY.length);
  const sceneShare = notShare + plantShare + waterShare;
  // A photo that reads mostly as water, a landscape or a vehicle needs the detector's word for an
  // animal; a faint animal description there is how a river becomes a manatee. Plants don't
  // count: a bird deep in foliage often escapes the detector.
  const animalEvidence = !noAnimal && (notShare + waterShare < SCENE_NEEDS_DETECTOR || presence.animal >= NO_ANIMAL);
  const verdict = (check: SubjectCheck): SubjectCheck => ({ ...check, animalEvidence });
  // A clear person, either filling the frame, or smaller with no animal anywhere (a hiker on a trail).
  if (presence.person >= CLEAR_PERSON_MIN && (presence.personArea >= CLEAR_PERSON_AREA || noAnimal))
    return verdict({ notWildlife: { looksLike: peopleLabel() }, invertebrate: null });
  if (plantShare >= PLANTS_MIN && noAnimal)
    return verdict({ notWildlife: { looksLike: topOf(PLANTS, plantOffset) }, invertebrate: null });
  if (noAnimal && sceneShare >= SCENERY_MIN) {
    const notTop = Math.max(...sims.slice(0, not.length));
    const plantTop = Math.max(...sims.slice(plantOffset, waterOffset));
    const looksLike = notTop >= plantTop ? topOf(NOT_WILDLIFE, 0) : topOf(PLANTS, plantOffset);
    return verdict({ notWildlife: { looksLike }, invertebrate: null });
  }
  // The detector found no animal it trusts (the veto above), and no animal description stands out.
  const maybe = (): SubjectCheck => {
    const scene = notShare + plantShare + share(waterOffset, waterOffset + WATER_SCENERY.length);
    const likely = notShare >= MAYBE_MIN || (scene >= MAYBE_MIN && notShare >= MAYBE_NOT_WILDLIFE_MIN);
    if (!likely || strongestAnimal >= ANIMAL_PROMPT_MAX) return NOTHING;
    return { ...NOTHING, maybeNotWildlife: { looksLike: topOf(NOT_WILDLIFE, 0), share: Math.max(notShare, scene) } };
  };
  if (notShare < NOT_WILDLIFE_MIN && peopleShare < PEOPLE_SHARE_MIN) return verdict(maybe());
  if (notShare >= NOT_WILDLIFE_MIN)
    return verdict({ notWildlife: { looksLike: topOf(NOT_WILDLIFE, 0) }, invertebrate: null });
  if (presence.person >= PERSON_MIN) return verdict({ notWildlife: { looksLike: peopleLabel() }, invertebrate: null });
  return verdict(maybe());
}
