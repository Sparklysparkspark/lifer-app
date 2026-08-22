// Sea stars and sea urchins — two clean GBIF class keys, verified against GBIF's species API.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const ASTEROIDEA_KEY = 214; // sea stars
const ECHINOIDEA_KEY = 221; // sea urchins, sand dollars

buildGenericTaxonSeed({
  taxonClass: "echinodermata",
  taxonKeys: [ASTEROIDEA_KEY, ECHINOIDEA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Asteroidea (sea stars) + Echinoidea (sea urchins/sand dollars). No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "echinoderms-dev",
  logPrefix: "build-seed-echinoderms",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
