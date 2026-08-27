// "Collector shells" — the specific families universally recognized by shell collectors as
// the classic prized/sought-after groups (verified against Britannica's shell-collecting
// entry and Conchologists of America's own introductory materials, not a single guessed
// list): cowries, cone shells, murex/rock shells, volutes, conchs, helmet/tun shells,
// augers, top/turban shells, harp shells, olive shells, miter shells, and nutmeg shells.
// This is deliberately FAMILY-rank, not the coarser ORDER-rank scoping the old combined
// "mollusca" bucket used (Neogastropoda/Littorinimorpha/Trochida) — those orders contain
// many thousands of obscure, non-collector-relevant species (small mud-dwelling or deep-sea
// snails) alongside the real collector families, so family-level keys are the more precise
// answer to "what would someone actually go looking for." Any real collector family missing
// from this list is a disclosed gap, not a deliberate exclusion.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const COLLECTOR_SHELL_FAMILY_KEYS = [
  2675, // Cypraeidae — cowries
  6779, // Conidae — cone shells
  2304120, // Muricidae — murex, rock shells
  6767, // Volutidae — volutes
  7064, // Strombidae — conchs
  6761, // Cassidae — helmet shells
  2661, // Tonnidae — tun shells
  2685, // Terebridae — augers
  2856, // Trochidae — top shells
  6802, // Turbinidae — turban shells
  6775, // Harpidae — harp shells
  2687, // Olividae — olive shells
  6773, // Mitridae — miter shells
  2303085, // Cancellariidae — nutmeg shells
];

buildGenericTaxonSeed({
  taxonClass: "collector_shells",
  taxonKeys: COLLECTOR_SHELL_FAMILY_KEYS,
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Family-level scoping to the shell families collectors universally recognize as the classic prized groups (cowries, cones, murex, volutes, conchs, helmet/tun shells, augers, top/turban shells, harp/olive/miter/nutmeg shells) — split out from the old combined order-level 'mollusca' bucket, which also caught thousands of obscure non-collector species in the same orders. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "collector-shells-dev",
  logPrefix: "build-seed-collector-shells",
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
