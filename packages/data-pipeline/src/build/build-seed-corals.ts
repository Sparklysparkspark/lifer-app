// Stony corals: Scleractinia only, not the whole Anthozoa class, whose sea anemones (Actiniaria)
// belong in build-seed-jellies-anemones.ts. Soft corals (Alcyonacea) aren't included: the name
// didn't resolve against GBIF's species/match API.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const SCLERACTINIA_KEY = 714; // stony/reef-building corals

buildGenericTaxonSeed({
  taxonClass: "corals",
  taxonKeys: [SCLERACTINIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Scleractinia (stony/reef-building corals) only: split out from the combined 'cnidaria' bucket. Soft corals (Alcyonacea) not included yet (GBIF key didn't resolve by hand, disclosed gap rather than guessed). No trait source wired up: rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "corals-dev",
  logPrefix: "build-seed-corals",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
