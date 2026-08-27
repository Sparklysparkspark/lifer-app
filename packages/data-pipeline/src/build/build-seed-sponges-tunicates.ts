// Sponges, tunicates & other invertebrates — lumped together as one bucket, matching how
// the request itself grouped them (not every invertebrate group is popular/distinct enough
// to warrant its own separate download option). Porifera (sponges) + Ascidiacea (tunicates,
// sea squirts) are the two clean GBIF class keys covered; "& other invertebrates" stays a
// disclosed gap for now rather than an attempt to enumerate every remaining phylum
// (flatworms, bryozoans, etc.) with no clear photographability bar to scope them by.
import { buildGenericTaxonSeed } from "./build-seed-generic.js";

const PORIFERA_KEY = 105; // sponges
const ASCIDIACEA_KEY = 356; // tunicates, sea squirts

buildGenericTaxonSeed({
  taxonClass: "sponges_tunicates_other",
  taxonKeys: [PORIFERA_KEY, ASCIDIACEA_KEY],
  sourceAttribution: "GBIF Backbone Taxonomy; Wikidata (no dedicated trait source yet)",
  note: "Porifera (sponges) + Ascidiacea (tunicates/sea squirts). Other invertebrate phyla (flatworms, bryozoans, etc.) not included yet — disclosed gap, no clear scoping bar found for them yet. No trait source wired up — rarity leans on IUCN status alone.",
  buildIdEnvVar: "LIFER_BUILD_ID",
  defaultBuildId: "sponges-tunicates-dev",
  logPrefix: "build-seed-sponges-tunicates",
  requireVisibilitySignal: true,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
