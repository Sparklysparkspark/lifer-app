import type { SpeciesSuggestion } from "./suggest.js";

// The match percentage (matchPercent, 0-100) the top suggestion needs before Lifer files a photo
// under it unasked. Conservative on purpose: a wrong filing costs the user a correction, an
// unfiled photo only waits. Groups with look-alikes or less reference data ask for more.
const FILING_MIN_PERCENT: Readonly<Record<string, number>> = {
  aves: 90,
  mammalia: 92,
  reptilia: 94,
  amphibia: 94,
};
const FILING_DEFAULT_PERCENT = 96;

export interface FilingDecision {
  speciesId: string;
  matchPercent: number;
}

export const filingThreshold = (taxonClass: string | null): number =>
  (taxonClass ? FILING_MIN_PERCENT[taxonClass] : undefined) ?? FILING_DEFAULT_PERCENT;

/** The species to file a photo under, or null to leave it unfiled. Only a confident top match from a
 *  region's checklist counts, so a photo with no region (suggestions then rank every species) never
 *  files itself. `suggestions` are best first, as rankSpeciesByEmbeddings returns them. */
export function chooseFiling(
  suggestions: readonly SpeciesSuggestion[],
  taxonClassOf: (speciesId: string) => string | null,
  inRegionChecklist: boolean,
): FilingDecision | null {
  const top = suggestions[0];
  if (!inRegionChecklist || !top?.confident || top.source === "keyword_tag") return null;
  const percent = top.matchPercent ?? 0;
  return percent >= filingThreshold(taxonClassOf(top.id)) ? { speciesId: top.id, matchPercent: percent } : null;
}
