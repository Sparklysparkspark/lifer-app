import type { TaxonClass } from "./species.js";

// Canonical, single source of truth for taxon-group display labels — previously duplicated
// (and incomplete, only 3 of these 18 groups) in both CollectionPage.tsx and
// OfflinePacksPage.tsx. Copy for the 15 groups with no prior label is a first pass, meant to be
// reviewed as real product-facing text, not treated as final.
export const TAXON_CLASS_LABEL: Record<TaxonClass, string> = {
  aves: "Birds",
  mammalia: "Mammals",
  actinopterygii: "Bony Fish",
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
