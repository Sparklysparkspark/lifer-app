import placeholder from "../assets/taxa/placeholder.svg";

export const TAXA_GROUPS = [
  "birds",
  "mammals",
  "reptiles",
  "amphibians",
  "fish",
  "insects",
  "arachnids",
  "other",
] as const;
export type TaxaGroup = (typeof TAXA_GROUPS)[number];

const BY_CLASS: Record<string, TaxaGroup> = {
  aves: "birds",
  mammalia: "mammals",
  aquatic_mammalia: "mammals",
  squamata: "reptiles",
  testudines: "reptiles",
  amphibia: "amphibians",
  actinopterygii: "fish",
  elasmobranchii: "fish",
};

/** The colour group of a species: its taxon class, or iNaturalist's iconic taxon for other taxa. */
export function taxaGroup(taxonClass: string | null | undefined, iconicTaxon?: string | null): TaxaGroup {
  if (taxonClass && BY_CLASS[taxonClass]) return BY_CLASS[taxonClass];
  if (iconicTaxon === "Insecta") return "insects";
  if (iconicTaxon === "Arachnida") return "arachnids";
  return "other";
}

/** The group's colour token, as a CSS value that follows light and dark. */
export function taxaColour(group: TaxaGroup): string {
  return `var(--color-taxa-${group})`;
}

// Asset slot: drop one tintable SVG per group in assets/taxa/ (birds.svg ...) and import it here.
// Until then every group shows the neutral placeholder.
const ILLUSTRATIONS: Partial<Record<TaxaGroup, string>> = {};

export function taxaIllustration(group: TaxaGroup): string {
  return ILLUSTRATIONS[group] ?? placeholder;
}
