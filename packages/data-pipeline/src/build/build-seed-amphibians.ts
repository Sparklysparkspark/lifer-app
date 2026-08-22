// Amphibians (frogs, toads, salamanders, newts, caecilians) — a single, clean GBIF class
// key (131), verified against GBIF's own species API, same simplicity as birds/mammals.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const AMPHIBIA_CLASS_KEY = 131;

buildGenericTaxonSeed({
  taxonClass: "amphibia",
  taxonKeys: [AMPHIBIA_CLASS_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Amphibia (frogs/toads/salamanders/newts/caecilians). No trait source wired up — rarity leans on IUCN status alone. Reference photos/descriptions are lazy, same as birds.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "amphibians-dev",
  logPrefix: "build-seed-amphibians",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
