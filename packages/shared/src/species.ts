// Mirrors the Phase-1 subset of lifer-spec.md §6 (species, species_traits, species_rarity).

// "amphibia"/"reptilia" cover herps. "cnidaria" covers corals+anemones+jellyfish
// (Anthozoa/Scyphozoa/Cubozoa/Hydrozoa — GBIF has no single "jellyfish" class, so this is a
// UI-level grouping, same simplification already used for "actinopterygii" bundling
// non-Actinopterygii fish classes). "echinodermata" covers sea stars+sea urchins
// (Asteroidea/Echinoidea). "mollusca" is deliberately scoped to 4 GBIF orders, not the whole
// Gastropoda class (Gastropoda alone is ~178k GBIF entries, bigger than everything else
// combined): Neogastropoda/Littorinimorpha/Trochida (the classic shell-collecting marine
// snails — cones, cowries, conchs, murex, whelks, top shells) plus Nudibranchia (sea slugs);
// land snails/slugs (Stylommatophora) are excluded.
export type TaxonClass =
  | "aves"
  | "mammalia"
  | "actinopterygii"
  | "amphibia"
  | "reptilia"
  | "cnidaria"
  | "echinodermata"
  | "mollusca";

export interface Species {
  id: string;
  gbifKey: number;
  ebirdCode: string | null;
  inatTaxonId: number | null;
  scientificName: string;
  commonName: string | null;
  taxonClass: TaxonClass;
  family: string | null;
  taxonOrder: string | null;
  sortOrder: number | null;
  referencePhoto: string | null;
  referenceCredit: string | null;
  /** Actual CC license code, e.g. "cc-by" or "cc-by-nc". Non-null whenever referencePhoto is set. */
  referenceLicense: string | null;
  /** One-sentence Wikipedia-sourced ID caption — not a field guide entry, just a quick-glance hint. */
  description: string | null;
  descriptionCredit: string | null;
  descriptionSourceUrl: string | null;
}

export type TrophicNiche =
  | "Frugivore"
  | "Granivore"
  | "Nectarivore"
  | "Herbivore aquatic"
  | "Herbivore terrestrial"
  | "Aquatic predator"
  | "Invertivore"
  | "Vertivore"
  | "Scavenger"
  | "Omnivore";

export type PrimaryLifestyle =
  | "Terrestrial"
  | "Aquatic"
  | "Aerial"
  | "Insessorial"
  | "Generalist";

export interface SpeciesTraits {
  speciesId: string;
  massG: number | null;
  lengthMm: number | null;
  wingspanMm: number | null;
  handWingIndex: number | null;
  trophicNiche: TrophicNiche | null;
  primaryLifestyle: PrimaryLifestyle | null;
  nocturnal: boolean | null;
  densityPerKm2: number | null;
  homeRangeKm2: number | null;
  depthMinM: number | null;
  depthMaxM: number | null;
  iucnStatus: string | null;
  rangeSizeKm2: number | null;
  sourceAttribution: string;
}

// "unrated" — mammals/fish with no real distinguishing data (no IUCN status, no elusiveness
// crawl match, no density/population/nocturnal signal) get this instead of a difficulty
// tier, rather than being forced onto the ladder by an arbitrary tie-break among a huge
// "nothing known" pool.
export type RarityTier = "common" | "uncommon" | "rare" | "epic" | "legendary" | "unrated";

export interface SpeciesRarity {
  speciesId: string;
  rangeScore: number;
  abundanceScore: number;
  elusivenessScore: number | null;
  composite: number;
  tier: RarityTier;
  computedAt: string;
}
