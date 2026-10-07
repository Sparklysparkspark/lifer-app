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
  SEA_ZONE_BASIS_OF_RECORD,
  type RegionSpeciesCount,
} from "../buildRegionSpecies.js";
import { fetchFishTaxonKeys } from "../../gbif/fishOrders.js";
import { mapWithConcurrency } from "../../lib/concurrency.js";

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
  const [fishCounts, marineMammalCounts] = await Promise.all([
    fetchSpeciesCountsForZone(wkt, fishKeys, FISH_YEARS_WINDOW, SEA_ZONE_BASIS_OF_RECORD),
    fetchSpeciesCountsForZone(wkt, MARINE_MAMMAL_ORDER_KEYS, null, SEA_ZONE_BASIS_OF_RECORD),
  ]);
  // Only catalog species can be stored, so the others are dropped before the checks below, which
  // cost one or two GBIF requests per species.
  const catalogRes = await pool.query<{ gbif_key: string }>(`SELECT gbif_key FROM species WHERE gbif_key = ANY($1)`, [
    [...fishCounts, ...marineMammalCounts].map((c) => c.gbifKey),
  ]);
  const inCatalog = new Set(catalogRes.rows.map((r) => Number(r.gbif_key)));
  // Species WoRMS records only in fresh water or on land (never marine or brackish) stay off a sea
  // zone's list, as on the offline path (sea-zone-checklist.ts). The zone's 80-point outline takes
  // in coastal land, lagoons and river mouths, so their records land here otherwise. Species
  // WoRMS hasn't been asked about, or doesn't know, are kept.
  const freshwaterRes = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species s JOIN species_traits t ON t.species_id = s.id
     WHERE s.gbif_key = ANY($1)
       AND t.worms_is_marine IS NOT TRUE AND t.worms_is_brackish IS NOT TRUE
       AND (t.worms_is_marine IS NOT NULL OR t.worms_is_brackish IS NOT NULL)
       AND (t.worms_is_freshwater OR t.worms_is_terrestrial)`,
    [[...inCatalog]],
  );
  const freshwaterOnly = new Set(freshwaterRes.rows.map((r) => Number(r.gbif_key)));
  const counts = [...fishCounts, ...marineMammalCounts].filter(
    (c) => inCatalog.has(c.gbifKey) && !freshwaterOnly.has(c.gbifKey),
  );
  // High-tier species with no reference photo get the extra checks below whatever their record
  // count: they're the likeliest data problems and the costliest to get wrong.
  const gbifKeys = counts.map((c) => c.gbifKey);
  const scrutinyRes = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species s LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE s.gbif_key = ANY($1) AND s.reference_photo IS NULL AND r.tier IN ('rare', 'legendary', 'unrated')`,
    [gbifKeys],
  );
  const highTierNoPhotoGbifKeys = new Set(scrutinyRes.rows.map((r) => Number(r.gbif_key)));

  const afterTypeSpecimenCheck = await dropSuspiciousRecords(wkt, counts, highTierNoPhotoGbifKeys);
  const filtered = afterTypeSpecimenCheck.filter((c) => c.recordCount >= FISH_MIN_RECORDS);
  await withTransaction(
    async (client) => {
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
    },
    { lockReferenceData: true },
  );
}

// GBIF's polygon searches take several seconds each over a large sea, so a zone's species are
// checked a few at a time rather than one by one. Kept low to stay polite to GBIF's public API.
const SCRUTINY_CONCURRENCY = 6;

/** The same record-sample checks as the land path, only for low-count or high-tier species to
 *  bound the cost; the inland check applies at any count within that group. Keeps input order. */
export async function dropSuspiciousRecords(
  wkt: string,
  counts: RegionSpeciesCount[],
  highTierNoPhotoGbifKeys: Set<number>,
  concurrency = SCRUTINY_CONCURRENCY,
): Promise<RegionSpeciesCount[]> {
  const kept = await mapWithConcurrency(counts, concurrency, async (c) => {
    const needsScrutiny =
      c.recordCount <= GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS || highTierNoPhotoGbifKeys.has(c.gbifKey);
    if (!needsScrutiny) return c;
    const sample = await fetchRecordSampleForZone(wkt, c.gbifKey);
    if (looksTypeSpecimenOnly(sample)) return null;
    if (await looksLikeInlandRecords(sample)) return null;
    if (c.recordCount > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS) return c;
    const globalCount = await fetchGlobalOccurrenceCount(c.gbifKey);
    return looksLikeGeographicOutlier(c.recordCount, globalCount) ? null : c;
  });
  return kept.filter((c): c is RegionSpeciesCount => c !== null);
}
