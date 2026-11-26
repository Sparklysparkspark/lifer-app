// Smart tags CLIP scoring shared by the calibration tool (data-pipeline) and the suggestion pass
// (apps/api), so a fitted threshold means the same score in both.
import type { SmartTagGroup, SmartTagVocab } from "@lifer/shared";

export interface VocabTerm {
  id: string;
  label: string;
  /** Facet root, the first segment of the term's path ("Habitat" for "Habitat|Wetland"). */
  facet: string;
  description: string;
  /** CLIP prompts, written in full. A term without any is computed or manual, never calibrated. */
  prompts: string[];
  /** Pick-one group id: the group's terms and its "none" option compete in one softmax. */
  pickOne?: string;
}

export interface Vocabulary {
  version: string;
  terms: VocabTerm[];
  /** Pick-one group id to its "none of these" prompts. */
  none: Record<string, string[]>;
}

/**
 * "None of these" prompts for the pick-one groups that have CLIP terms. The vocabulary only says a
 * group has a none option; a group may carry its own `nonePrompts` instead.
 */
export const DEFAULT_NONE_PROMPTS: Record<string, string[]> = {
  subject: ["a photo of a building", "a photo of a person", "a photo of a city street", "a photo of an object indoors"],
  context: [
    "a photo of a wild animal in nature",
    "a wildlife photo of an animal in its natural habitat",
    "a photo of a landscape",
  ],
  weather: ["a close-up photo with no sky visible", "a photo taken indoors"],
};

/** Reads the vocabulary (packages/shared/src/smartTags/vocab.json, plan section (h)). */
export function parseVocabulary(json: SmartTagVocab): Vocabulary {
  if (!Array.isArray(json?.terms) || !Array.isArray(json.groups)) throw new Error("Vocabulary needs terms and groups");
  const groups = new Map<string, SmartTagGroup & { nonePrompts?: string[] }>(json.groups.map((g) => [g.id, g]));
  const terms = json.terms.map((t) => {
    const g = groups.get(t.group);
    if (!g) throw new Error(`Vocabulary term ${t.id} names unknown group ${t.group}`);
    return {
      id: t.id,
      label: t.name,
      facet: t.path.split("|")[0],
      description: t.usage,
      prompts: t.prompts,
      pickOne: g.kind === "pick-one" ? g.id : undefined,
    };
  });
  const none: Record<string, string[]> = {};
  for (const g of groups.values()) {
    if (g.kind === "pick-one" && g.none) none[g.id] = g.nonePrompts ?? DEFAULT_NONE_PROMPTS[g.id] ?? [];
  }
  return { version: String(json.version), terms, none };
}

/** Terms the calibration scores: the ones with CLIP prompts. */
export const clipTerms = (vocab: Vocabulary): VocabTerm[] => vocab.terms.filter((t) => t.prompts.length > 0);

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function meanUnit(vectors: ArrayLike<number>[]): number[] {
  const m = Array.from(vectors[0], (_, j) => vectors.reduce((s, v) => s + v[j], 0) / vectors.length);
  const n = Math.hypot(...m);
  return m.map((x) => x / n);
}

/** CLIP's logit scale, as in the measured pick-one experiment. */
const PICK_ONE_SCALE = 100;

/**
 * One photo's score per term. A free term scores its cosine similarity. A pick-one term scores its
 * softmax share against its group and the group's "none" option when it wins, else 0, the method
 * section "Measured" recommends.
 */
export function scorePhoto(
  vector: ArrayLike<number>,
  terms: VocabTerm[],
  termVectors: Map<string, number[]>,
  noneVectors: Map<string, number[]>,
): Map<string, number> {
  const out = new Map<string, number>();
  const groups = new Map<string, VocabTerm[]>();
  for (const t of terms) {
    if (t.pickOne) groups.set(t.pickOne, [...(groups.get(t.pickOne) ?? []), t]);
    else out.set(t.id, dot(vector, termVectors.get(t.id)!));
  }
  for (const [g, members] of groups) {
    const logits = members.map((t) => dot(vector, termVectors.get(t.id)!) * PICK_ONE_SCALE);
    const none = noneVectors.get(g);
    if (none) logits.push(dot(vector, none) * PICK_ONE_SCALE);
    const max = Math.max(...logits);
    const exp = logits.map((x) => Math.exp(x - max));
    const sum = exp.reduce((a, b) => a + b, 0);
    const win = logits.indexOf(max);
    members.forEach((t, i) => out.set(t.id, i === win ? exp[i] / sum : 0));
  }
  return out;
}
