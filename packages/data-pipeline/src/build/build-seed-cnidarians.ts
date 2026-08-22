// Corals, sea anemones, and jellyfish — "cnidaria" is a UI-level grouping (see
// packages/shared/src/species.ts), not a single GBIF rank: Anthozoa (corals + anemones),
// Scyphozoa + Cubozoa (true jellyfish + box jellyfish), and Hydrozoa (hydroids, including
// jelly-like colonial forms like the Portuguese man o' war) — all four verified against GBIF's species API.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const ANTHOZOA_KEY = 206; // corals, sea anemones
const SCYPHOZOA_KEY = 352; // true jellyfish
const CUBOZOA_KEY = 176; // box jellyfish
const HYDROZOA_KEY = 205; // hydroids (incl. Portuguese man o' war)

buildGenericTaxonSeed({
  taxonClass: "cnidaria",
  taxonKeys: [ANTHOZOA_KEY, SCYPHOZOA_KEY, CUBOZOA_KEY, HYDROZOA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Anthozoa (corals/anemones) + Scyphozoa/Cubozoa (true/box jellyfish) + Hydrozoa (hydroids). No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "cnidarians-dev",
  logPrefix: "build-seed-cnidarians",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
