// Lizards & snakes — split out of what used to be one combined "reptilia" bucket so packs
// (and, per the fine-grained taxon UI, collection browsing) can be downloaded/filtered
// per reptile group independently, the same way sharks/aquatic mammals were split out of
// "actinopterygii". Verified against GBIF's species/44/children.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const SQUAMATA_KEY = 11592253; // lizards & snakes

buildGenericTaxonSeed({
  taxonClass: "squamata",
  taxonKeys: [SQUAMATA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Squamata (lizards & snakes) — split out from the combined 'reptilia' bucket for independent pack downloads. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "squamata-dev",
  logPrefix: "build-seed-squamata",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
