// Marine gastropods: Neogastropoda, Littorinimorpha and Trochida (marine shelled snails, no
// land snails or slugs), minus Nudibranchia (its own bucket). Not the whole Mollusca phylum,
// which is bigger than the rest of the catalog combined: bivalves, chitons and the long tail of
// uncommon-named gastropods are out of scope, apart from a small curated list of notable
// bivalve families (NOTABLE_BIVALVE_FAMILY_KEYS). The classic collector-shell families are
// listed explicitly (COLLECTOR_SHELL_FAMILY_KEYS) under the same taxon_class.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneForKeys, type GbifSpeciesRow } from "@lifer/core/gbif/backbone.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { computeRarityPhase1 } from "@lifer/core/species/computeRarityPhase1.js";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { BUILD_DIR } from "@lifer/core/rawCache.js";

const NEOGASTROPODA_KEY = 982;
const LITTORINIMORPHA_KEY = 7390893;
const TROCHIDA_KEY = 9715180;

// Shell-collector families (per Britannica and Conchologists of America). Most already sit
// inside the orders above; fetchGbifBackboneForKeys dedupes by gbifKey, so listing them is safe.
const COLLECTOR_SHELL_FAMILY_KEYS = [
  2675, // Cypraeidae: cowries
  6779, // Conidae: cone shells
  2304120, // Muricidae: murex, rock shells
  6767, // Volutidae: volutes
  7064, // Strombidae: conchs
  6761, // Cassidae: helmet shells
  2661, // Tonnidae: tun shells
  2685, // Terebridae: augers
  2856, // Trochidae: top shells
  6802, // Turbinidae: turban shells
  6775, // Harpidae: harp shells
  2687, // Olividae: olive shells
  6773, // Mitridae: miter shells
  2303085, // Cancellariidae: nutmeg shells
];

// Bivalves are out of scope as a whole, but a few small families are as easy to find and
// photograph as these gastropods. Additions should be a single small family, checked against
// GBIF's species API first.
const NOTABLE_BIVALVE_FAMILY_KEYS = [
  3247671, // Tridacnidae: giant clams, ~6 species, easy to find on reef flats
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

  // No visibility floor (unlike build-seed-generic.ts's requireVisibilitySignal): most real shell
  // species never get a common name or Wikipedia article. A region's checklist still requires
  // real occurrence evidence there (see compute-provinces-bulk.ts).
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
      "Neogastropoda + Littorinimorpha + Trochida + the collector-shell families (cowries, cones, murex, volutes, conchs, helmet/tun shells, augers, top/turban shells, harp/olive/miter/nutmeg shells) + notable bivalve exceptions, excluding Nudibranchia (its own bucket). Deliberately scoped, not the whole Mollusca phylum: bivalves/chitons/the rest of Gastropoda are out of scope for now, a disclosed gap. No trait source wired up.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed-marine-mollusks] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
