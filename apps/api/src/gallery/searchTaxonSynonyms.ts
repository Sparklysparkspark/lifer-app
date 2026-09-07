import type { TaxonClass } from "@lifer/shared";

// Plain-language words someone would actually type for a taxon group ("bird", "fish") mapped
// back to the taxon_class value species rows actually carry — TAXON_CLASS_LABEL's own display
// labels ("Bony Fish", "Sharks & Rays") aren't what a search query looks like, so this is its
// own, deliberately loose list: singular/plural and the handful of common synonyms someone
// would reach for, not an exhaustive taxonomy glossary.
export const TAXON_SEARCH_SYNONYMS: Record<TaxonClass, string[]> = {
  aves: ["bird", "birds", "aves"],
  mammalia: ["mammal", "mammals"],
  actinopterygii: ["fish"],
  elasmobranchii: ["shark", "sharks", "ray", "rays"],
  aquatic_mammalia: ["whale", "whales", "dolphin", "dolphins", "seal", "seals", "porpoise", "porpoises"],
  amphibia: ["amphibian", "amphibians", "frog", "frogs", "toad", "toads", "salamander", "salamanders"],
  squamata: ["lizard", "lizards", "snake", "snakes"],
  testudines: ["turtle", "turtles", "tortoise", "tortoises"],
  crocodylia: ["crocodile", "crocodiles", "alligator", "alligators", "caiman", "caimans"],
  corals: ["coral", "corals"],
  jellies_and_anemones: ["jellyfish", "jelly", "jellies", "anemone", "anemones"],
  echinodermata: ["starfish", "sea star", "urchin", "urchins", "sand dollar"],
  nudibranchs: ["nudibranch", "nudibranchs", "sea slug", "sea slugs"],
  collector_shells: ["shell", "shells"],
  marine_mollusks: ["mollusk", "mollusks", "mollusc", "molluscs", "snail", "snails", "clam", "clams"],
  cephalopoda: ["octopus", "octopuses", "squid", "cuttlefish"],
  crustacea: ["crab", "crabs", "lobster", "lobsters", "shrimp", "crustacean", "crustaceans"],
  sponges_tunicates_other: ["sponge", "sponges", "tunicate", "tunicates"],
};

// Reverse index — word -> taxon_class — built once at module load rather than scanning the
// whole synonym table per query token.
export const TAXON_WORD_TO_CLASS: Map<string, TaxonClass> = new Map(
  Object.entries(TAXON_SEARCH_SYNONYMS).flatMap(([taxonClass, words]) =>
    words.map((word) => [word, taxonClass as TaxonClass] as const),
  ),
);
