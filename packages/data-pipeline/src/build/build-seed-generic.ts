// Shared builder for taxa with no dedicated trait source: GBIF backbone + common names +
// Wikidata (IUCN/photos/wiki links) + Phase-1 rarity (range+IUCN). Used by herps, cnidarians,
// echinoderms and mollusks, so a future trait source only needs wiring in one place.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneForKeys, type GbifSpeciesRow } from "../fetch/fetch-gbif-backbone.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { computeRarityPhase1 } from "./compute-rarity-phase1.js";
import { mapWithConcurrency } from "../concurrency.js";
import { BUILD_DIR } from "../raw-cache.js";

const GBIF_CONCURRENCY = 16;
const MIN_HUMAN_OBSERVATIONS = 10;

/** "name<TAB>count" lines (the same name may repeat, one line per country); empty when unset. */
function loadHumanObservationCounts(file: string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  if (!file) return counts;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [name, count] = line.split("\t");
    if (name) counts.set(name, (counts.get(name) ?? 0) + Number(count || 0));
  }
  return counts;
}

function canonical(g: GbifSpeciesRow): string {
  return g.canonicalName ?? g.scientificName;
}

export interface GenericTaxonConfig {
  taxonClass: string;
  taxonKeys: number[];
  sourceAttribution: string;
  note: string;
  buildIdEnvVar: string;
  defaultBuildId: string;
  logPrefix: string;
  // Most invertebrate groups are dominated by database-only entries with no common name, no
  // Wikipedia article and often no records, which nobody could identify or photograph. When
  // true, a species with neither a common name nor a Wikipedia sitelink is dropped.
  requireVisibilitySignal?: boolean;
}

export async function buildGenericTaxonSeed(config: GenericTaxonConfig): Promise<void> {
  const dateStamp = process.env[config.buildIdEnvVar] ?? config.defaultBuildId;
  const outDir = path.join(BUILD_DIR, dateStamp);
  mkdirSync(outDir, { recursive: true });

  console.log(`[${config.logPrefix}] step 1/4: GBIF backbone (${config.taxonKeys.length} taxon key(s))`);
  const gbif = await fetchGbifBackboneForKeys(config.taxonKeys);

  console.log(`[${config.logPrefix}] step 2/4: common names (GBIF vernacularNames)`);
  let done = 0;
  const commonNames = await mapWithConcurrency(gbif, GBIF_CONCURRENCY, async (g) => {
    const name = await fetchCommonName(g.gbifKey);
    done++;
    if (done % 500 === 0) console.log(`[${config.logPrefix}]   ${done} / ${gbif.length}`);
    return name;
  });
  const commonNameByGbifKey = new Map(gbif.map((g, i) => [g.gbifKey, commonNames[i]]));

  console.log(`[${config.logPrefix}] step 3/4: Wikidata (IUCN status, Commons image, Wikipedia sitelink) + rarity`);
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

  let visible = gbif;
  if (config.requireVisibilitySignal) {
    // A common name, a Wikipedia article, or evidence people photograph it: at least
    // MIN_HUMAN_OBSERVATIONS human observations in the cached GBIF country downloads (a
    // "name<TAB>count" file in LIFER_HUMAN_OBSERVATION_COUNTS). Sponges and tunicates are mostly
    // known only by scientific name, so the name test alone drops too many. Museum and dredge
    // specimens don't count.
    const humanObservations = loadHumanObservationCounts(process.env.LIFER_HUMAN_OBSERVATION_COUNTS);
    visible = gbif.filter(
      (g) =>
        commonNameByGbifKey.get(g.gbifKey) ||
        wikidataByName.get(canonical(g))?.wikipediaTitle ||
        (humanObservations.get(canonical(g)) ?? 0) >= MIN_HUMAN_OBSERVATIONS,
    );
    console.log(
      `[${config.logPrefix}] visibility floor: kept ${visible.length}/${gbif.length} (a common name, a Wikipedia article, or ${MIN_HUMAN_OBSERVATIONS}+ human observations)`,
    );
  }

  console.log(`[${config.logPrefix}] step 4/4: assembling species.json`);
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
      taxonClass: config.taxonClass,
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
        sourceAttribution: config.sourceAttribution,
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
    buildId: dateStamp,
    taxonClass: config.taxonClass,
    speciesCount: species.length,
    sources: {
      gbifBackbone: { rows: gbif.length, taxonKeys: config.taxonKeys.length },
      wikidata: { rows: wikidata.length, endpoint: "https://query.wikidata.org/sparql" },
    },
    note: config.note,
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[${config.logPrefix}] done. ${species.length} species written to ${outDir}`);
}
