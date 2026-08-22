// Mollusks — deliberately scoped to 4 GBIF orders under Gastropoda, not the whole class:
// Gastropoda alone is ~178k GBIF entries, bigger than everything else combined.
// Neogastropoda/Littorinimorpha/Trochida cover the classic shell-collecting marine snails
// (cone shells, cowries, conchs, murex, whelks, olives, top shells); Nudibranchia covers sea
// slugs, a major diver-photography subject. Land snails/slugs (Stylommatophora) are
// deliberately excluded as outside the app's photographability focus. All four taxon keys
// are verified against GBIF's species API.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const NEOGASTROPODA_KEY = 982; // cone shells, murex, whelks, olives, volutes
const LITTORINIMORPHA_KEY = 7390893; // cowries, conchs, moon snails, periwinkles
const TROCHIDA_KEY = 9715180; // top shells, turban shells
const NUDIBRANCHIA_KEY = 980; // sea slugs

buildGenericTaxonSeed({
  taxonClass: "mollusca",
  taxonKeys: [NEOGASTROPODA_KEY, LITTORINIMORPHA_KEY, TROCHIDA_KEY, NUDIBRANCHIA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Neogastropoda + Littorinimorpha + Trochida (marine shelled snails) + Nudibranchia (sea slugs) — deliberately excludes the rest of Gastropoda, including land snails/slugs (Stylommatophora). No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "mollusks-dev",
  logPrefix: "build-seed-mollusks",
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
