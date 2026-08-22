// Orchestrates the FAST CORE of the Phase-1 ETL (lifer-spec.md §5, §6) and writes versioned
// seed files to data/build/<date>/ plus a manifest, so the dataset is reproducible per spec.
//
// Deliberately excludes per-species enrichment (iNaturalist photo, Commons fallback,
// Wikipedia blurb, Wikipedia gallery) and per-region occurrence/seasonality computation —
// those are all live external-API calls that would take hours across ~11,000 species /
// hundreds of regions, for data that may never be looked at. Both now happen lazily instead,
// on first view, cached after (apps/api/src/species/lazyEnrich.ts and
// apps/api/src/regions/routes.ts). This script only does what's fast and
// local: GBIF backbone + common names, AVONET/EltonTraits traits, Wikidata (IUCN status +
// image + Wikipedia sitelink — captured here for the lazy path to use later, not acted on
// eagerly), rarity, and the region hierarchy (also local/fast — see build-regions.ts).

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneAves, type GbifSpeciesRow } from "../fetch/fetch-gbif-backbone.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";
import { fetchAvonet } from "../fetch/fetch-avonet.js";
import { fetchEltonTraits } from "../fetch/fetch-elton-traits.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { fetchBirdAbundance } from "../fetch/fetch-bird-abundance.js";
import { buildRegions } from "./build-regions.js";
import { computeRarityPhase1 } from "./compute-rarity-phase1.js";
import { BUILD_DIR } from "../raw-cache.js";
import { mapWithConcurrency } from "../concurrency.js";

// GBIF has no documented hard rate limit for anonymous traffic, but politeness matters more
// than raw speed here — 16 concurrent requests cuts step 2 from ~sequential (30-90+ minutes
// for ~14,600 species, one request each) to a few minutes, without hammering the API.
const GBIF_CONCURRENCY = 16;

// AVONET/EltonTraits/Wikidata all key on the plain binomial — GBIF's scientificName carries
// the taxonomic authorship string ("... Linnaeus, 1758") which would silently fail every
// join, so canonicalName is the one to use as the join key.
function canonical(g: GbifSpeciesRow): string {
  return g.canonicalName ?? g.scientificName;
}

function dateStamp(): string {
  // Date.now()/new Date() with no args are unavailable in some sandboxes; process.env
  // gives us a stable build id without relying on wall-clock time.
  return process.env.LIFER_BUILD_ID ?? "dev";
}

