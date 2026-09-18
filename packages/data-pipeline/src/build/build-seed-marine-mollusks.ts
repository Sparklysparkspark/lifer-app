// The marine gastropods — same order-level scope the old combined "mollusca" bucket used
// (Neogastropoda/Littorinimorpha/Trochida: marine shelled snails, still excluding land
// snails/slugs entirely), MINUS Nudibranchia (its own bucket). Not scoped to the whole
// Mollusca phylum (~178k GBIF entries, bigger than the entire rest of this app's catalog
// combined) — that's a deliberate, disclosed scope limit, not an oversight: bivalves
// (clams/oysters/mussels), chitons, and the vast un-common-named tail of Gastropoda are out
// of scope for now. A small, explicitly curated exception list (NOTABLE_BIVALVE_FAMILY_KEYS
// below) exists for specific bivalve families that are just as findable/photographable as the
// gastropods this bucket already covers and small enough not to reopen the "thousands of
// obscure species" problem.
//
// Used to split cowries/cones/murex/volutes/conchs/helmet-tun/augers/top-turban/harp/olive/
// miter/nutmeg shells out into a separate "collector_shells" bucket (the families shell
// collectors universally recognize as the classic prized groups) — merged back in here since
// the split wasn't functionally meaningful to users: in most countries outside the tropics,
// "collector_shells" only ever surfaced a thin, unglamorous residual of the same 2-3 cold-water
// families this bucket already has, not the visually distinctive tropical groups the name
// implies. COLLECTOR_SHELL_FAMILY_KEYS keeps those families' own GBIF fetch (they're specific
// families, not covered by the 3 broader orders below) without a second taxon_class.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneForKeys, type GbifSpeciesRow } from "../fetch/fetch-gbif-backbone.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { computeRarityPhase1 } from "./compute-rarity-phase1.js";
import { mapWithConcurrency } from "../concurrency.js";
import { BUILD_DIR } from "../raw-cache.js";

const NEOGASTROPODA_KEY = 982;
const LITTORINIMORPHA_KEY = 7390893;
const TROCHIDA_KEY = 9715180;

// The specific shell-collector families, verified against Britannica's shell-collecting entry
// and Conchologists of America's own introductory materials — most already sit inside
// Neogastropoda/Littorinimorpha/Trochida (fetchGbifBackboneForKeys dedupes by gbifKey across
// every key passed in, so listing them alongside the order keys above is safe, not a
// double-fetch), kept as its own explicit list purely for documentation of which families this
// bucket is specifically calling out as collector-recognized.
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

// Bivalves are out of scope for this bucket as a whole (see this file's own header comment —
// clams/oysters/mussels are excluded en masse, thousands of mostly-obscure species), but a
// handful of specific bivalve families are exactly as easy to find/identify/photograph as the
// gastropods this bucket already covers, and small enough that including them doesn't reopen
// the "thousands of obscure species" problem the blanket exclusion exists to avoid. Each
// addition here should be genuinely small (family key, not the whole class) and genuinely
// notable — verified via GBIF's own species API before adding (e.g. Tridacnidae has only 6
// species total), not assumed.
const NOTABLE_BIVALVE_FAMILY_KEYS = [
  3247671, // Tridacnidae — giant clams, ~6 species, unmistakable and easy to find on reef flats
];

const GBIF_CONCURRENCY = 16;

function canonical(g: GbifSpeciesRow): string {
  return g.canonicalName ?? g.scientificName;
}

function dateStamp(): string {
  return process.env.LIFER_BUILD_ID ?? "marine-mollusks-dev";
}

