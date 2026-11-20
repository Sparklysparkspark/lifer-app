// Taxon groups built by the shared GBIF + Wikidata builder (build-seed-generic.ts), run with
// `build-seed --group=<name>` (npm run build-seed-<name> -w data-pipeline). Birds, fish, mammals,
// marine mollusks and the test seed have trait sources of their own and keep their own scripts.
import type { GenericTaxonConfig } from "./build-seed-generic.js";

const ATTRIBUTION = "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)";

const group = (
  name: string,
  config: Omit<GenericTaxonConfig, "sourceAttribution" | "buildIdEnvVar" | "logPrefix">,
): [string, GenericTaxonConfig] => [
  name,
  { ...config, sourceAttribution: ATTRIBUTION, buildIdEnvVar: "LIFER_BUILD_ID", logPrefix: `build-seed-${name}` },
];

export const SEED_GROUPS = new Map<string, GenericTaxonConfig>([
  // Frogs, toads, salamanders, newts, caecilians: a single GBIF class key.
  group("amphibians", {
    taxonClass: "amphibia",
    taxonKeys: [131],
    note: "Amphibia (frogs/toads/salamanders/newts/caecilians). No trait source wired up. Reference photos/descriptions are lazy, same as birds.",
    defaultBuildId: "amphibians-dev",
  }),
  // Octopuses, squid, cuttlefish and nautiluses. One GBIF class key.
  group("cephalopods", {
    taxonClass: "cephalopoda",
    taxonKeys: [136],
    note: "Cephalopoda (octopuses, squid, cuttlefish, nautiluses). No trait source wired up.",
    defaultBuildId: "cephalopoda-dev",
  }),
  // Stony corals: Scleractinia (714) only, not the whole Anthozoa class, whose sea anemones
  // (Actiniaria) belong in jellies-anemones. Soft corals (Alcyonacea) aren't included: the name
  // didn't resolve against GBIF's species/match API.
  group("corals", {
    taxonClass: "corals",
    taxonKeys: [714],
    note: "Scleractinia (stony/reef-building corals) only: split out from the combined 'cnidaria' bucket. Soft corals (Alcyonacea) not included yet (GBIF key didn't resolve by hand, disclosed gap rather than guessed). No trait source wired up.",
    defaultBuildId: "corals-dev",
  }),
  // Decapoda (637) only (crabs, lobsters, shrimp, crayfish), the group people recognize and
  // photograph, rather than all of Malacostraca with its obscure copepods, amphipods and isopods.
  group("crustaceans", {
    taxonClass: "crustacea",
    taxonKeys: [637],
    note: "Decapoda (crabs/lobsters/shrimp/crayfish) only: deliberately scoped down from the whole Malacostraca class or Crustacea subphylum (mostly copepods/amphipods/isopods with no real photographability). No trait source wired up.",
    defaultBuildId: "crustacea-dev",
  }),
  // Sea stars (Asteroidea 214) and sea urchins and sand dollars (Echinoidea 221).
  group("echinoderms", {
    taxonClass: "echinodermata",
    taxonKeys: [214, 221],
    note: "Asteroidea (sea stars) + Echinoidea (sea urchins/sand dollars). No trait source wired up.",
    defaultBuildId: "echinoderms-dev",
  }),
  // Actiniaria (705, sea anemones; Scleractinia is the separate "corals" bucket) plus Scyphozoa
  // (352) and Cubozoa (176), true and box jellyfish, and Hydrozoa (205, hydroids, including
  // colonial forms like the Portuguese man o' war).
  group("jellies-anemones", {
    taxonClass: "jellies_and_anemones",
    taxonKeys: [705, 352, 176, 205],
    note: "Actiniaria (sea anemones) + Scyphozoa/Cubozoa (true/box jellyfish) + Hydrozoa (hydroids): split out from the combined 'cnidaria' bucket, complementing the separate 'corals' bucket (Scleractinia). No trait source wired up.",
    defaultBuildId: "jellies-anemones-dev",
  }),
  // Nudibranchia (980, sea slugs), their own bucket so divers can download sea slugs without
  // shelled marine snails and vice versa (see build-seed-marine-mollusks.ts).
  group("nudibranchs", {
    taxonClass: "nudibranchs",
    taxonKeys: [980],
    note: "Nudibranchia (sea slugs): split out from the combined 'mollusca' bucket for independent pack downloads. No trait source wired up.",
    defaultBuildId: "nudibranchs-dev",
  }),
  // Sponges, tunicates and other invertebrates as one bucket: Porifera (105) and Ascidiacea (356,
  // tunicates, sea squirts); other phyla (flatworms, bryozoans, ...) aren't included yet.
  group("sponges-tunicates", {
    taxonClass: "sponges_tunicates_other",
    taxonKeys: [105, 356],
    note: "Porifera (sponges) + Ascidiacea (tunicates/sea squirts). Other invertebrate phyla (flatworms, bryozoans, etc.) not included yet: disclosed gap, no clear scoping bar found for them yet. No trait source wired up.",
    defaultBuildId: "sponges-tunicates-dev",
    // Most sponges and tunicates are database-only names nobody could identify from a photo; keep
    // the ones with a common name or a Wikipedia article, as marine mollusks do.
    requireVisibilitySignal: true,
  }),
  // Reptiles other than turtles (their own bucket), so packs and collection browsing can be
  // filtered independently, as sharks and aquatic mammals are split from "actinopterygii".
  // Verified against GBIF's species/44/children. Squamata (11592253, lizards and snakes),
  // Crocodylia (11493978) and the 2 living tuatara species (Sphenodontia, 11569602) rather than
  // tiny buckets of their own. The taxon_class stays "squamata" to match existing region_species
  // rows; the display label is "Reptiles".
  group("squamata", {
    taxonClass: "squamata",
    taxonKeys: [11592253, 11493978, 11569602],
    note: "Squamata (lizards & snakes) + Crocodylia (crocodiles/alligators/caimans/gharials) + Sphenodontia (tuatara, 2 living species), split out from the combined 'reptilia' bucket for independent pack downloads, minus turtles (their own bucket). taxon_class stays 'squamata' for backward compatibility; displayed as 'Reptiles'. No trait source wired up.",
    defaultBuildId: "squamata-dev",
  }),
  // Turtles and tortoises (11418114), their own bucket (see squamata).
  group("testudines", {
    taxonClass: "testudines",
    taxonKeys: [11418114],
    note: "Testudines (turtles & tortoises): split out from the combined 'reptilia' bucket for independent pack downloads. No trait source wired up.",
    defaultBuildId: "testudines-dev",
  }),
]);
