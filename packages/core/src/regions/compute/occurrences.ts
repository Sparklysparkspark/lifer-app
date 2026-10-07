// Builds a region's checklist from GBIF (plus iNaturalist for membership). Used only by the
// pack-building scripts; the app itself reads checklists from downloaded packs.
import { pool, withTransaction } from "../../db.js";
import {
  fetchSpeciesCountsForRegion,
  fetchMonthlySeasonality,
  fetchYearCountsForSpecies,
  fetchYearlyRecordCounts,
  passesRecurrenceCheck,
  fetchRecordSampleForSpecies,
  looksCaptiveOnly,
  looksTypeSpecimenOnly,
  looksLikeGeographicOutlier,
  fetchGlobalOccurrenceCount,
  GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN,
  medianOf,
  type RegionSpeciesCount,
} from "../buildRegionSpecies.js";
import { fetchAllCountries } from "../regionBoundary.js";
import { AVES_CLASS_KEY, MAMMALIA_CLASS_KEY } from "../../gbif/backbone.js";
import { fetchFishTaxonKeys } from "../../gbif/fishOrders.js";
import { matchedSpeciesIdsForRegion, resolveRemovalRescues } from "../inatChecklist.js";
import { NO_RARITY_TIER_TAXON_CLASSES, type TaxonClass } from "@lifer/shared";
import { exteriorRingsFromGeometry, type BoundingBox } from "../../lib/geometry.js";
import {
  tierForScore,
  BIRD_ABSOLUTE_TIER_THRESHOLDS,
  MAMMAL_ABSOLUTE_TIER_THRESHOLDS,
  FISH_ABSOLUTE_TIER_THRESHOLDS,
  percentileRankScores,
  boostElusivenessForNocturnal,
  boostElusivenessForDensity,
  boostElusivenessForHabitatDensity,
  boostTowardHarderToDetect,
} from "../../species/computeRarityPhase1.js";
import { MARINE_MAMMAL_ORDER_KEYS, ensureSeaZoneComputed } from "./seaZones.js";
import { nearbyZones } from "../nearbyZones.js";
import { log } from "../../lib/log.js";

// Fish have looser thresholds than birds and mammals, so the two are fetched separately.
const BIRD_MAMMAL_TAXON_KEYS = [AVES_CLASS_KEY, MAMMALIA_CLASS_KEY];

interface RegionAncestryRow {
  external_codes: string[] | null;
  sovereignty_group: string | null;
  parent_id: string | null;
}

// Walks up to the country (the level with sovereignty_group set) and returns its ISO3, for the
// country-keyed species_nonnative_countries lookup.
async function resolveCountryIso3(regionId: string, depth = 0): Promise<string | null> {
  if (depth >= 5) return null;
  const ancestorRes = await pool.query<RegionAncestryRow>(
    `SELECT external_codes, sovereignty_group, parent_id FROM regions WHERE id = $1`,
    [regionId],
  );
  const ancestorRow = ancestorRes.rows[0];
  if (!ancestorRow) return null;
  if (ancestorRow.sovereignty_group != null) {
    const iso2 = ancestorRow.external_codes?.[0] ?? null;
    if (!iso2) return null;
    return (await fetchAllCountries()).find((c) => c.iso2 === iso2)?.iso3 ?? null;
  }
  if (!ancestorRow.parent_id) return null;
  return resolveCountryIso3(ancestorRow.parent_id, depth + 1);
}

