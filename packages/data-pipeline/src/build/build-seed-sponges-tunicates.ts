// Sponges, tunicates & other invertebrates, as one bucket. Porifera (sponges) and Ascidiacea
// (tunicates, sea squirts) are the two GBIF class keys covered; other phyla (flatworms,
// bryozoans, ...) aren't included yet.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const PORIFERA_KEY = 105; // sponges
const ASCIDIACEA_KEY = 356; // tunicates, sea squirts

buildGenericTaxonSeed({
  taxonClass: "sponges_tunicates_other",
  taxonKeys: [PORIFERA_KEY, ASCIDIACEA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Porifera (sponges) + Ascidiacea (tunicates/sea squirts). Other invertebrate phyla (flatworms, bryozoans, etc.) not included yet: disclosed gap, no clear scoping bar found for them yet. No trait source wired up: rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "sponges-tunicates-dev",
  logPrefix: "build-seed-sponges-tunicates",
  // Most sponges and tunicates are database-only names nobody could identify from a photo; keep
  // the ones with a common name or a Wikipedia article, as marine mollusks do.
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
