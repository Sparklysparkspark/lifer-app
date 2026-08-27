// The rest of the marine gastropods — same order-level scope the old combined "mollusca"
// bucket used (Neogastropoda/Littorinimorpha/Trochida: marine shelled snails, still
// excluding land snails/slugs entirely), MINUS whatever's already covered by the more
// specific "collector_shells" bucket (see its own comment for the family list) and MINUS
// Nudibranchia (its own bucket). Not scoped to the whole Mollusca phylum (~178k GBIF
// entries, bigger than the entire rest of this app's catalog combined) — that's a
// deliberate, disclosed scope limit, not an oversight: bivalves (clams/oysters/mussels),
// chitons, and the vast un-common-named tail of Gastropoda are out of scope for now.
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

// Same family list as build-seed-collector-shells.ts, by name (GbifSpeciesRow only carries
// the family NAME, not its key) — excluded here so a species isn't double-loaded under two
// different pack taxon classes.
const COLLECTOR_SHELL_FAMILIES = new Set([
  "Cypraeidae",
  "Conidae",
  "Muricidae",
  "Volutidae",
  "Strombidae",
  "Cassidae",
  "Tonnidae",
  "Terebridae",
  "Trochidae",
  "Turbinidae",
  "Harpidae",
  "Olividae",
  "Mitridae",
  "Cancellariidae",
]);

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

  console.log("[build-seed-marine-mollusks] step 1/4: GBIF backbone (Neogastropoda, Littorinimorpha, Trochida)");
  const gbifAll = await fetchGbifBackboneForKeys([NEOGASTROPODA_KEY, LITTORINIMORPHA_KEY, TROCHIDA_KEY]);
  const gbif = gbifAll.filter((g) => !g.family || !COLLECTOR_SHELL_FAMILIES.has(g.family));
  console.log(`[build-seed-marine-mollusks] excluded ${gbifAll.length - gbif.length} species already covered by collector_shells`);

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

  // Visibility floor (same reasoning as build-seed-generic.ts's requireVisibilitySignal) —
  // most of Gastropoda has no common name and no Wikipedia article; a species with neither
  // is dropped rather than loaded as an un-identifiable, un-photographable entry.
  const visible = gbif.filter((g) => commonNameByGbifKey.get(g.gbifKey) || wikidataByName.get(canonical(g))?.wikipediaTitle);
  console.log(`[build-seed-marine-mollusks] visibility floor: kept ${visible.length}/${gbif.length}`);

  console.log("[build-seed-marine-mollusks] step 4/4: assembling species.json");
  const species = visible.map((g) => {
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
      "Neogastropoda + Littorinimorpha + Trochida, excluding the collector_shells families and Nudibranchia (their own buckets). Deliberately scoped, not the whole Mollusca phylum — bivalves/chitons/the rest of Gastropoda are out of scope for now, a disclosed gap. No trait source wired up.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed-marine-mollusks] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
