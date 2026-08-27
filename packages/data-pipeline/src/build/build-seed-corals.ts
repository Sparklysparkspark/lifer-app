// Stony corals — split out of the combined "cnidaria" bucket, scoped to Scleractinia (the
// dominant reef-building coral order) rather than the whole Anthozoa class, since Anthozoa
// also contains sea anemones (Actiniaria — see build-seed-jellies-anemones.ts) which belong
// in the separate "jellies & anemones" bucket, not here. Soft corals (order Alcyonacea) are
// a disclosed gap — that name didn't resolve against GBIF's species/match API by hand, and
// rather than guess a key, this stays Scleractinia-only for now.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const SCLERACTINIA_KEY = 714; // stony/reef-building corals

buildGenericTaxonSeed({
  taxonClass: "corals",
  taxonKeys: [SCLERACTINIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Scleractinia (stony/reef-building corals) only — split out from the combined 'cnidaria' bucket. Soft corals (Alcyonacea) not included yet (GBIF key didn't resolve by hand, disclosed gap rather than guessed). No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "corals-dev",
  logPrefix: "build-seed-corals",
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
