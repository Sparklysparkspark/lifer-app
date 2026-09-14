import type { TaxonClass } from "./species.js";

// Canonical, single source of truth for taxon-group display labels — previously duplicated
// (and incomplete, only 3 of these 18 groups) in both CollectionPage.tsx and
// OfflinePacksPage.tsx. Copy for the 15 groups with no prior label is a first pass, meant to be
// reviewed as real product-facing text, not treated as final.
export const TAXON_CLASS_LABEL: Record<TaxonClass, string> = {
  aves: "Birds",
  mammalia: "Mammals",
  actinopterygii: "Fish",
  elasmobranchii: "Sharks & Rays",
  aquatic_mammalia: "Marine Mammals",
  amphibia: "Amphibians",
  squamata: "Lizards & Snakes",
  testudines: "Turtles",
  crocodylia: "Crocodilians",
  corals: "Corals",
  jellies_and_anemones: "Jellies & Anemones",
  echinodermata: "Echinoderms",
  nudibranchs: "Nudibranchs",
  collector_shells: "Collector Shells",
  marine_mollusks: "Marine Mollusks",
  cephalopoda: "Cephalopods",
  crustacea: "Crustaceans",
  sponges_tunicates_other: "Sponges & Tunicates",
};

// Iteration order for taxon pickers — matches the union's own declaration order in species.ts.
export const ALL_TAXON_CLASSES: TaxonClass[] = Object.keys(TAXON_CLASS_LABEL) as TaxonClass[];

// Purely a UI organizing device — collapses a cluttered flat list into two disclosure sections
// in taxon pickers (see OfflinePacksPage.tsx). Every taxon inside stays individually selectable;
// this is NOT a "select all at once" grouping. Deliberately does NOT group individual marine-
// invertebrate categories together beyond this one umbrella label — collector shells and marine
// mollusks in particular are pursued by different audiences (shell collectors vs. mollusk
// photographers) and must stay independently pickable, not bundled. Reptiles/amphibians and the
// standalone taxa (birds, mammals, marine mammals, fish, sharks & rays) have no clutter problem
// on their own and aren't part of this map.
export const TAXON_GROUPS: Array<{ key: string; label: string; taxa: TaxonClass[] }> = [
  { key: "reptiles_and_amphibians", label: "Reptiles & Amphibians", taxa: ["squamata", "testudines", "crocodylia", "amphibia"] },
  {
    key: "marine_invertebrates",
    label: "Marine Invertebrates",
    taxa: [
      "corals",
      "jellies_and_anemones",
      "echinodermata",
      "nudibranchs",
      "collector_shells",
      "marine_mollusks",
      "cephalopoda",
      "crustacea",
      "sponges_tunicates_other",
    ],
  },
];

// Every taxon covered by a TAXON_GROUPS entry — used to split a flat taxon list into "standalone"
// (rendered directly) vs. "grouped" (rendered inside its disclosure section) without hardcoding
// the standalone list separately and risking it drifting out of sync with the groups above.
export const GROUPED_TAXON_CLASSES: Set<TaxonClass> = new Set(TAXON_GROUPS.flatMap((g) => g.taxa));

// Other Taxa species (Settings > Species & Import's any-taxa search) store one of iNaturalist's
// own 13 "iconic taxon" names verbatim (species.inat_iconic_taxon, exact iNat casing) — used to
// group/folder them the same way the 18 built-in classes get real English labels above. Without
// this, a folder/group would show the bare Latin "Insecta" sitting right next to "Birds"/
// "Mammals" — inconsistent, and not what a non-scientist would expect. Four of iNat's 13 names
// collide with a real TaxonClass label on purpose (Aves/Mammalia/Actinopterygii/Amphibia) — an
// Other Taxa bird/mammal/fish/amphibian folds into that existing folder rather than getting a
// separate one, since iNat's own naming happens to already match.
// Follows the user's own species_naming_styles preference (migration 082/091 — the same
// common/latin/aba_code/ebird_code ordered array used for species folder/EXIF naming), since an
// Other Taxa group's label has the same "Latin vs common vs both" question a species name does,
// and iNat's own iconic taxon names (Insecta, Mollusca, ...) are real, clean Latin class names —
// unlike Lifer's own 18 built-in groups, several of which are curated buckets with no single
// taxonomic name of their own (e.g. "Collector Shells"), so those stay fixed English labels.
// codes (aba_code/ebird_code) don't apply to a group label and are ignored here.
export function otherTaxaGroupLabel(iconicTaxon: string, namingStyles: string[]): string {
  const english = INAT_ICONIC_TAXON_LABEL[iconicTaxon] ?? iconicTaxon;
  const commonIdx = namingStyles.indexOf("common");
  const latinIdx = namingStyles.indexOf("latin");
  const wantsLatin = latinIdx !== -1;
  const wantsCommon = commonIdx !== -1 || !wantsLatin; // no explicit preference at all defaults to common
  if (wantsCommon && wantsLatin) return commonIdx <= latinIdx ? `${english} - ${iconicTaxon}` : `${iconicTaxon} - ${english}`;
  return wantsLatin ? iconicTaxon : english;
}

// General-purpose display label for a raw `taxon_class` DB value, covering both the 18 built-in
// classes and an Other Taxa species' raw lowercased iconic-taxon string (e.g. "insecta") — the
// latter has no entry in TAXON_CLASS_LABEL and must not be printed verbatim (unlabeled, no
// naming-style applied, wrong case). Mirrors CollectionPage.tsx's own `taxonFilterLabel`, which
// predates this shared helper — same iNat-casing restoration (lowercased column value is always a
// single already-capitalized word, e.g. "insecta" -> "Insecta") needed before `otherTaxaGroupLabel`
// can look up its English label or return the literal Latin text.
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
