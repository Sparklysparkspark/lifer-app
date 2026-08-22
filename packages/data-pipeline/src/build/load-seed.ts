// Loads the JSON produced by build-seed.ts into Postgres, following the schema in schema.sql.
// Run: LIFER_BUILD_ID=<dir-name-under-data/build> npm run load-seed -w data-pipeline

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { BUILD_DIR } from "../raw-cache.js";

export interface SeedRarityInput {
  rangeScore: number;
  abundanceScore: number;
  elusivenessScore: number | null;
  composite: number;
  tier: string;
}

// Extracted so it's independently testable (see load-seed.integration.test.ts) without
// needing to run the whole file-reading seed-load pipeline.
export async function upsertSpeciesRarity(client: PoolClient, speciesId: string, rarity: SeedRarityInput): Promise<void> {
  // This seed NEVER computes elusiveness (that only comes from compute-elusiveness.ts's
  // separate 258-country crawl, run and applied afterward via apply-rarity-phase4.ts) — its
  // own composite/tier are Phase-1-only (range+IUCN). A plain ON CONFLICT overwrite would
  // blindly replace an already elusiveness-refined row with this weaker placeholder every
  // time the seed reran (this previously happened when reloading the mammal seed for the
  // fossil purge/Bison-bison fix, wiping elusiveness_score back to null for all 7888 mammal
  // species). Only take the seed's rarity numbers when it actually carries elusiveness
  // data (a future seed source might); otherwise keep whatever's already there — untouched
  // for an existing row, the Phase-1 placeholder for a genuinely new species.
  await client.query(
    `INSERT INTO species_rarity (species_id, range_score, abundance_score, elusiveness_score, composite, tier)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (species_id) DO UPDATE SET
       range_score = EXCLUDED.range_score, abundance_score = EXCLUDED.abundance_score,
       elusiveness_score = COALESCE(EXCLUDED.elusiveness_score, species_rarity.elusiveness_score),
       composite = CASE WHEN EXCLUDED.elusiveness_score IS NOT NULL THEN EXCLUDED.composite ELSE species_rarity.composite END,
       tier = CASE WHEN EXCLUDED.elusiveness_score IS NOT NULL THEN EXCLUDED.tier ELSE species_rarity.tier END,
       computed_at = now()`,
    [speciesId, rarity.rangeScore, rarity.abundanceScore, rarity.elusivenessScore, rarity.composite, rarity.tier],
  );
}

interface SeedSpecies {
  gbifKey: number;
  ebirdCode: string | null;
  inatTaxonId: number | null;
  scientificName: string;
  commonName: string | null;
  taxonClass: string;
  family: string | null;
  taxonOrder: string | null;
  referencePhoto: string | null;
  referenceCredit: string | null;
  referenceLicense: string | null;
  description: string | null;
  descriptionCredit: string | null;
  descriptionSourceUrl: string | null;
  wikipediaTitle: string | null;
  commonsImage: string | null;
  referenceGallery: Array<{ photoUrl: string; credit: string; license: string; sortOrder: number }>;
  traits: {
    massG: number | null;
    lengthMm: number | null;
    wingspanMm: number | null;
    handWingIndex: number | null;
    trophicNiche: string | null;
    primaryLifestyle: string | null;
    nocturnal: boolean | null;
    // Mammals' COMBINE-sourced axes (spec §7: "COMBINE's density, home
    // range, and nocturnality"); birds compute densityPerKm2 themselves (population estimate
    // ÷ range size — see build-seed.ts and fetch-bird-abundance.ts), fish have neither yet.
    densityPerKm2: number | null;
    homeRangeKm2: number | null;
    depthMinM: number | null;
    depthMaxM: number | null;
    // Per-species population estimate (Callaghan et al. 2021) — birds only for now.
    populationEstimate: number | null;
    iucnStatus: string | null;
    rangeSizeKm2: number | null;
    // AVONET fields (birds only). Habitat density (1=dense/closed canopy, 3=open) is the
    // signal for "detectability due to habitat cover," distinct from raw record volume.
    primaryHabitat: string | null;
    habitatDensity: number | null;
    // MDD flag (mammals only) — see build-seed-mammals.ts/fetch-mdd.ts. Rarity for
    // these is forced to "common" upstream rather than computed, since GBIF record volume
    // for a farm animal measures photography habits, not real-world rarity.
    domestic: boolean;
    sourceAttribution: string;
  };
  rarity: {
    rangeScore: number;
    abundanceScore: number;
    elusivenessScore: number | null;
    composite: number;
    tier: string;
  } | null;
}

