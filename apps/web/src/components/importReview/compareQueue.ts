import type { SuggestedSpecies } from "../SpeciesPicker";
import { visibleSuggestions, type ReviewRowBase } from "./useImportReview";

// Which photos and species compare mode (ImportCompareView) steps through.
export const toConfirm = (r: ReviewRowBase) => !r.speciesId && !r.notWildlife && !r.possibleDuplicate;
// A typed species has no match to show.
export const percentOf = (s: SuggestedSpecies) => s.matchPercent ?? (s.score > 0 ? Math.round(s.score * 100) : null);

/** The photo after `after` (wrapping) still without a species, leaving out `done`. */
export function nextToConfirm(rows: ReviewRowBase[], after: string, done: string[]): string | null {
  const i = rows.findIndex((r) => r.key === after);
  return [...rows.slice(i + 1), ...rows.slice(0, i)].find((r) => toConfirm(r) && !done.includes(r.key))?.key ?? null;
}

/** The species to compare against: the photos' own suggestions, then any the user typed. */
export function compareCandidates(
  rows: ReviewRowBase[],
  keys: string[],
  typed: SuggestedSpecies[],
): SuggestedSpecies[] {
  const all = [...rows.filter((r) => keys.includes(r.key)).flatMap((r) => visibleSuggestions(r.suggestions)), ...typed];
  return all.filter((s, i) => all.findIndex((o) => o.id === s.id) === i);
}

export type SkipKind = "notWildlife" | "marked" | "duplicate";

/** Why a row stays out of the import, or null when it's one to review: Lifer judged it not
 *  wildlife, the user marked it "No animal", or the library already has it. */
export function skipKind(row: ReviewRowBase): SkipKind | null {
  if (row.possibleDuplicate) return "duplicate";
  if (row.notWildlife) return row.notWildlife.marked ? "marked" : "notWildlife";
  return null;
}
