// Reptiles (minus turtles, their own bucket), split out of what used to be one combined
// "reptilia" bucket so packs (and, per the fine-grained taxon UI, collection browsing) can be
// downloaded/filtered independently, the same way sharks/aquatic mammals were split out of
// "actinopterygii". Verified against GBIF's species/44/children.
//
// Used to split crocodilians out into their own "crocodylia" bucket, merged back in here
// (confirmed with the user) since 35 species worldwide, typically only 1 per province where
// present at all, wasn't enough to justify a standalone download option; the taxon_class stays
// "squamata" for backward compatibility with existing region_species rows, but the display
// label is "Reptiles" now, not "Lizards & Snakes", since crocodilians (and the 2 living tuatara
// species, lumped in with them rather than given their own tiny bucket) are taxonomically
// distinct from Squamata proper.
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
