// Turtles & tortoises — split out of the combined "reptilia" bucket, same reasoning as
// build-seed-squamata.ts.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const TESTUDINES_KEY = 11418114; // turtles & tortoises

buildGenericTaxonSeed({
  taxonClass: "testudines",
  taxonKeys: [TESTUDINES_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Testudines (turtles & tortoises) — split out from the combined 'reptilia' bucket for independent pack downloads. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "testudines-dev",
  logPrefix: "build-seed-testudines",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
