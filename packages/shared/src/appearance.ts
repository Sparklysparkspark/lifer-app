// How the animal in a photo looks (migration 196, docs/plans/photo-appearance.md). Life stage and
// sex are fixed lists the database checks; plumage and morph are free text with suggestions.

export const LIFE_STAGES = ["egg", "larva", "nymph", "pupa", "juvenile", "subadult", "adult"] as const;
export type LifeStage = (typeof LIFE_STAGES)[number];

/** "unknown": looked at and can't tell, as iNaturalist's "Cannot Be Determined". Unset is null. */
export const SEXES = ["male", "female", "unknown"] as const;
export type Sex = (typeof SEXES)[number];

/** Offered while typing a plumage; anything else may be typed. */
export const PLUMAGE_SUGGESTIONS = ["breeding", "non-breeding", "eclipse", "immature", "moulting"] as const;

/** The longest plumage or morph kept, as migration 196 checks. */
export const APPEARANCE_TEXT_MAX = 100;

export interface Appearance {
  lifeStage: LifeStage | null;
  sex: Sex | null;
  plumage: string | null;
  morph: string | null;
}

export const APPEARANCE_FIELDS = ["lifeStage", "sex", "plumage", "morph"] as const;

/** Typed text as stored: trimmed, blank as null. */
export function appearanceText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

// iNaturalist's controlled terms (attribute 1 Life Stage, 9 Sex) by value id. Teneral and
// subimago have no stage of their own here, so they're left unset.
const INAT_LIFE_STAGE: Record<number, LifeStage> = {
  2: "adult",
  4: "pupa",
  5: "nymph",
  6: "larva",
  7: "egg",
  8: "juvenile",
};
const INAT_SEX: Record<number, Sex> = { 10: "female", 11: "male", 20: "unknown" };

/** Life stage and sex from an iNaturalist observation's `annotations`, skipping voted-down ones. */
export function appearanceFromInatAnnotations(annotations: unknown): Pick<Appearance, "lifeStage" | "sex"> {
  const out: Pick<Appearance, "lifeStage" | "sex"> = { lifeStage: null, sex: null };
  if (!Array.isArray(annotations)) return out;
  for (const a of annotations as Array<Record<string, unknown>>) {
    if (typeof a?.vote_score === "number" && a.vote_score < 0) continue;
    const attr = a?.controlled_attribute_id;
    const value = a?.controlled_value_id;
    if (typeof value !== "number") continue;
    if (attr === 1) out.lifeStage ??= INAT_LIFE_STAGE[value] ?? null;
    if (attr === 9) out.sex ??= INAT_SEX[value] ?? null;
  }
  return out;
}
