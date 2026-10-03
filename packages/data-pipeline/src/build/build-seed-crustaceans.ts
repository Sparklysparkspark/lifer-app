// Crustaceans: Decapoda only (crabs, lobsters, shrimp, crayfish), the group people recognize and
// photograph, rather than all of Malacostraca with its obscure copepods, amphipods and isopods.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const DECAPODA_KEY = 637; // crabs, lobsters, shrimp, crayfish

buildGenericTaxonSeed({
  taxonClass: "crustacea",
  taxonKeys: [DECAPODA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Decapoda (crabs/lobsters/shrimp/crayfish) only: deliberately scoped down from the whole Malacostraca class or Crustacea subphylum (mostly copepods/amphipods/isopods with no real photographability). No trait source wired up: rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "crustacea-dev",
  logPrefix: "build-seed-crustaceans",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
