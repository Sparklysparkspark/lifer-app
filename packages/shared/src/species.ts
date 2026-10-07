// Mirrors the Phase-1 subset of (species, species_traits, species_rarity).

// Fine-grained on purpose: every value is independently downloadable and filterable (see
// build-region-pack.ts's --taxon flag), so a user who only wants sharks skips every bony fish:
//   - "actinopterygii" (bony fish) vs "elasmobranchii" (sharks/rays) vs "aquatic_mammalia"
//     (whales/dolphins/dugongs, split out of "mammalia" since they're not land mammals)
//   - "reptilia" split into "squamata" (lizards/snakes, plus crocodilians and the 2 living
//     tuatara species, see build-seed-squamata.ts) vs "testudines" (turtles)
//   - "cnidaria" split into "corals" (Scleractinia) vs "jellies_and_anemones"
//     (Actiniaria/Scyphozoa/Cubozoa/Hydrozoa)
//   - "mollusca" split into "nudibranchs" (Nudibranchia) and "marine_mollusks" (the rest of
//     the same marine gastropod orders, minus nudibranchs).
//   - "cephalopoda", "crustacea" (Decapoda only: crabs/lobsters/shrimp), "sponges_tunicates_other",
//     and "echinodermata" (sea stars and urchins).
export type TaxonClass =
  | "aves"
  | "mammalia"
  | "actinopterygii"
  | "elasmobranchii"
  | "aquatic_mammalia"
  | "amphibia"
  | "squamata"
  | "testudines"
  | "corals"
  | "jellies_and_anemones"
  | "echinodermata"
  | "nudibranchs"
  | "marine_mollusks"
  | "cephalopoda"
  | "crustacea"
  | "sponges_tunicates_other";

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
  /** One-sentence Wikipedia-sourced ID caption: a quick-glance hint, not a field guide entry. */
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

export type PrimaryLifestyle = "Terrestrial" | "Aquatic" | "Aerial" | "Insessorial" | "Generalist";

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

// "unrated": species with no distinguishing data (no IUCN status, elusiveness, density or
// nocturnal signal) get this instead of an arbitrary tie-broken difficulty tier.
export type RarityTier = "common" | "occasional" | "uncommon" | "rare" | "legendary" | "unrated";

export interface SpeciesRarity {
  speciesId: string;
  rangeScore: number;
  abundanceScore: number;
  elusivenessScore: number | null;
  composite: number;
  tier: RarityTier;
  computedAt: string;
}
