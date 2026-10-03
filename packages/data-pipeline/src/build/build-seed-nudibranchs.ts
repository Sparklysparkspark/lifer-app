// Nudibranchs (sea slugs), their own bucket so divers can download sea slugs without shelled
// marine snails and vice versa (see build-seed-marine-mollusks.ts).
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const NUDIBRANCHIA_KEY = 980; // sea slugs

buildGenericTaxonSeed({
  taxonClass: "nudibranchs",
  taxonKeys: [NUDIBRANCHIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Nudibranchia (sea slugs): split out from the combined 'mollusca' bucket for independent pack downloads. No trait source wired up: rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "nudibranchs-dev",
  logPrefix: "build-seed-nudibranchs",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
