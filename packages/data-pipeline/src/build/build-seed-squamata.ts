// Reptiles other than turtles (their own bucket), so packs and collection browsing can be
// filtered independently, as sharks and aquatic mammals are split from "actinopterygii".
// Verified against GBIF's species/44/children.
//
// Crocodilians and the 2 living tuatara species are included here rather than in tiny buckets
// of their own. The taxon_class stays "squamata" to match existing region_species rows; the
// display label is "Reptiles".
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const SQUAMATA_KEY = 11592253; // lizards & snakes
const CROCODYLIA_KEY = 11493978; // crocodiles, alligators, caimans, gharials
const SPHENODONTIA_KEY = 11569602; // tuatara

buildGenericTaxonSeed({
  taxonClass: "squamata",
  taxonKeys: [SQUAMATA_KEY, CROCODYLIA_KEY, SPHENODONTIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Squamata (lizards & snakes) + Crocodylia (crocodiles/alligators/caimans/gharials) + Sphenodontia (tuatara, 2 living species), split out from the combined 'reptilia' bucket for independent pack downloads, minus turtles (their own bucket). taxon_class stays 'squamata' for backward compatibility; displayed as 'Reptiles'. No trait source wired up; rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "squamata-dev",
  logPrefix: "build-seed-squamata",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
