// Phase 8: fish — ray-finned (bony) fish plus jawless fish, cartilaginous fish, coelacanths,
// and lungfish (see fetch-fish-orders.ts for exactly which GBIF taxon keys that covers),
// the deliberately lighter taxon — FishBase is skipped entirely, shipping what
// GBIF + Wikidata already give for free. No trait source at all here — there's no
// AVONET/COMBINE-equivalent wired up for fish, so mass/length/depth stay null and rarity
// leans on IUCN status alone, same disclosed shortfall as mammals' missing range data.
// Common names come from GBIF's own vernacularNames endpoint, same mechanism as birds (no
// MDD-equivalent curated common-name file for fish).
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchGbifBackboneForKeys, type GbifSpeciesRow } from "../fetch/fetch-gbif-backbone.js";
import { fetchFishTaxonKeys } from "../fetch/fetch-fish-orders.js";
import { fetchCommonName } from "../fetch/fetch-gbif-vernacular.js";
import { fetchWikidataForSpecies } from "../fetch/fetch-wikidata.js";
import { fetchFishDepth } from "../fetch/fetch-fish-depth.js";
import { computeRarityPhase1 } from "./compute-rarity-phase1.js";
import { mapWithConcurrency } from "../concurrency.js";
import { BUILD_DIR } from "../raw-cache.js";

const GBIF_CONCURRENCY = 16;

function canonical(g: GbifSpeciesRow): string {
  return g.canonicalName ?? g.scientificName;
}

function dateStamp(): string {
  return process.env.LIFER_BUILD_ID ?? "fish-dev";
}

async function main() {
  const outDir = path.join(BUILD_DIR, dateStamp());
  mkdirSync(outDir, { recursive: true });

  console.log("[build-seed-fish] step 1/4: fish taxon keys (GBIF, dynamic — see fetch-fish-orders.ts)");
  const taxonKeys = await fetchFishTaxonKeys();

  console.log(`[build-seed-fish] step 2/4: GBIF backbone (${taxonKeys.length} fish taxon keys)`);
  const gbif = await fetchGbifBackboneForKeys(taxonKeys);

  console.log("[build-seed-fish] step 3/4: common names (GBIF vernacularNames)");
  let done = 0;
  const commonNames = await mapWithConcurrency(gbif, GBIF_CONCURRENCY, async (g) => {
    const name = await fetchCommonName(g.gbifKey);
    done++;
    if (done % 500 === 0) console.log(`[build-seed-fish]   ${done} / ${gbif.length}`);
    return name;
  });
  const commonNameByGbifKey = new Map(gbif.map((g, i) => [g.gbifKey, commonNames[i]]));

  console.log("[build-seed-fish] step 4/5: depth range (marine fishes depth dataset, 2023 — see fetch-fish-depth.ts)");
  // Marine-only (see fetch-fish-depth.ts) — freshwater/brackish species stay null here, a
  // real disclosed gap, not hidden by a fallback default.
  const depth = await fetchFishDepth();
  const depthByName = new Map(depth.map((r) => [r.scientificName, r]));

  console.log("[build-seed-fish] step 5/5: Wikidata (IUCN status, Commons image, Wikipedia sitelink) + rarity");
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

  const species = gbif.map((g) => {
    const name = canonical(g);
    const wiki = wikidataByName.get(name);
    const rarityRow = rarityByName.get(name);
    const depthRow = depthByName.get(name);

    return {
      gbifKey: g.gbifKey,
      ebirdCode: null,
      inatTaxonId: null,
      scientificName: name,
      commonName: commonNameByGbifKey.get(g.gbifKey) ?? null,
      // "actinopterygii" is used as the app-level grouping label for the whole "Fish" taxon
      // switcher category, even though this build also includes a few non-Actinopterygii
      // classes (hagfish, lampreys, sharks/rays, coelacanths, lungfish) — a deliberate UI/
      // schema simplification, not a claim about their actual clade.
      taxonClass: "actinopterygii",
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
        depthMinM: depthRow?.depthMinM ?? null,
        depthMaxM: depthRow?.depthMaxM ?? null,
        iucnStatus: wiki?.iucnStatus ?? null,
        rangeSizeKm2: null,
        primaryHabitat: null,
        habitatDensity: null,
        domestic: false,
        sourceAttribution:
          "GBIF Backbone Taxonomy; Wikidata; global marine fish depth-range dataset (2023, doi:10.6084/m9.figshare.20403111) for marine species",
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
    taxonClass: "actinopterygii",
    speciesCount: species.length,
    sources: {
      gbifBackbone: { rows: gbif.length, taxonKeys: taxonKeys.length },
      fishDepth: { rows: depth.length, doi: "10.6084/m9.figshare.20403111" },
      wikidata: { rows: wikidata.length, endpoint: "https://query.wikidata.org/sparql" },
    },
    note:
      "Ray-finned fish plus hagfish/lampreys/sharks-and-rays/coelacanths/lungfish (see fetch-fish-orders.ts for the exact GBIF taxon keys). " +
      "Depth range covers marine species only (freshwater/brackish species stay null). No mass/length trait source wired up — " +
      "rarity leans on IUCN status alone. Reference photos/descriptions are lazy, same as birds.",
  };
  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  console.log(`[build-seed-fish] done. ${species.length} species written to ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
