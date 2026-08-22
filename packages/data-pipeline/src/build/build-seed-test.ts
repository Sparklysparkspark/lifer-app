// Test-scoped version of build-seed.ts for a handful of common BC species, so the whole
// pipeline (GBIF, AVONET, EltonTraits, Wikidata, iNaturalist, region occurrence counts, rarity)
// can be exercised end-to-end in minutes instead of the ~3 hours a full 11,000-species run takes
// (mostly iNaturalist's polite 1 req/sec rate limit). Once photos can be attached via a UI,
// re-run the full build-seed.ts for the real dataset.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifSpeciesByNames } from "../fetch/fetch-gbif-backbone.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";
import { fetchAvonet } from "../fetch/fetch-avonet.js";
import { fetchEltonTraits } from "../fetch/fetch-elton-traits.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { fetchReferencePhotos } from "../fetch/fetch-reference-photos.js";
import { fetchCommonsPhoto } from "../fetch/fetch-commons-photo.js";
import { fetchWikipediaSummary } from "../fetch/fetch-wikipedia-summary.js";
import { fetchWikipediaMediaPhotos } from "../fetch/fetch-wikipedia-media.js";
import { fetchOccurrenceCountForSpecies } from "./build-region-species.js";
import { buildRegions } from "./build-regions.js";
import { computeRarityPhase1 } from "./compute-rarity-phase1.js";
import { BUILD_DIR } from "../raw-cache.js";

const MIN_OCCURRENCE_RECORDS = 3;

// Six common BC breeders/migrants requested as the first test batch.
const TEST_SPECIES = [
  "Anas platyrhynchos", // Mallard
  "Aix sponsa", // Wood Duck
  "Chordeiles minor", // Common Nighthawk
  "Poecile atricapillus", // Black-capped Chickadee
  "Passerculus sandwichensis", // Savannah Sparrow
  "Pandion haliaetus", // Osprey
];

function dateStamp(): string {
  return process.env.LIFER_BUILD_ID ?? "test";
}

