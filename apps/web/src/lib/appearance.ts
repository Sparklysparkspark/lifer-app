import { useTranslation } from "react-i18next";
import { LIFE_STAGES, PLUMAGE_SUGGESTIONS, SEXES, type Appearance, type LifeStage, type Sex } from "@lifer/shared";

export const NO_APPEARANCE: Appearance = { lifeStage: null, sex: null, plumage: null, morph: null };

// Literal keys, so the i18n check sees each one.
export const STAGE_KEYS: Record<LifeStage, string> = {
  egg: "appearance.stage.egg",
  larva: "appearance.stage.larva",
  nymph: "appearance.stage.nymph",
  pupa: "appearance.stage.pupa",
  juvenile: "appearance.stage.juvenile",
  subadult: "appearance.stage.subadult",
  adult: "appearance.stage.adult",
};
export const SEX_KEYS: Record<Sex, string> = {
  male: "appearance.sex.male",
  female: "appearance.sex.female",
  unknown: "appearance.sex.unknown",
};
export const PLUMAGE_KEYS: Record<(typeof PLUMAGE_SUGGESTIONS)[number], string> = {
  breeding: "appearance.plumage.breeding",
  "non-breeding": "appearance.plumage.nonBreeding",
  eclipse: "appearance.plumage.eclipse",
  immature: "appearance.plumage.immature",
  moulting: "appearance.plumage.moulting",
};

/** The words for a life stage and sex, for badges and pickers. */
export function useAppearanceLabels() {
  const { t } = useTranslation();
  return {
    stage: (v: LifeStage) => t(STAGE_KEYS[v]),
    sex: (v: Sex) => t(SEX_KEYS[v]),
  };
}

/** The distinct values among some photos: stages and sexes in their natural order, then plumages
 *  and morphs by name. */
export function appearanceValues(items: Appearance[]): Array<{ kind: keyof Appearance; value: string }> {
  const has = (kind: keyof Appearance) => new Set(items.flatMap((i) => (i[kind] ? [i[kind]] : [])));
  const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const stages = has("lifeStage");
  const sexes = has("sex");
  return [
    ...LIFE_STAGES.filter((v) => stages.has(v)).map((value) => ({ kind: "lifeStage" as const, value })),
    ...SEXES.filter((v) => sexes.has(v)).map((value) => ({ kind: "sex" as const, value })),
    ...sorted(has("plumage")).map((value) => ({ kind: "plumage" as const, value })),
    ...sorted(has("morph")).map((value) => ({ kind: "morph" as const, value })),
  ];
}
