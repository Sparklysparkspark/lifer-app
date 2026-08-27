// Jellies & anemones — split out of the combined "cnidaria" bucket: Actiniaria (sea
// anemones, an Anthozoa order — the other Anthozoa order, Scleractinia, is the separate
// "corals" bucket) plus Scyphozoa/Cubozoa (true/box jellyfish) and Hydrozoa (hydroids,
// including jelly-like colonial forms like the Portuguese man o' war).
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const ACTINIARIA_KEY = 705; // sea anemones
const SCYPHOZOA_KEY = 352; // true jellyfish
const CUBOZOA_KEY = 176; // box jellyfish
const HYDROZOA_KEY = 205; // hydroids (incl. Portuguese man o' war)

buildGenericTaxonSeed({
  taxonClass: "jellies_and_anemones",
  taxonKeys: [ACTINIARIA_KEY, SCYPHOZOA_KEY, CUBOZOA_KEY, HYDROZOA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Actiniaria (sea anemones) + Scyphozoa/Cubozoa (true/box jellyfish) + Hydrozoa (hydroids) — split out from the combined 'cnidaria' bucket, complementing the separate 'corals' bucket (Scleractinia). No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "jellies-anemones-dev",
  logPrefix: "build-seed-jellies-anemones",
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