interface SeedRegion {
  name: string;
  parentName: string | null;
  externalCodes: string[];
  ebirdRegionCode: string | null;
  boundaryGeoJson: unknown | null;
}

function resolveBuildDir(): string {
  const explicit = process.env.LIFER_BUILD_ID;
  if (explicit) return path.join(BUILD_DIR, explicit);
  const dirs = readdirSync(BUILD_DIR);
  if (dirs.length === 0) throw new Error(`No build directories found in ${BUILD_DIR}. Run build-seed first.`);
  // Alphabetical sort previously picked this ("test" sorts after "dev"), silently loading a
  // stale 6-species test build over a real 14,641-species rebuild — pick by actual
  // modification time instead, so directory naming can never matter.
  const newest = dirs
    .map((name) => ({ name, mtimeMs: statSync(path.join(BUILD_DIR, name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
  return path.join(BUILD_DIR, newest.name);
}

async function main() {
  const dir = resolveBuildDir();
  console.log(`[load-seed] loading from ${dir}`);

  const species: SeedSpecies[] = JSON.parse(readFileSync(path.join(dir, "species.json"), "utf-8"));
  const regions: SeedRegion[] = JSON.parse(readFileSync(path.join(dir, "regions.json"), "utf-8"));
  const regionSpecies: Record<string, Array<{ gbifKey: number; recordCount: number; seasonality: number[] | null }>> =
    JSON.parse(readFileSync(path.join(dir, "region-species.json"), "utf-8"));

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const speciesIdByGbifKey = new Map<number, string>();
    for (const s of species) {
      const res = await client.query(
        `INSERT INTO species
           (gbif_key, ebird_code, inat_taxon_id, scientific_name, common_name, taxon_class, family, taxon_order, reference_photo, reference_credit, reference_license, description, description_credit, description_source_url, wikipedia_title, commons_image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (gbif_key) DO UPDATE SET
           common_name = EXCLUDED.common_name,
           -- taxon_class/family/taxon_order come from the source taxonomy file (MDD, GBIF,
           -- etc.) and should always sync on rerun — e.g. reclassifying marine mammals into
           -- the app's "Fish" grouping needs this to actually take effect on a
           -- species already loaded by an earlier run, not just newly-inserted ones.
           taxon_class = EXCLUDED.taxon_class,
           family = EXCLUDED.family,
           taxon_order = EXCLUDED.taxon_order,
           wikipedia_title = EXCLUDED.wikipedia_title,
           commons_image = EXCLUDED.commons_image,
           -- The fast/lazy pipeline (see build-seed.ts) never carries real enrichment data —
           -- COALESCE so re-running it doesn't wipe out enrichment the API already fetched
           -- lazily for a species (reference_photo etc. would otherwise reset to null here).
           reference_photo = COALESCE(EXCLUDED.reference_photo, species.reference_photo),
           reference_credit = COALESCE(EXCLUDED.reference_credit, species.reference_credit),
           reference_license = COALESCE(EXCLUDED.reference_license, species.reference_license),
           description = COALESCE(EXCLUDED.description, species.description),
           description_credit = COALESCE(EXCLUDED.description_credit, species.description_credit),
           description_source_url = COALESCE(EXCLUDED.description_source_url, species.description_source_url)
         RETURNING id`,
        [
          s.gbifKey,
          s.ebirdCode,
          s.inatTaxonId,
          s.scientificName,
          s.commonName,
          s.taxonClass,
          s.family,
          s.taxonOrder,
          s.referencePhoto,
          s.referenceCredit,
          s.referenceLicense,
          s.description,
          s.descriptionCredit,
          s.descriptionSourceUrl,
          s.wikipediaTitle,
          s.commonsImage,
        ],
      );
      const id = res.rows[0].id as string;
      speciesIdByGbifKey.set(s.gbifKey, id);

      await client.query(
        `INSERT INTO species_traits
           (species_id, mass_g, length_mm, wingspan_mm, hand_wing_index, trophic_niche, primary_lifestyle, nocturnal,
            density_per_km2, home_range_km2, depth_min_m, depth_max_m, population_estimate, iucn_status, range_size_km2,
            primary_habitat, habitat_density, domestic, source_attribution)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         ON CONFLICT (species_id) DO UPDATE SET
           mass_g = EXCLUDED.mass_g, length_mm = EXCLUDED.length_mm, wingspan_mm = EXCLUDED.wingspan_mm,
           hand_wing_index = EXCLUDED.hand_wing_index, trophic_niche = EXCLUDED.trophic_niche,
           primary_lifestyle = EXCLUDED.primary_lifestyle, nocturnal = EXCLUDED.nocturnal,
           density_per_km2 = EXCLUDED.density_per_km2, home_range_km2 = EXCLUDED.home_range_km2,
           depth_min_m = EXCLUDED.depth_min_m, depth_max_m = EXCLUDED.depth_max_m,
           population_estimate = EXCLUDED.population_estimate,
           iucn_status = EXCLUDED.iucn_status, range_size_km2 = EXCLUDED.range_size_km2,
           primary_habitat = EXCLUDED.primary_habitat, habitat_density = EXCLUDED.habitat_density,
           domestic = EXCLUDED.domestic,
           source_attribution = EXCLUDED.source_attribution`,
        [
          id,
          s.traits.massG,
          s.traits.lengthMm,
          s.traits.wingspanMm,
          s.traits.handWingIndex,
          s.traits.trophicNiche,
          s.traits.primaryLifestyle,
          s.traits.nocturnal,
          s.traits.densityPerKm2,
          s.traits.homeRangeKm2,
          s.traits.depthMinM,
          s.traits.depthMaxM,
          s.traits.populationEstimate,
          s.traits.iucnStatus,
          s.traits.rangeSizeKm2,
          s.traits.primaryHabitat,
          s.traits.habitatDensity,
          s.traits.domestic,
          s.traits.sourceAttribution,
        ],
      );

      if (s.rarity) {
        await upsertSpeciesRarity(client, id, s.rarity);
      }

      // Same reasoning as the COALESCE above: the fast pipeline (see build-seed.ts) always
      // sends an empty gallery, so only touch this table when there's something real
      // to write — otherwise a re-run would wipe out galleries the API fetched lazily.
      if (s.referenceGallery.length > 0) {
        await client.query(`DELETE FROM species_reference_photos WHERE species_id = $1`, [id]);
      }
      for (const photo of s.referenceGallery) {
        await client.query(
          `INSERT INTO species_reference_photos (species_id, photo_url, credit, license, sort_order)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (species_id, photo_url) DO NOTHING`,
          [id, photo.photoUrl, photo.credit, photo.license, photo.sortOrder],
        );
      }
    }
    console.log(`[load-seed] upserted ${species.length} species`);

    const regionIdByName = new Map<string, string>();
    for (const r of regions) {
      const parentId = r.parentName ? regionIdByName.get(r.parentName) ?? null : null;
      const res = await client.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (name) DO UPDATE SET
           parent_id = EXCLUDED.parent_id,
           external_codes = EXCLUDED.external_codes,
           ebird_region_code = EXCLUDED.ebird_region_code,
           boundary_geojson = EXCLUDED.boundary_geojson
         RETURNING id`,
        [r.name, parentId, r.externalCodes, r.ebirdRegionCode, r.boundaryGeoJson ? JSON.stringify(r.boundaryGeoJson) : null],
      );
      regionIdByName.set(r.name, res.rows[0].id as string);
    }
    console.log(`[load-seed] inserted ${regions.length} regions`);

    let regionSpeciesCount = 0;
    for (const [regionName, counts] of Object.entries(regionSpecies)) {
      const regionId = regionIdByName.get(regionName);
      if (!regionId) continue;
      for (const c of counts) {
        const speciesId = speciesIdByGbifKey.get(c.gbifKey);
        if (!speciesId) continue;
        await client.query(
          `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (region_id, species_id) DO UPDATE SET
             local_frequency = EXCLUDED.local_frequency, seasonality = EXCLUDED.seasonality`,
          [regionId, speciesId, c.recordCount, c.seasonality],
        );
        regionSpeciesCount++;
      }
    }
    console.log(`[load-seed] inserted ${regionSpeciesCount} region_species rows`);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
