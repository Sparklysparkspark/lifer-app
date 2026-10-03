import type { TaxonClass } from "./species.js";

// Single source of truth for taxon-group display labels.
export const TAXON_CLASS_LABEL: Record<TaxonClass, string> = {
  aves: "Birds",
  mammalia: "Mammals",
  actinopterygii: "Fish",
  elasmobranchii: "Sharks & Rays",
  aquatic_mammalia: "Marine Mammals",
  amphibia: "Amphibians",
  squamata: "Reptiles",
  testudines: "Turtles",
  corals: "Corals",
  jellies_and_anemones: "Jellies & Anemones",
  echinodermata: "Echinoderms",
  nudibranchs: "Nudibranchs",
  marine_mollusks: "Shells & Marine Mollusks",
  cephalopoda: "Cephalopods",
  crustacea: "Crustaceans",
  sponges_tunicates_other: "Sponges & Tunicates",
};

// Iteration order for taxon pickers, matching the union's declaration order in species.ts.
export const ALL_TAXON_CLASSES: TaxonClass[] = Object.keys(TAXON_CLASS_LABEL) as TaxonClass[];

// UI-only disclosure sections for taxon pickers (see OfflinePacksPage.tsx). Every taxon inside
// stays individually selectable; standalone taxa aren't listed here.
export const TAXON_GROUPS: Array<{ key: string; label: string; taxa: TaxonClass[] }> = [
  { key: "reptiles_and_amphibians", label: "Reptiles & Amphibians", taxa: ["squamata", "testudines", "amphibia"] },
  {
    key: "marine_invertebrates",
    label: "Marine Invertebrates",
    taxa: ["corals", "jellies_and_anemones", "echinodermata", "nudibranchs", "marine_mollusks", "cephalopoda", "crustacea", "sponges_tunicates_other"],
  },
];

// Every taxon inside a TAXON_GROUPS entry, for splitting a flat list into standalone vs grouped.
export const GROUPED_TAXON_CLASSES: Set<TaxonClass> = new Set(TAXON_GROUPS.flatMap((g) => g.taxa));

// Marine invertebrates never get a computed rarity tier: too few clear GBIF's record floor for a
// meaningful percentile ranking. They fall back to IUCN status, like Other Taxa species.
export const NO_RARITY_TIER_TAXON_CLASSES: Set<TaxonClass> = new Set([
  "corals",
  "jellies_and_anemones",
  "echinodermata",
  "nudibranchs",
  "marine_mollusks",
  "cephalopoda",
  "crustacea",
  "sponges_tunicates_other",
]);

// Other Taxa species store an iNaturalist iconic taxon name verbatim; this maps them to English
// group labels. Aves/Mammalia/Actinopterygii/Amphibia intentionally fold into the built-in groups.
// Labels follow the user's species_naming_styles (common/latin order); code styles are ignored.
export function otherTaxaGroupLabel(iconicTaxon: string, namingStyles: string[]): string {
  const english = INAT_ICONIC_TAXON_LABEL[iconicTaxon] ?? iconicTaxon;
  const commonIdx = namingStyles.indexOf("common");
  const latinIdx = namingStyles.indexOf("latin");
  const wantsLatin = latinIdx !== -1;
  const wantsCommon = commonIdx !== -1 || !wantsLatin; // no explicit preference at all defaults to common
  if (wantsCommon && wantsLatin) return commonIdx <= latinIdx ? `${english} - ${iconicTaxon}` : `${iconicTaxon} - ${english}`;
  return wantsLatin ? iconicTaxon : english;
}

// Display label for a raw taxon_class value: a built-in class or an Other Taxa species'
// lowercased iconic taxon (e.g. "insecta"), which is recapitalized before lookup.
export function taxonDisplayLabel(taxonClass: string, namingStyles: string[]): string {
  if (taxonClass in TAXON_CLASS_LABEL) return TAXON_CLASS_LABEL[taxonClass as TaxonClass];
  return otherTaxaGroupLabel(taxonClass.charAt(0).toUpperCase() + taxonClass.slice(1), namingStyles);
}

export const INAT_ICONIC_TAXON_LABEL: Record<string, string> = {
  Animalia: "Animals",
  Actinopterygii: "Fish",
  Amphibia: "Amphibians",
  Arachnida: "Arachnids",
  Aves: "Birds",
  Chromista: "Chromists",
  Fungi: "Fungi",
  Insecta: "Insects",
  Mammalia: "Mammals",
  Mollusca: "Mollusks",
  Plantae: "Plants",
  Protozoa: "Protozoans",
  Reptilia: "Reptiles",
};
