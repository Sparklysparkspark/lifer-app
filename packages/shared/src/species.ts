// Mirrors the Phase-1 subset of lifer-spec.md §6 (species, species_traits, species_rarity).

// Fine-grained on purpose — every value here is independently downloadable/filterable (see
// build-region-pack.ts's --taxon flag and the collection page's taxon picker), not just a
// display label. Groups that used to be one coarser bucket were split so a user who only
// cares about, say, sharks isn't forced to also download every bony fish:
//   - "actinopterygii" (bony fish) vs "elasmobranchii" (sharks/rays) vs "aquatic_mammalia"
//     (whales/dolphins/dugongs — real Mammalia taxonomically, reclassified out of both
//     "mammalia" and "actinopterygii" since they're neither a land mammal nor a fish)
//   - "reptilia" split into "squamata" (lizards/snakes), "testudines" (turtles),
//     "crocodylia" (crocodilians + the 2 living tuatara species)
//   - "cnidaria" split into "corals" (Scleractinia) vs "jellies_and_anemones"
//     (Actiniaria/Scyphozoa/Cubozoa/Hydrozoa)
//   - "mollusca" split into "nudibranchs" (Nudibranchia), "collector_shells" (the specific
//     families shell collectors universally recognize — cowries, cones, murex, volutes,
//     etc., see build-seed-collector-shells.ts), and "marine_mollusks" (the rest of the same
//     marine gastropod orders, minus those two)
// New invertebrate groups with no prior bucket at all: "cephalopoda", "crustacea" (scoped to
// Decapoda — crabs/lobsters/shrimp — not the whole Malacostraca class),
// "sponges_tunicates_other". "echinodermata" (sea stars + sea urchins) is unchanged.
export type TaxonClass =
  | "aves"
  | "mammalia"
  | "actinopterygii"
  | "elasmobranchii"
  | "aquatic_mammalia"
  | "amphibia"
  | "squamata"
  | "testudines"
  | "crocodylia"
  | "corals"
  | "jellies_and_anemones"
  | "echinodermata"
  | "nudibranchs"
  | "collector_shells"
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
