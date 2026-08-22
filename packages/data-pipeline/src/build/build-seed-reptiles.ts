// Reptiles — GBIF's backbone has no single "Reptilia" class (the same gap fish has):
// lizards/snakes, turtles, crocodilians, and the tuatara sit as four separate
// class-rank groups directly under Chordata rather than one paraphyletic "Reptilia". All
// four verified against GBIF's own species API.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const SQUAMATA_KEY = 11592253; // lizards & snakes
const TESTUDINES_KEY = 11418114; // turtles & tortoises
const CROCODYLIA_KEY = 11493978; // crocodiles, alligators, caimans, gharials
const SPHENODONTIA_KEY = 11569602; // tuatara

buildGenericTaxonSeed({
  taxonClass: "reptilia",
  taxonKeys: [SQUAMATA_KEY, TESTUDINES_KEY, CROCODYLIA_KEY, SPHENODONTIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Squamata (lizards/snakes) + Testudines (turtles) + Crocodylia + Sphenodontia (tuatara) — GBIF has no single 'Reptilia' class. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "reptiles-dev",
  logPrefix: "build-seed-reptiles",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
