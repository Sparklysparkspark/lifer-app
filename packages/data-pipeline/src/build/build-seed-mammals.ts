// Phase 8: mammals, following build-seed.ts's exact shape (GBIF backbone + a rich
// taxonomy/common-name source + Wikidata + rarity), just with MDD in place of GBIF's own
// vernacular names (MDD's mainCommonName is curated per-species, no separate per-species
// lookup needed) and COMBINE in place of AVONET as the primary trait source. No region
// hierarchy step here — regions are shared across all taxa and already seeded by
// build-seed.ts; this only adds species + traits + rarity.
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

// Obligate/predominantly marine mammals go in the app's "Fish" taxon grouping instead of
// "Mammals" — determined from real MDD ranks, not a guess (see fetch-mdd.ts).
// Otters are deliberately excluded: MDD has no rank that separates sea otters from
// river/land otters (all sit under subfamily Lutrinae with no finer split available), so
// that line isn't drawn here rather than guessed at the species level.
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
  // Fallback join key for species where GBIF's backbone still carries an older name than
  // MDD's own current sciName (e.g. Bison bison/Bos bison). Not a one-off special case — this
  // covers every MDD row whose MSW3 name differs from its primary name.
  const mddByMsw3Name = new Map(mdd.filter((r) => r.msw3Name).map((r) => [r.msw3Name!, r]));

  console.log("[build-seed-mammals] step 3/5: COMBINE (density, home range, nocturnality)");
  const combine = await fetchCombine();
  const combineByName = new Map(combine.map((r) => [r.scientificName, r]));

  console.log("[build-seed-mammals] step 4/5: Wikidata (IUCN status, Commons image, Wikipedia sitelink)");
  const names = gbif.map(canonical);
  const wikidata = await fetchWikidataForSpecies(names);
  const wikidataByName = new Map(wikidata.map((r) => [r.scientificName, r]));

  console.log("[build-seed-mammals] step 5/5: rarity (Phase-1 shortcut: range + IUCN)");
  // No AVONET-equivalent range-polygon source wired up for mammals yet (disclosed gap, same
  // footing as fish's missing trait data) — rangeSizeKm2 is null, so rarity here leans on
  // IUCN status alone until a range source is added.
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
    // MDD flag (cattle, goats, sheep, etc. — see fetch-mdd.ts). Domestic species are kept in
    // the app, but their GBIF record counts don't measure rarity at all — they measure how
    // often people photograph farm animals for citizen science — so the rarity/elusiveness
    // pipeline forces them to a fixed "common" tier downstream (apply-rarity-phase4.ts)
    // rather than ranking them against wild species on a signal that doesn't apply to them.
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
  // No region hierarchy or region_species here — shared across taxa, already loaded.
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
    note: "No range-polygon source yet (rangeSizeKm2 null) — rarity leans on IUCN status alone until one is added. Reference photos/descriptions are lazy, same as birds.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed-mammals] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