async function main() {
  const outDir = path.join(BUILD_DIR, dateStamp());
  mkdirSync(outDir, { recursive: true });

  console.log("[build-seed] step 1/6: GBIF backbone (Aves)");
  const gbif = await fetchGbifBackboneAves();

  console.log(`[build-seed] step 2/6: common names (GBIF vernacularNames), ${GBIF_CONCURRENCY} concurrent`);
  let commonNamesDone = 0;
  const commonNames = await mapWithConcurrency(gbif, GBIF_CONCURRENCY, async (g) => {
    const name = await fetchCommonName(g.gbifKey);
    commonNamesDone++;
    if (commonNamesDone % 500 === 0) console.log(`[build-seed]   ${commonNamesDone} / ${gbif.length}`);
    return name;
  });
  const commonNameByGbifKey = new Map(gbif.map((g, i) => [g.gbifKey, commonNames[i]]));

  console.log("[build-seed] step 3/6: AVONET traits");
  const avonet = await fetchAvonet();
  const avonetByName = new Map(avonet.map((r) => [r.scientificName, r]));

  console.log("[build-seed] step 4/6: EltonTraits gap-fill");
  const elton = await fetchEltonTraits();
  const eltonByName = new Map(elton.map((r) => [r.scientificName, r]));

  console.log("[build-seed] step 5/7: Wikidata (IUCN status, Commons image, Wikipedia sitelink)");
  const names = gbif.map(canonical);
  const wikidata = await fetchWikidataForSpecies(names);
  const wikidataByName = new Map(wikidata.map((r) => [r.scientificName, r]));

  console.log("[build-seed] step 6/7: population estimates (Callaghan et al. 2021)");
  const abundance = await fetchBirdAbundance();
  const abundanceByName = new Map(abundance.map((r) => [r.scientificName, r]));

  console.log("[build-seed] step 7/7: rarity (Phase-1 shortcut: range + IUCN) + region hierarchy");
  const rarityInputs = gbif.map((g) => ({
    scientificName: canonical(g),
    rangeSizeKm2: avonetByName.get(canonical(g))?.rangeSizeKm2 ?? null,
    iucnStatus: wikidataByName.get(canonical(g))?.iucnStatus ?? null,
  }));
  const rarity = computeRarityPhase1(rarityInputs);
  const rarityByName = new Map(rarity.map((r) => [r.scientificName, r]));

  const regions = await buildRegions();

  const species = gbif.map((g) => {
    const trait = avonetByName.get(canonical(g));
    const eltonTrait = eltonByName.get(canonical(g));
    const wiki = wikidataByName.get(canonical(g));
    const rarityRow = rarityByName.get(canonical(g));

    return {
      gbifKey: g.gbifKey,
      // eBird taxonomy CSV is unresolved licensing-wise (see agent research on §5 checklist) —
      // left null until Phase 0's license verification clears it.
      ebirdCode: null,
      // Reference photo, description, and gallery are all fetched lazily by the API on
      // first species view now (see apps/api/src/species/lazyEnrich.ts) — null here isn't
      // missing data, it's simply not fetched yet.
      inatTaxonId: null,
      scientificName: canonical(g),
      commonName: commonNameByGbifKey.get(g.gbifKey) ?? null,
      taxonClass: "aves",
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
        massG: trait?.massG ?? null,
        lengthMm: null,
        wingspanMm: trait?.wingLengthMm ?? null,
        handWingIndex: trait?.handWingIndex ?? null,
        trophicNiche: trait?.trophicNiche ?? eltonTrait?.dietMainCategory ?? null,
        primaryLifestyle: trait?.primaryLifestyle ?? null,
        nocturnal: eltonTrait?.nocturnal ?? null,
        // Real population ÷ real range = a genuine density signal. A species like the
        // Pileated Woodpecker can have a wide range but genuinely low density, which neither
        // range alone nor raw GBIF record volume can distinguish from an abundant species.
        densityPerKm2:
          trait?.rangeSizeKm2 && trait.rangeSizeKm2 > 0 && abundanceByName.get(canonical(g))?.populationEstimate
            ? abundanceByName.get(canonical(g))!.populationEstimate / trait.rangeSizeKm2
            : null,
        homeRangeKm2: null,
        depthMinM: null,
        depthMaxM: null,
        populationEstimate: abundanceByName.get(canonical(g))?.populationEstimate ?? null,
        iucnStatus: wiki?.iucnStatus ?? null,
        rangeSizeKm2: trait?.rangeSizeKm2 ?? null,
        primaryHabitat: trait?.primaryHabitat ?? null,
        habitatDensity: trait?.habitatDensity ?? null,
        domestic: false,
        sourceAttribution:
          "AVONET (Tobias et al. 2022); EltonTraits 1.0 (Wilman et al. 2014); Wikidata; Callaghan et al. 2021 (PNAS)",
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
  writeFileSync(path.join(outDir, "regions.json"), JSON.stringify(regions, null, 2));
  // region_species (occurrence counts + seasonality) is computed lazily per-region now, on
  // first view of that region's species list — nothing to write here at seed time.
  writeFileSync(path.join(outDir, "region-species.json"), JSON.stringify({}, null, 2));

  const manifest = {
    buildId: dateStamp(),
    sources: {
      gbifBackbone: { rows: gbif.length, api: "https://api.gbif.org/v1/species/search" },
      avonet: { rows: avonet.length, doi: "10.1111/ele.13898" },
      eltonTraits: { rows: elton.length, figshareCollection: "10.6084/m9.figshare.c.3306933.v1" },
      wikidata: { rows: wikidata.length, endpoint: "https://query.wikidata.org/sparql" },
      birdAbundance: { rows: abundance.length, doi: "10.1073/pnas.2023170118", zenodo: "10.5281/zenodo.4723365" },
    },
    speciesCount: species.length,
    regionsCount: regions.length,
    note: "Reference photos, descriptions, galleries, and region occurrence/seasonality are all lazy now — see apps/api's lazyEnrich.ts and regions/routes.ts, not this manifest.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
