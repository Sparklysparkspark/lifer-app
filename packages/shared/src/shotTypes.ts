// Shot type, read on two independent axes: what the animal is doing (action) and how much of the
// frame it fills (framing). The API classifies photos by them; the web filters and labels them.

export const SHOT_ACTIONS = ["flying", "behavior", "resting"] as const;
export type ShotAction = (typeof SHOT_ACTIONS)[number];
export const SHOT_FRAMINGS = ["close", "environmental"] as const;
export type ShotFraming = (typeof SHOT_FRAMINGS)[number];

export const isShotAction = (v: string): v is ShotAction => (SHOT_ACTIONS as readonly string[]).includes(v);
export const isShotFraming = (v: string): v is ShotFraming => (SHOT_FRAMINGS as readonly string[]).includes(v);

/** The older single `shotKind` (saved smart albums, old links), as the axis it now stands for. */
export const LEGACY_SHOT_KINDS = {
  flight: { action: "flying" },
  behavior: { action: "behavior" },
  portrait: { framing: "close" },
  environmental: { framing: "environmental" },
} as const satisfies Record<string, { action?: ShotAction; framing?: ShotFraming }>;
export type LegacyShotKind = keyof typeof LEGACY_SHOT_KINDS;

/** Comma-separated values of one axis, keeping only known ones, in the axis' own order. */
export function parseShotList<T extends string>(raw: string | null | undefined, known: readonly T[]): T[] {
  const typed = new Set((raw ?? "").split(","));
  return known.filter((k) => typed.has(k));
}