async function main() {
  const outDir = path.join(BUILD_DIR, dateStamp());
  mkdirSync(outDir, { recursive: true });

  console.log(
    "[build-seed-marine-mollusks] step 1/4: GBIF backbone (Neogastropoda, Littorinimorpha, Trochida, collector-shell families, + notable bivalve families)",
  );
  const gbif = await fetchGbifBackboneForKeys([
    NEOGASTROPODA_KEY,
    LITTORINIMORPHA_KEY,
    TROCHIDA_KEY,
    ...COLLECTOR_SHELL_FAMILY_KEYS,
    ...NOTABLE_BIVALVE_FAMILY_KEYS,
  ]);

  console.log(`[build-seed-marine-mollusks] step 2/4: common names (GBIF vernacularNames), ${GBIF_CONCURRENCY} concurrent`);
  let done = 0;
  const commonNames = await mapWithConcurrency(gbif, GBIF_CONCURRENCY, async (g) => {
    const name = await fetchCommonName(g.gbifKey);
    done++;
    if (done % 500 === 0) console.log(`[build-seed-marine-mollusks]   ${done} / ${gbif.length}`);
    return name;
  });
  const commonNameByGbifKey = new Map(gbif.map((g, i) => [g.gbifKey, commonNames[i]]));

  console.log("[build-seed-marine-mollusks] step 3/4: Wikidata (IUCN status, Commons image, Wikipedia sitelink)");
  const names = gbif.map(canonical);
  const wikidata = await fetchWikidataForSpecies(names);
  const wikidataByName = new Map(wikidata.map((r) => [r.scientificName, r]));

  const rarityInputs = gbif.map((g) => ({
    scientificName: canonical(g),
    rangeSizeKm2: null,
    iucnStatus: wikidataByName.get(canonical(g))?.iucnStatus ?? null,
  }));
  const rarity = computeRarityPhase1(rarityInputs);
  const rarityByName = new Map(rarity.map((r) => [r.scientificName, r]));

  // No visibility floor (unlike build-seed-generic.ts's requireVisibilitySignal, and unlike
  // this file's own prior behavior) — dropped deliberately: unlike birds/mammals/fish, where
  // lacking a common name usually signals a bad/synonym GBIF entry, the vast majority of real,
  // GBIF/iNat-documented, locally-occurring shell and mollusk species never get a common name
  // or a Wikipedia article at all (confirmed live: Hastula hectica, a real Red Sea auger shell
  // with GBIF records in 33+ countries, has neither). A species this taxon group actually
  // observes locally shouldn't be excluded from the catalog just because nobody's given it a
  // popular name — inclusion on any one REGION's checklist still requires real occurrence
  // evidence there (see compute-provinces-bulk.ts), this floor was only ever gating the catalog
  // itself.
  console.log("[build-seed-marine-mollusks] step 4/4: assembling species.json");
  const species = gbif.map((g) => {
    const name = canonical(g);
    const wiki = wikidataByName.get(name);
    const rarityRow = rarityByName.get(name);
    return {
      gbifKey: g.gbifKey,
      ebirdCode: null,
      inatTaxonId: null,
      scientificName: name,
      commonName: commonNameByGbifKey.get(g.gbifKey) ?? null,
      taxonClass: "marine_mollusks",
      family: g.family,
      taxonOrder: g.order,
      referencePhoto: null,
      referenceCredit: null,
      referenceLicense: null,
      description: null,
      descriptionCredit: null,
      descriptionSourceUrl: null,
      wikipediaTitle: wiki?.wikipediaTitle ?? null,
      commonsImage: wiki?.commonsImage ?? null,
      referenceGallery: [],
      traits: {
        massG: null,
        lengthMm: null,
        wingspanMm: null,
        handWingIndex: null,
        trophicNiche: null,
        primaryLifestyle: null,
        nocturnal: null,
        densityPerKm2: null,
        populationEstimate: null,
        homeRangeKm2: null,
        depthMinM: null,
        depthMaxM: null,
        iucnStatus: wiki?.iucnStatus ?? null,
        rangeSizeKm2: null,
        primaryHabitat: null,
        habitatDensity: null,
        domestic: false,
        sourceAttribution: "GBIF Backbone Taxonomy; GBIF vernacularNames; Wikidata",
      },
      rarity: rarityRow
        ? {
            rangeScore: rarityRow.rangeScore,
            abundanceScore: rarityRow.abundanceScore,
            elusivenessScore: null,
            composite: rarityRow.composite,
            tier: rarityRow.tier,
          }
        : null,
    };
  });

  writeFileSync(path.join(outDir, "species.json"), JSON.stringify(species, null, 2));
  writeFileSync(path.join(outDir, "regions.json"), JSON.stringify([], null, 2));
  writeFileSync(path.join(outDir, "region-species.json"), JSON.stringify({}, null, 2));

  const manifest = {
    buildId: dateStamp(),
    taxonClass: "marine_mollusks",
    speciesCount: species.length,
    sources: {
      gbifBackbone: { rows: gbif.length, api: "https://api.gbif.org/v1/species/search" },
      wikidata: { rows: wikidata.length, endpoint: "https://query.wikidata.org/sparql" },
    },
    note:
      "Neogastropoda + Littorinimorpha + Trochida + the collector-shell families (cowries, cones, murex, volutes, conchs, helmet/tun shells, augers, top/turban shells, harp/olive/miter/nutmeg shells) + notable bivalve exceptions, excluding Nudibranchia (its own bucket). Deliberately scoped, not the whole Mollusca phylum — bivalves/chitons/the rest of Gastropoda are out of scope for now, a disclosed gap. No trait source wired up.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed-marine-mollusks] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
