// Phase 8: mammals, following build-seed.ts's shape with MDD in place of GBIF vernacular names
// (curated per-species common names) and COMBINE in place of AVONET as the trait source. Regions
// are shared across taxa and seeded by build-seed.ts; this only adds species, traits and rarity.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneForKeys, MAMMALIA_CLASS_KEY, type GbifSpeciesRow } from "../fetch/fetch-gbif-backbone.js";
import { fetchMdd } from "../fetch/fetch-mdd.js";
import { fetchCombine } from "../fetch/fetch-combine.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { computeRarityPhase1 } from "./compute-rarity-phase1.js";
import { BUILD_DIR } from "../raw-cache.js";

function canonical(g: GbifSpeciesRow): string {
  return g.canonicalName ?? g.scientificName;
}

// Marine mammals go in the app's "Fish" group, by MDD rank (see fetch-mdd.ts). Otters are left
// out: MDD has no rank separating sea otters from river otters.
function marineMammalTaxonClass(mddRow: { order: string | null; infraorder: string | null; superfamily: string | null } | undefined): string {
  if (!mddRow) return "mammalia";
  if (mddRow.infraorder === "Cetacea") return "actinopterygii"; // whales, dolphins, porpoises
  if (mddRow.order === "Sirenia") return "actinopterygii"; // manatees, dugongs
  if (mddRow.superfamily === "Phocoidea") return "actinopterygii"; // seals, sea lions, walruses
  return "mammalia";
}

function dateStamp(): string {
  return process.env.LIFER_BUILD_ID ?? "mammals-dev";
}

async function main() {
  const outDir = path.join(BUILD_DIR, dateStamp());
  mkdirSync(outDir, { recursive: true });

  console.log("[build-seed-mammals] step 1/5: GBIF backbone (Mammalia)");
  const gbif = await fetchGbifBackboneForKeys([MAMMALIA_CLASS_KEY]);

  console.log("[build-seed-mammals] step 2/5: MDD (taxonomy, common names)");
  const mdd = await fetchMdd();
  const mddByName = new Map(mdd.map((r) => [r.scientificName, r]));
  // Fallback join key where GBIF's backbone carries an older name than MDD's sciName (e.g. Bison
  // bison/Bos bison), covering every MDD row whose MSW3 name differs.
  const mddByMsw3Name = new Map(mdd.filter((r) => r.msw3Name).map((r) => [r.msw3Name!, r]));

  console.log("[build-seed-mammals] step 3/5: COMBINE (density, home range, nocturnality)");
  const combine = await fetchCombine();
  const combineByName = new Map(combine.map((r) => [r.scientificName, r]));

  console.log("[build-seed-mammals] step 4/5: Wikidata (IUCN status, Commons image, Wikipedia sitelink)");
  const names = gbif.map(canonical);
  const wikidata = await fetchWikidataForSpecies(names);
  const wikidataByName = new Map(wikidata.map((r) => [r.scientificName, r]));

  console.log("[build-seed-mammals] step 5/5: rarity (Phase-1 shortcut: range + IUCN)");
  // No range-polygon source for mammals yet, so rangeSizeKm2 is null and rarity leans on IUCN status.
  const rarityInputs = gbif.map((g) => ({
    scientificName: canonical(g),
    rangeSizeKm2: null,
    iucnStatus: wikidataByName.get(canonical(g))?.iucnStatus ?? null,
  }));
  const rarity = computeRarityPhase1(rarityInputs);
  const rarityByName = new Map(rarity.map((r) => [r.scientificName, r]));

  const species = gbif.map((g) => {
    const name = canonical(g);
    const mddRow = mddByName.get(name) ?? mddByMsw3Name.get(name);
    const combineRow = combineByName.get(name);
    const wiki = wikidataByName.get(name);
    const rarityRow = rarityByName.get(name);
    // MDD domestic flag (see fetch-mdd.ts). Their record counts measure how often people photograph
    // farm animals, so apply-rarity-phase4.ts forces them to "common" instead of ranking them.
    const domestic = mddRow?.domestic ?? false;

    return {
      gbifKey: g.gbifKey,
      ebirdCode: null,
      inatTaxonId: null,
      scientificName: name,
      commonName: mddRow?.commonName ?? null,
      taxonClass: marineMammalTaxonClass(mddRow),
      family: mddRow?.family ?? g.family,
      taxonOrder: mddRow?.order ?? g.order,
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
        massG: combineRow?.massG ?? null,
        lengthMm: null,
        wingspanMm: null,
        handWingIndex: null,
        trophicNiche: null,
        primaryLifestyle: null,
        nocturnal: combineRow?.nocturnal ?? null,
        densityPerKm2: combineRow?.densityPerKm2 ?? null,
        populationEstimate: null,
        homeRangeKm2: combineRow?.homeRangeKm2 ?? null,
        depthMinM: null,
        depthMaxM: null,
        iucnStatus: wiki?.iucnStatus ?? null,
        rangeSizeKm2: null,
        primaryHabitat: null,
        habitatDensity: null,
        domestic,
        sourceAttribution: "Mammal Diversity Database v2.0 (MDD); COMBINE (Soria et al. 2021); Wikidata",
      },
      rarity: domestic
        ? { rangeScore: 0, abundanceScore: 0, elusivenessScore: null, composite: 0, tier: "common" as const }
        : rarityRow
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
  // No region hierarchy or region_species here: shared across taxa, already loaded.
  writeFileSync(path.join(outDir, "regions.json"), JSON.stringify([], null, 2));
  writeFileSync(path.join(outDir, "region-species.json"), JSON.stringify({}, null, 2));

  const manifest = {
    buildId: dateStamp(),
    taxonClass: "mammalia",
    speciesCount: species.length,
    sources: {
      gbifBackbone: { rows: gbif.length, api: "https://api.gbif.org/v1/species/search" },
      mdd: { rows: mdd.length, doi: "10.5281/zenodo.17033774", license: "CC-BY-4.0" },
      combine: { rows: combine.length, doi: "10.6084/m9.figshare.13028255.v4", license: "CC-BY-4.0" },
      wikidata: { rows: wikidata.length, endpoint: "https://query.wikidata.org/sparql" },
    },
    note: "No range-polygon source yet (rangeSizeKm2 null): rarity leans on IUCN status alone until one is added. Reference photos/descriptions are lazy, same as birds.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed-mammals] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
