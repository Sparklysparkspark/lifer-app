// Nudibranchs (sea slugs) — split out of what used to be a combined "mollusca" bucket
// (shelled marine snails + nudibranchs together) so a diver/underwater-photography-focused
// user can download sea slugs without also getting shell-collecting species, and vice versa
// (see build-seed-collector-shells.ts / build-seed-marine-mollusks.ts).
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const NUDIBRANCHIA_KEY = 980; // sea slugs

buildGenericTaxonSeed({
  taxonClass: "nudibranchs",
  taxonKeys: [NUDIBRANCHIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Nudibranchia (sea slugs) — split out from the combined 'mollusca' bucket for independent pack downloads. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "nudibranchs-dev",
  logPrefix: "build-seed-nudibranchs",
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