async function main() {
  const outDir = path.join(BUILD_DIR, dateStamp());
  mkdirSync(outDir, { recursive: true });

  console.log(`[build-seed-test] resolving ${TEST_SPECIES.length} species via GBIF species/match`);
  const gbif = await fetchGbifSpeciesByNames(TEST_SPECIES);
  console.log(`[build-seed-test] resolved ${gbif.length}/${TEST_SPECIES.length}`);

  console.log("[build-seed-test] common names (GBIF vernacularNames)");
  const commonNameByGbifKey = new Map<number, string | null>();
  for (const g of gbif) {
    commonNameByGbifKey.set(g.gbifKey, await fetchCommonName(g.gbifKey));
  }

  console.log("[build-seed-test] AVONET traits (full dataset load, filtered in-memory)");
  const avonet = await fetchAvonet();
  const avonetByName = new Map(avonet.map((r) => [r.scientificName, r]));

  console.log("[build-seed-test] EltonTraits gap-fill (full dataset load, filtered in-memory)");
  const elton = await fetchEltonTraits();
  const eltonByName = new Map(elton.map((r) => [r.scientificName, r]));

  // AVONET/EltonTraits/Wikidata/iNaturalist all key on the plain binomial — GBIF's
  // scientificName carries the taxonomic authorship string ("... Linnaeus, 1758") which
  // would silently fail every join, so canonicalName is the one to use as the join key.
  const canonical = (g: { canonicalName: string | null; scientificName: string }) =>
    g.canonicalName ?? g.scientificName;

  console.log("[build-seed-test] Wikidata (IUCN status + image)");
  const names = gbif.map(canonical);
  const wikidata = await fetchWikidataForSpecies(names);
  const wikidataByName = new Map(wikidata.map((r) => [r.scientificName, r]));

  console.log("[build-seed-test] reference photos (iNaturalist)");
  const photos = await fetchReferencePhotos(names);
  const photosByName = new Map(photos.map((r) => [r.scientificName, r]));

  console.log("[build-seed-test] reference photo fallback (Wikimedia Commons, for species iNaturalist missed)");
  const commonsByName = new Map<string, Awaited<ReturnType<typeof fetchCommonsPhoto>>>();
  for (const g of gbif) {
    const key = canonical(g);
    const photo = photosByName.get(key);
    const wiki = wikidataByName.get(key);
    if (!photo?.photoUrl && wiki?.commonsImage) {
      commonsByName.set(key, await fetchCommonsPhoto(wiki.commonsImage));
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("[build-seed-test] short ID blurb (Wikipedia summary, one sentence)");
  const wikipediaByName = new Map<string, Awaited<ReturnType<typeof fetchWikipediaSummary>>>();
  for (const g of gbif) {
    const key = canonical(g);
    const wiki = wikidataByName.get(key);
    if (wiki?.wikipediaTitle) {
      wikipediaByName.set(key, await fetchWikipediaSummary(wiki.wikipediaTitle));
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  console.log("[build-seed-test] reference photo gallery (Wikipedia media list -> Commons)");
  const galleryByName = new Map<string, Awaited<ReturnType<typeof fetchWikipediaMediaPhotos>>>();
  for (const g of gbif) {
    const key = canonical(g);
    const wiki = wikidataByName.get(key);
    if (wiki?.wikipediaTitle) {
      galleryByName.set(key, await fetchWikipediaMediaPhotos(wiki.wikipediaTitle));
      // The per-species media-list call itself needs spacing too, not just the per-photo
      // Commons lookups inside it — hitting it back-to-back got 429'd in testing.
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.log("[build-seed-test] rarity (Phase-1 shortcut: range + IUCN)");
  const rarityInputs = gbif.map((g) => ({
    scientificName: canonical(g),
    rangeSizeKm2: avonetByName.get(canonical(g))?.rangeSizeKm2 ?? null,
    iucnStatus: wikidataByName.get(canonical(g))?.iucnStatus ?? null,
  }));
  const rarity = computeRarityPhase1(rarityInputs);
  const rarityByName = new Map(rarity.map((r) => [r.scientificName, r]));

  console.log("[build-seed-test] region occurrence counts (direct per-species query, no seasonality — test-scoped)");
  const regions = await buildRegions();
  const regionSpecies: Record<string, Array<{ gbifKey: number; recordCount: number; seasonality: number[] | null }>> = {};
  for (const region of regions) {
    if (region.externalCodes.length === 0) continue;
    for (const code of region.externalCodes) {
      const counts = [];
      for (const g of gbif) {
        const count = await fetchOccurrenceCountForSpecies(g.gbifKey, code);
        counts.push({ gbifKey: g.gbifKey, recordCount: count, seasonality: null });
      }
      regionSpecies[region.name] = counts.filter((c) => c.recordCount >= MIN_OCCURRENCE_RECORDS);
    }
  }

  const species = gbif.map((g) => {
    const trait = avonetByName.get(canonical(g));
    const eltonTrait = eltonByName.get(canonical(g));
    const wiki = wikidataByName.get(canonical(g));
    const photo = photosByName.get(canonical(g));
    const commonsPhoto = commonsByName.get(canonical(g));
    const wikipedia = wikipediaByName.get(canonical(g));
    const rarityRow = rarityByName.get(canonical(g));

    // iNaturalist first, Wikimedia Commons as the fallback when iNaturalist had nothing usable.
    const referencePhoto = photo?.photoUrl ?? commonsPhoto?.photoUrl ?? null;
    const referenceCredit = photo?.photoUrl ? photo.credit : commonsPhoto?.credit ?? null;
    const referenceLicense = photo?.photoUrl ? photo.license : commonsPhoto?.license ?? null;

    return {
      gbifKey: g.gbifKey,
      ebirdCode: null,
      inatTaxonId: photo?.inatTaxonId ?? null,
      scientificName: canonical(g),
      commonName: commonNameByGbifKey.get(g.gbifKey) ?? null,
      taxonClass: "aves",
      family: g.family,
      taxonOrder: g.order,
      referencePhoto,
      referenceCredit,
      referenceLicense,
      description: wikipedia?.description ?? null,
      descriptionCredit: wikipedia?.descriptionCredit ?? null,
      descriptionSourceUrl: wikipedia?.descriptionSourceUrl ?? null,
      wikipediaTitle: wiki?.wikipediaTitle ?? null,
      commonsImage: wiki?.commonsImage ?? null,
      referenceGallery: galleryByName.get(canonical(g)) ?? [],
      traits: {
        massG: trait?.massG ?? null,
        lengthMm: null,
        wingspanMm: trait?.wingLengthMm ?? null,
        handWingIndex: trait?.handWingIndex ?? null,
        trophicNiche: trait?.trophicNiche ?? eltonTrait?.dietMainCategory ?? null,
        primaryLifestyle: trait?.primaryLifestyle ?? null,
        nocturnal: eltonTrait?.nocturnal ?? null,
        densityPerKm2: null,
        populationEstimate: null,
        homeRangeKm2: null,
        depthMinM: null,
        depthMaxM: null,
        iucnStatus: wiki?.iucnStatus ?? null,
        rangeSizeKm2: trait?.rangeSizeKm2 ?? null,
        primaryHabitat: trait?.primaryHabitat ?? null,
        habitatDensity: trait?.habitatDensity ?? null,
        domestic: false,
        sourceAttribution: "AVONET (Tobias et al. 2022); EltonTraits 1.0 (Wilman et al. 2014); Wikidata",
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
  writeFileSync(path.join(outDir, "region-species.json"), JSON.stringify(regionSpecies, null, 2));
  writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({ buildId: dateStamp(), test: true, speciesCount: species.length }, null, 2),
  );

  console.log(`[build-seed-test] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
