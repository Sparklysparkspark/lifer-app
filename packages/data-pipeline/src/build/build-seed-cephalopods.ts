// Cephalopods — octopuses, squid, cuttlefish, and nautiluses. One clean GBIF class key,
// verified against GBIF's species API.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const CEPHALOPODA_KEY = 136;

buildGenericTaxonSeed({
  taxonClass: "cephalopoda",
  taxonKeys: [CEPHALOPODA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Cephalopoda (octopuses, squid, cuttlefish, nautiluses). No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "cephalopoda-dev",
  logPrefix: "build-seed-cephalopods",
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
