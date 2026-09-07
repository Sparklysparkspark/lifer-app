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