// Species flagged as introduced in this country (compute-elusiveness.ts).
async function loadNonNativeGbifKeys(iso3: string): Promise<Set<number>> {
  const res = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species_nonnative_countries snc JOIN species s ON s.id = snc.species_id WHERE snc.country_iso3 = $1`,
    [iso3],
  );
  return new Set(res.rows.map((r) => Number(r.gbif_key)));
}

export async function computeRegionOccurrences(region: {
  id: string;
  name?: string;
  boundary_geojson: { bbox?: [number, number, number, number]; geometry?: { type: string; coordinates: unknown } } | null;
  external_codes: string[] | null;
}): Promise<void> {
  const regionId = region.id;
  const code = region.external_codes![0];
  const fishKeys = await fetchFishTaxonKeys();
  // Fish match on GBIF's `country` field (landOnly=false), since many freshwater records have
  // no coordinates. The sea-zone pass below removes reef fish that field lets in.
  const [birdMammalCountsRaw, fishCountsRaw, marineMammalCounts] = await Promise.all([
    fetchSpeciesCountsForRegion(code, BIRD_MAMMAL_TAXON_KEYS),
    fetchSpeciesCountsForRegion(code, fishKeys, FISH_YEARS_WINDOW, false),
    // All-time: only used to identify marine mammals, so the rescue pass below can't bring one back.
    fetchSpeciesCountsForRegion(code, MARINE_MAMMAL_ORDER_KEYS, null),
  ]);
  // Marine mammals come off the land checklist (see MARINE_MAMMAL_ORDER_KEYS).
  const marineMammalGbifKeys = new Set(marineMammalCounts.map((c) => c.gbifKey));
  const birdMammalCounts = birdMammalCountsRaw.filter((c) => !marineMammalGbifKeys.has(c.gbifKey));
  // Fish with only a few local records (or high-tier with no photo) get their records sampled:
  // a lone type specimen or a misidentification can otherwise add a species never found here.
  const fishCandidateGbifKeys = fishCountsRaw.map((c) => c.gbifKey);
  const fishScrutinyRes = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species s LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE s.gbif_key = ANY($1) AND s.reference_photo IS NULL AND r.tier IN ('rare', 'legendary', 'unrated')`,
    [fishCandidateGbifKeys],
  );
  const fishHighTierNoPhotoGbifKeys = new Set(fishScrutinyRes.rows.map((r) => Number(r.gbif_key)));
  const fishCounts: RegionSpeciesCount[] = [];
  for (const c of fishCountsRaw) {
    const needsScrutiny = c.recordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS || fishHighTierNoPhotoGbifKeys.has(c.gbifKey);
    if (!needsScrutiny) {
      fishCounts.push(c);
      continue;
    }
    const sample = await fetchRecordSampleForSpecies(code, c.gbifKey, false);
    if (looksTypeSpecimenOnly(sample)) continue;
    if (c.recordCount > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS) {
      fishCounts.push(c);
      continue;
    }
    const globalCount = await fetchGlobalOccurrenceCount(c.gbifKey);
    if (!looksLikeGeographicOutlier(c.recordCount, globalCount)) fishCounts.push(c);
  }
  const [birdMammalSeasonality, fishSeasonality] = await Promise.all([
    fetchMonthlySeasonality(code, BIRD_MAMMAL_TAXON_KEYS),
    fetchMonthlySeasonality(code, fishKeys, FISH_YEARS_WINDOW, false),
  ]);
  const seasonality = new Map([...birdMammalSeasonality, ...fishSeasonality]);

  // A fish leaves the default list only if a nearby sea zone's checklist has it too (a habitat
  // guess breaks on salt lakes). That removes reef fish the `country` match let in.
  const bbox = region.boundary_geojson?.bbox as [number, number, number, number] | undefined;
  const geometry = region.boundary_geojson?.geometry;
  const marineGbifKeys = new Set<number>();
  if (bbox && geometry && fishCounts.length > 0) {
    const regionBbox: BoundingBox = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
    // The precomputed links (data-pipeline's build-sea-zones.ts) when the region has them: the live
    // check against 80-point outlines misses coasts along the large IHO seas.
    const stored = await pool.query<{ nearby_sea_zone_ids: string[] | null }>(`SELECT nearby_sea_zone_ids FROM regions WHERE id = $1`, [regionId]);
    const storedIds = stored.rows[0]?.nearby_sea_zone_ids;
    const zones = storedIds
      ? (await pool.query<{ id: string; name: string; wkt: string }>(`SELECT id, name, wkt FROM sea_zones WHERE id = ANY($1)`, [storedIds])).rows
      : await nearbyZones(regionBbox, exteriorRingsFromGeometry(geometry));
    for (const zone of zones) {
      const zoneRow = await pool.query<{ occurrence_computed_at: Date | null }>(
        `SELECT occurrence_computed_at FROM sea_zones WHERE id = $1`,
        [zone.id],
      );
      try {
        await ensureSeaZoneComputed(zone.id, zone.wkt, !!zoneRow.rows[0]?.occurrence_computed_at);
      } catch (err) {
        // Best effort: a failing zone just skips its contribution.
        log.error({ err }, `[computeRegionOccurrences] sea zone ${zone.name} failed, skipping`);
      }
    }
    if (zones.length > 0) {
      const marineRes = await pool.query<{ gbif_key: string }>(
        `SELECT DISTINCT s.gbif_key FROM sea_zone_species zs
         JOIN species s ON s.id = zs.species_id
         WHERE zs.sea_zone_id = ANY($1)`,
        [zones.map((z) => z.id)],
      );
      for (const row of marineRes.rows) marineGbifKeys.add(Number(row.gbif_key));
    }
  }

  // Being in a sea zone only counts against a fish with few land records: widely farmed species
  // (tilapia) are in sea zones worldwide yet genuinely native inland.
  const MARINE_EXCLUSION_MAX_NOISE_RECORDS = 10;
  const filtered: RegionSpeciesCount[] = [
    ...birdMammalCounts.filter((c) => c.recordCount >= MIN_RECORDS),
    ...fishCounts.filter(
      (c) =>
        c.recordCount >= FISH_MIN_RECORDS &&
        !(marineGbifKeys.has(c.gbifKey) && c.recordCount <= MARINE_EXCLUSION_MAX_NOISE_RECORDS),
    ),
  ];

  // Rescue pass: a bird or mammal below the recent-window threshold is kept if its all-time
  // records spread across several years (a sparse resident, not a one-off visit).
  const passedGbifKeys = new Set(filtered.map((c) => c.gbifKey));
  const allTimeBirdMammalCountsRaw = await fetchSpeciesCountsForRegion(code, BIRD_MAMMAL_TAXON_KEYS, null);
  // Same marine-mammal carve-out, so the rescue can't bring one back.
  const allTimeBirdMammalCounts = allTimeBirdMammalCountsRaw.filter((c) => !marineMammalGbifKeys.has(c.gbifKey));

  // Recurrence floor per taxon class (birds and mammals differ widely), from the median of
  // species that clearly passed.
  const classByGbifKey = new Map<number, string>();
  if (birdMammalCounts.length > 0) {
    const classRes = await pool.query<{ gbif_key: string; taxon_class: string }>(
      `SELECT gbif_key, taxon_class FROM species WHERE gbif_key = ANY($1)`,
      [birdMammalCounts.map((c) => c.gbifKey)],
    );
    for (const row of classRes.rows) classByGbifKey.set(Number(row.gbif_key), row.taxon_class);
  }
  const allTimeByGbifKey = new Map(allTimeBirdMammalCounts.map((c) => [c.gbifKey, c.recordCount]));
  const allTimeTotalsByClass = new Map<string, number[]>();
  for (const c of birdMammalCounts) {
    if (c.recordCount < MIN_RECORDS) continue;
    const cls = classByGbifKey.get(c.gbifKey);
    const allTime = allTimeByGbifKey.get(c.gbifKey);
    if (!cls || allTime == null) continue;
    if (!allTimeTotalsByClass.has(cls)) allTimeTotalsByClass.set(cls, []);
    allTimeTotalsByClass.get(cls)!.push(allTime);
  }
  const recurrenceFloorByClass = new Map(
    [...allTimeTotalsByClass.entries()].map(([cls, totals]) => [cls, medianOf(totals) * RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN]),
  );
  const recurrenceFloorFor = (gbifKey: number): number => recurrenceFloorByClass.get(classByGbifKey.get(gbifKey) ?? "") ?? 0;

  const rescueCandidates = allTimeBirdMammalCounts.filter(
    (c) => !passedGbifKeys.has(c.gbifKey) && c.recordCount >= RECURRENCE_ALLTIME_FLOOR,
  );
  for (const candidate of rescueCandidates) {
    const yearCounts = await fetchYearCountsForSpecies(code, candidate.gbifKey);
    if (!passesRecurrenceCheck(yearCounts, recurrenceFloorFor(candidate.gbifKey))) continue;
    // Captive-only records (zoos) also spread across years, so they're ruled out separately.
    const sample = await fetchRecordSampleForSpecies(code, candidate.gbifKey);
    if (looksCaptiveOnly(sample)) continue;
    filtered.push(candidate);
    passedGbifKeys.add(candidate.gbifKey);
  }

  // Local tier ranks species only against this region's checklist, so how findable a species is
  // here doesn't depend on effort elsewhere. The global tier stays as it is.
  const traitsRes = await pool.query<{
    gbif_key: string;
    nocturnal: boolean | null;
    range_size_km2: string | null;
    population_estimate: string | null;
    habitat_density: number | null;
    domestic: boolean;
  }>(
    `SELECT s.gbif_key, t.nocturnal, t.range_size_km2, t.population_estimate, t.habitat_density, t.domestic
     FROM species s JOIN species_traits t ON t.species_id = s.id WHERE s.gbif_key = ANY($1)`,
    [filtered.map((c) => c.gbifKey)],
  );
  const nocturnalByGbifKey = new Map(traitsRes.rows.map((r) => [Number(r.gbif_key), r.nocturnal]));
  const habitatDensityByGbifKey = new Map(traitsRes.rows.map((r) => [Number(r.gbif_key), r.habitat_density]));
  // Domestic species stay out of the ranking (their counts measure farm photos) and are "common".
  const domesticGbifKeys = new Set(traitsRes.rows.filter((r) => r.domestic).map((r) => Number(r.gbif_key)));

  // Population over range as a density signal, ranked within this checklist.
  const densityIndexes = traitsRes.rows
    .map((r, idx) => {
      const population = r.population_estimate != null ? Number(r.population_estimate) : null;
      const range = r.range_size_km2 != null ? Number(r.range_size_km2) : null;
      const density = population != null && range != null && range > 0 ? population / range : null;
      return { idx, value: density };
    })
    .filter((e): e is { idx: number; value: number } => e.value != null);
  const densityScoreByGbifKey = new Map(
    [...percentileRankScores(densityIndexes)].map(([idx, score]) => [Number(traitsRes.rows[idx].gbif_key), score]),
  );

  // A single vagrant chased by many birders looks common by count alone, so every listed species
  // gets the recurrence check to flag vagrants.
  const wildFiltered = filtered.filter((c) => !domesticGbifKeys.has(c.gbifKey));
  // Fish skip the distinct-years check (on a small island most reef records fall offshore) but
  // need a few total records not to be flagged vagrant.
  const FISH_VAGRANT_MIN_RECORDS = 3;
  const fishGbifKeys = new Set(fishCounts.map((c) => c.gbifKey));
  const fishRecordCountByGbifKey = new Map(fishCounts.map((c) => [c.gbifKey, c.recordCount]));
  const yearConcentrationByGbifKey = new Map<number, number>();
  const isVagrantByGbifKey = new Map<number, boolean>();
  // One facet call per year for every species at once, rather than one call per species.
  const yearlyCountsByGbifKey = await fetchYearlyRecordCounts(code, BIRD_MAMMAL_TAXON_KEYS);
  const countryIso3 = await resolveCountryIso3(regionId);
  const nonNativeGbifKeys = countryIso3 ? await loadNonNativeGbifKeys(countryIso3) : new Set<number>();
  for (const c of wildFiltered) {
    const isNonNative = nonNativeGbifKeys.has(c.gbifKey);
    if (fishGbifKeys.has(c.gbifKey)) {
      const recordCount = fishRecordCountByGbifKey.get(c.gbifKey) ?? 0;
      isVagrantByGbifKey.set(c.gbifKey, isNonNative || recordCount < FISH_VAGRANT_MIN_RECORDS);
      continue;
    }
    const yearCounts = yearlyCountsByGbifKey.get(c.gbifKey) ?? [];
    const total = yearCounts.reduce((sum, y) => sum + y.count, 0);
    const isVagrant = isNonNative || (total > 0 && !passesRecurrenceCheck(yearCounts, recurrenceFloorFor(c.gbifKey)));
    isVagrantByGbifKey.set(c.gbifKey, isVagrant);
    // Share of records in the busiest year (0 to 1), so a near miss is boosted less than a
    // single event.
    const maxShare = total > 0 ? Math.max(...yearCounts.map((y) => y.count)) / total : 0;
    if (isVagrant) yearConcentrationByGbifKey.set(c.gbifKey, maxShare);
  }

  // Record-count rank (0 easiest, 1 rarest here), boosted for nocturnal, low-density and dense
  // habitat species (compute-rarity-phase1.ts).
  const baseScoreByIdx = percentileRankScores(wildFiltered.map((c, idx) => ({ idx, value: c.recordCount })));
  const VAGRANT_BURST_BOOST_WEIGHT = 0.6;
  const boostedScores = wildFiltered.map((c, idx) => {
    const nocturnalBoosted = boostElusivenessForNocturnal(baseScoreByIdx.get(idx) ?? 0.5, nocturnalByGbifKey.get(c.gbifKey) ?? null);
    const densityBoosted = boostElusivenessForDensity(nocturnalBoosted, densityScoreByGbifKey.get(c.gbifKey) ?? null);
    const habitatBoosted = boostElusivenessForHabitatDensity(densityBoosted, habitatDensityByGbifKey.get(c.gbifKey) ?? null);
    const yearConcentration = yearConcentrationByGbifKey.get(c.gbifKey) ?? null;
    const vagrantBoosted =
      yearConcentration != null ? boostTowardHarderToDetect(habitatBoosted, yearConcentration * VAGRANT_BURST_BOOST_WEIGHT) : habitatBoosted;
    return { gbifKey: c.gbifKey, score: vagrantBoosted };
  });
  // Scored against the same taxon-calibrated absolute thresholds as the global tier, rather than
  // by rank within the region.
  const taxonClassRes = await pool.query<{ gbif_key: string; taxon_class: string | null }>(
    `SELECT gbif_key, taxon_class FROM species WHERE gbif_key = ANY($1)`,
    [wildFiltered.map((c) => c.gbifKey)],
  );
  const taxonClassByGbifKey = new Map(taxonClassRes.rows.map((r) => [Number(r.gbif_key), r.taxon_class]));
  const localTierByGbifKey = new Map<number, string>();
  boostedScores.forEach(({ gbifKey, score }) => {
    const taxonClass = taxonClassByGbifKey.get(gbifKey);
    // Classes without reliable data density (NO_RARITY_TIER_TAXON_CLASSES) stay untiered.
    if (taxonClass && NO_RARITY_TIER_TAXON_CLASSES.has(taxonClass as TaxonClass)) return;
    const thresholds = fishGbifKeys.has(gbifKey)
      ? FISH_ABSOLUTE_TIER_THRESHOLDS
      : taxonClass === "mammalia"
        ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS
        : BIRD_ABSOLUTE_TIER_THRESHOLDS;
    localTierByGbifKey.set(gbifKey, tierForScore(score, thresholds));
  });

  // Local tier may read at most one step easier than global (a heavily monitored rare species
  // shouldn't read common)...
  const LOCAL_TIER_GLOBAL_FLOOR_STEPS = 1;
  // ...and at most two steps harder (thin data shouldn't make a common species legendary).
  const LOCAL_TIER_GLOBAL_CEILING_STEPS = 2;
  const TIER_ORDER = ["legendary", "rare", "uncommon", "occasional", "common"];
  const globalTierRes = await pool.query<{ gbif_key: string; tier: string }>(
    `SELECT s.gbif_key, r.tier FROM species s JOIN species_rarity r ON r.species_id = s.id WHERE s.gbif_key = ANY($1)`,
    [wildFiltered.map((c) => c.gbifKey)],
  );
  const globalTierByGbifKey = new Map(globalTierRes.rows.map((r) => [Number(r.gbif_key), r.tier]));
  for (const [gbifKey, localTier] of localTierByGbifKey) {
    const globalTier = globalTierByGbifKey.get(gbifKey);
    if (!globalTier || globalTier === "unrated") continue;
    const globalRank = TIER_ORDER.indexOf(globalTier);
    const localRank = TIER_ORDER.indexOf(localTier);
    const clampedRank = Math.min(
      Math.max(localRank, globalRank - LOCAL_TIER_GLOBAL_CEILING_STEPS),
      globalRank + LOCAL_TIER_GLOBAL_FLOOR_STEPS,
    );
    if (clampedRank !== localRank) localTierByGbifKey.set(gbifKey, TIER_ORDER[clampedRank]);
  }

  for (const gbifKey of domesticGbifKeys) localTierByGbifKey.set(gbifKey, "common");

  // iNaturalist research-grade records decide membership; GBIF supplies the data above. Without
  // iNat data (null) GBIF decides, so a lookup failure never empties a checklist.
  const inatMatchedIds = region.name ? await matchedSpeciesIdsForRegion(regionId, region.name) : null;

  await withTransaction(async (client) => {
    if (inatMatchedIds) {
      const { matchedSpeciesIds, rawTaxonIds } = inatMatchedIds;

      const existingRes = await client.query<{ species_id: string; local_tier: string | null }>(
        `SELECT species_id, local_tier FROM region_species WHERE region_id = $1`,
        [regionId],
      );
      const existingIds = new Set(existingRes.rows.map((r) => r.species_id));
      const alreadyTieredIds = new Set(existingRes.rows.filter((r) => r.local_tier != null).map((r) => r.species_id));

      // Before dropping species iNat didn't match, rescue any that are only a name change (a
      // genus move) away from a match.
      const removalCandidateIds = [...existingIds].filter((id) => !matchedSpeciesIds.has(id));
      let rescuedIds = new Set<string>();
      if (removalCandidateIds.length > 0) {
        const candidateRows = await client.query<{ id: string; scientific_name: string }>(
          `SELECT id, scientific_name FROM species WHERE id = ANY($1::uuid[])`,
          [removalCandidateIds],
        );
        rescuedIds = await resolveRemovalRescues(candidateRows.rows, rawTaxonIds);
      }

      const idList = [...matchedSpeciesIds, ...rescuedIds];
      await client.query(
        `DELETE FROM region_species WHERE region_id = $1 AND NOT (species_id = ANY($2::uuid[]))`,
        [regionId, idList],
      );
      // Listed species that already have a tier are left alone; new or untiered ones are written.
      const needsTierIds = idList.filter((id) => !alreadyTieredIds.has(id));
      if (needsTierIds.length > 0) {
        const gbifKeyRes = await client.query<{ id: string; gbif_key: string | null }>(
          `SELECT id, gbif_key FROM species WHERE id = ANY($1::uuid[])`,
          [needsTierIds],
        );
        const byGbifKey = new Map(filtered.map((c) => [c.gbifKey, c]));
        for (const row of gbifKeyRes.rows) {
          const gbifKey = row.gbif_key != null ? Number(row.gbif_key) : null;
          const match = gbifKey != null ? byGbifKey.get(gbifKey) : undefined;
          // Confirmed by iNat but not scored from GBIF: left unrated.
          const localTier = match ? localTierByGbifKey.get(match.gbifKey) ?? null : null;
          await client.query(
            `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant)
             VALUES ($1,$2,$3,$4,$5,$6)
             ON CONFLICT (region_id, species_id) DO UPDATE SET
               local_frequency = EXCLUDED.local_frequency, seasonality = EXCLUDED.seasonality, local_tier = EXCLUDED.local_tier,
               is_vagrant = EXCLUDED.is_vagrant`,
            [
              regionId,
              row.id,
              match?.recordCount ?? 0,
              match ? seasonality.get(match.gbifKey) ?? null : null,
              localTier,
              match ? isVagrantByGbifKey.get(match.gbifKey) ?? false : false,
            ],
          );
        }
      }
    } else {
      await client.query(`DELETE FROM region_species WHERE region_id = $1`, [regionId]);
      for (const c of filtered) {
        const speciesIdRes = await client.query(`SELECT id FROM species WHERE gbif_key = $1`, [c.gbifKey]);
        const speciesId = speciesIdRes.rows[0]?.id;
        if (!speciesId) continue;
        await client.query(
          `INSERT INTO region_species (region_id, species_id, local_frequency, seasonality, local_tier, is_vagrant)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (region_id, species_id) DO UPDATE SET
             local_frequency = EXCLUDED.local_frequency, seasonality = EXCLUDED.seasonality, local_tier = EXCLUDED.local_tier,
             is_vagrant = EXCLUDED.is_vagrant`,
          [
            regionId,
            speciesId,
            c.recordCount,
            seasonality.get(c.gbifKey) ?? null,
            localTierByGbifKey.get(c.gbifKey) ?? null,
            isVagrantByGbifKey.get(c.gbifKey) ?? false,
          ],
        );
      }
    }
    await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
  }, { lockReferenceData: true });
}
