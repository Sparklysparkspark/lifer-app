import { pool, withTransaction } from "../../db.js";
import {
  fetchSpeciesCountsForZone,
  fetchRecordSampleForZone,
  looksTypeSpecimenOnly,
  looksLikeGeographicOutlier,
  looksLikeInlandRecords,
  fetchGlobalOccurrenceCount,
  GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  type RegionSpeciesCount,
} from "data-pipeline/src/build/build-region-species.js";
import { fetchFishTaxonKeys } from "data-pipeline/src/fetch/fetch-fish-orders.js";

// GBIF order keys for Cetacea (733) and Sirenia (802). These belong on sea-zone checklists and are
// always left off a land region's list (GBIF's country filter includes territorial waters), with
// no record-count threshold since they have no land population.
export const MARINE_MAMMAL_ORDER_KEYS = [733, 802];

// Computes and stores one sea zone's checklist (fish and marine mammals). A country's default
// list excludes a species only when it's found in a real sea polygon nearby.
export async function ensureSeaZoneComputed(zoneId: string, wkt: string, alreadyComputed: boolean): Promise<void> {
  if (alreadyComputed) return;
  const fishKeys = await fetchFishTaxonKeys();
  // The fish keys exclude Mammalia, so marine mammals are fetched separately.
  const [counts, marineMammalCounts] = await Promise.all([
    fetchSpeciesCountsForZone(wkt, fishKeys, FISH_YEARS_WINDOW),
    fetchSpeciesCountsForZone(wkt, MARINE_MAMMAL_ORDER_KEYS),
  ]);
  counts.push(...marineMammalCounts);
  // High-tier species with no reference photo get the extra checks below whatever their record
  // count: they're the likeliest data problems and the costliest to get wrong.
  const gbifKeys = counts.map((c) => c.gbifKey);
  const scrutinyRes = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species s LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE s.gbif_key = ANY($1) AND s.reference_photo IS NULL AND r.tier IN ('rare', 'legendary', 'unrated')`,
    [gbifKeys],
  );
  const highTierNoPhotoGbifKeys = new Set(scrutinyRes.rows.map((r) => Number(r.gbif_key)));

  // Same record-sample checks as the land path, only for low-count or high-tier species to bound
  // the cost. The inland check applies at any count within that group.
  const afterTypeSpecimenCheck: RegionSpeciesCount[] = [];
  for (const c of counts) {
    const needsScrutiny = c.recordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS || highTierNoPhotoGbifKeys.has(c.gbifKey);
    if (!needsScrutiny) {
      afterTypeSpecimenCheck.push(c);
      continue;
    }
    const sample = await fetchRecordSampleForZone(wkt, c.gbifKey);
    if (looksTypeSpecimenOnly(sample)) continue;
    if (await looksLikeInlandRecords(sample)) continue;
    if (c.recordCount > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS) {
      afterTypeSpecimenCheck.push(c);
      continue;
    }
    const globalCount = await fetchGlobalOccurrenceCount(c.gbifKey);
    if (!looksLikeGeographicOutlier(c.recordCount, globalCount)) afterTypeSpecimenCheck.push(c);
  }
  const filtered = afterTypeSpecimenCheck.filter((c) => c.recordCount >= FISH_MIN_RECORDS);
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM sea_zone_species WHERE sea_zone_id = $1`, [zoneId]);
    for (const c of filtered) {
      const speciesIdRes = await client.query(`SELECT id FROM species WHERE gbif_key = $1`, [c.gbifKey]);
      const speciesId = speciesIdRes.rows[0]?.id;
      if (!speciesId) continue;
      await client.query(
        `INSERT INTO sea_zone_species (sea_zone_id, species_id, record_count) VALUES ($1, $2, $3)
         ON CONFLICT (sea_zone_id, species_id) DO UPDATE SET record_count = EXCLUDED.record_count`,
        [zoneId, speciesId, c.recordCount],
      );
    }
    await client.query(`UPDATE sea_zones SET occurrence_computed_at = now() WHERE id = $1`, [zoneId]);
  }, { lockReferenceData: true });
}
