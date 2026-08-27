// Crocodilians + tuataras — split out of the combined "reptilia" bucket. Tuataras (2 living
// species) are lumped in here rather than given their own tiny bucket — not worth a
// separate download option for 2 species.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const CROCODYLIA_KEY = 11493978; // crocodiles, alligators, caimans, gharials
const SPHENODONTIA_KEY = 11569602; // tuatara

buildGenericTaxonSeed({
  taxonClass: "crocodylia",
  taxonKeys: [CROCODYLIA_KEY, SPHENODONTIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Crocodylia (crocodiles/alligators/caimans/gharials) + Sphenodontia (tuatara, 2 living species, lumped in rather than given its own bucket) — split out from the combined 'reptilia' bucket. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "crocodylia-dev",
  logPrefix: "build-seed-crocodylia",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
