import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import {
  OBSCURE_SPECIES_SQL,
  REGION_VAGRANT_SQL,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  getHideObscurePreference,
} from "../species/obscurity.js";
// Cross-package import, deliberately — this is pure GBIF-fetching logic with no heavy
// runtime deps, unlike the exiftool/sharp-laden upload pipeline code kept duplicated
// elsewhere (see licensePolicy.ts).
import {
  fetchSpeciesCountsForRegion,
  fetchSpeciesCountsForZone,
  fetchMonthlySeasonality,
  fetchYearCountsForSpecies,
  fetchYearlyRecordCounts,
  passesRecurrenceCheck,
  fetchRecordSampleForSpecies,
  fetchRecordSampleForZone,
  looksCaptiveOnly,
  looksTypeSpecimenOnly,
  looksLikeGeographicOutlier,
  looksLikeInlandRecords,
  fetchGlobalOccurrenceCount,
  GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
  MIN_RECORDS,
  FISH_MIN_RECORDS,
  FISH_YEARS_WINDOW,
  RECURRENCE_ALLTIME_FLOOR,
  type RegionSpeciesCount,
} from "data-pipeline/src/build/build-region-species.js";
import { fetchProvincesForCountry } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { AVES_CLASS_KEY, MAMMALIA_CLASS_KEY } from "data-pipeline/src/fetch/fetch-gbif-backbone.js";
import { fetchFishTaxonKeys } from "data-pipeline/src/fetch/fetch-fish-orders.js";
import {
  bboxesNear,
  bboxContains,
  bboxDiagonalDegrees,
  SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES,
  minRingDistance,
  exteriorRingsFromGeometry,
  parseWktPolygonRing,
  type BoundingBox,
  type Point,
} from "data-pipeline/src/geometry.js";
import {
  tierForPercentile,
  percentileRankScores,
  boostElusivenessForNocturnal,
  boostElusivenessForDensity,
  boostElusivenessForHabitatDensity,
  boostTowardHarderToDetect,
} from "data-pipeline/src/build/compute-rarity-phase1.js";

// Fish get their own, much more permissive thresholds than birds/mammals (see
// FISH_MIN_RECORDS's own comment) — a single combined GBIF query can't apply two
// different thresholds to one result set, so bird+mammal and fish are fetched as two
// separate calls here and merged, rather than the one combined call this used to be.
const BIRD_MAMMAL_TAXON_KEYS = [AVES_CLASS_KEY, MAMMALIA_CLASS_KEY];

// Cetacea (733) and Sirenia (802) — verified live against GBIF's backbone (species/match),
// both ORDER-rank under classKey 359 (Mammalia). build-seed-mammals.ts already reclassifies
// these species' taxon_class to "actinopterygii" (the app's "Fish" grouping) specifically so
// whales/dolphins/dugongs get the sea-zone-gated treatment instead of a land region's default
// checklist — but that reclassification only ever touched the seed data, not this file's own
// GBIF queries, which still pull BIRD_MAMMAL_TAXON_KEYS (including all of Mammalia) with no
// marine carve-out. Confirmed live: Egypt's base (land) checklist included the Common
// Bottlenose Dolphin, Dugong, Humpback Whale, Spinner Dolphin, and 6 others, because GBIF's
// `country=EG` field covers Egypt's territorial waters too and nothing ever excluded them.
// Unlike fish's marineGbifKeys/MARINE_EXCLUSION_MAX_NOISE_RECORDS noise-threshold (some fish
// really do have a genuine land/freshwater population as well as unrelated marine records
// elsewhere), an obligate marine mammal has no legitimate land population at all — every
// single record IS a sea record — so exclusion from a land region's default list is
// unconditional, not threshold-gated.
const MARINE_MAMMAL_ORDER_KEYS = [733, 802];

// A generous bbox pre-filter (cheap, avoids computing real point-distance against all ~139
// zones every time) followed by a real point-to-point distance check with a much tighter
// threshold — a bbox-only check is wrong for large/irregular seas: Egypt's bbox spuriously
// "overlapped" the Ionian Sea's (612km away) and Aegean Sea's (545km away) bounding boxes
// even though their real coastlines are nowhere close, while its genuine neighbors
// (Mediterranean/Red Sea/Gulf of Suez/Gulf of Aqaba) all measured 0-1km. 2 degrees (~220km)
// comfortably separates the two groups with margin either side.
const BBOX_PREFILTER_BUFFER_DEGREES = 10;
const NEARBY_MAX_DISTANCE_DEGREES = 2;

async function nearbyZones(
  regionBbox: BoundingBox,
  regionRings: Point[][],
): Promise<Array<{ id: string; name: string; wkt: string }>> {
  const zonesRes = await pool.query(
    `SELECT id, name, wkt, bbox_min_lon, bbox_min_lat, bbox_max_lon, bbox_max_lat FROM sea_zones`,
  );
  const shortlisted = zonesRes.rows.filter((z) =>
    bboxesNear(
      regionBbox,
      { minLon: z.bbox_min_lon, minLat: z.bbox_min_lat, maxLon: z.bbox_max_lon, maxLat: z.bbox_max_lat },
      BBOX_PREFILTER_BUFFER_DEGREES,
    ),
  );
  return shortlisted.filter((z) => {
    // A small island's own bbox sitting entirely inside a sea zone's bbox is about as
    // unambiguous as "nearby water" gets, regardless of what the ring-distance check says —
    // found via Antigua and Barb.: fully inside the Eastern Caribbean zone's bbox, yet its
    // simplified polygon edge (Ramer-Douglas-Peucker, see geometry.ts) sits 2.24° from
    // Antigua's coast, just over the 2° cutoff below. A tiny island is disproportionately
    // exposed to exactly this simplification artifact, so it gets its own bypass rather than
    // loosening NEARBY_MAX_DISTANCE_DEGREES for every region (which risks reintroducing
    // false positives like Egypt/the Ionian/the Aegean, the cases that motivated 2° at all).
    const zoneBbox: BoundingBox = { minLon: z.bbox_min_lon, minLat: z.bbox_min_lat, maxLon: z.bbox_max_lon, maxLat: z.bbox_max_lat };
    // Gated to island-scale regions only (see bboxContains's own comment) — without this, a
    // large landlocked region (e.g. Aswan) can trivially have its whole bbox sit "inside" a
    // sea zone's own loose, whole-basin bbox despite being nowhere near real water.
    if (bboxDiagonalDegrees(regionBbox) <= SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES && bboxContains(zoneBbox, regionBbox)) {
      return true;
    }
    const zoneRing = parseWktPolygonRing(z.wkt);
    return minRingDistance(regionRings, [zoneRing]) <= NEARBY_MAX_DISTANCE_DEGREES;
  });
}

// Lazily computes and caches one sea zone's fish checklist (same pattern as a region's own
// occurrence computation) — shared by the explicit "include nearby water" toggle AND by the
// default country list's own exclusion logic below (a species is only ever excluded from a
// country's DEFAULT list if it's demonstrably present in a real marine polygon nearby — not
// by a habitat guess, and not by a "saltwater" heuristic, which breaks on salt lakes).
async function ensureSeaZoneComputed(zoneId: string, wkt: string, alreadyComputed: boolean): Promise<void> {
  if (alreadyComputed) return;
  const fishKeys = await fetchFishTaxonKeys();
  // fetchFishTaxonKeys() deliberately excludes Mammalia entirely (see its own comment) — a
  // sea zone's checklist still needs whales/dolphins/dugongs, since MARINE_MAMMAL_ORDER_KEYS'
  // whole point is that these species belong on the SEA side of the land/sea split, not on
  // a land region's default list. Without this, they'd be excluded from land regions (once
  // that carve-out exists) but never actually show up anywhere — including the "include
  // nearby water" toggle they're specifically meant to appear under.
  const [counts, marineMammalCounts] = await Promise.all([
    fetchSpeciesCountsForZone(wkt, fishKeys, FISH_YEARS_WINDOW),
    fetchSpeciesCountsForZone(wkt, MARINE_MAMMAL_ORDER_KEYS),
  ]);
  counts.push(...marineMammalCounts);
  // A rare-tier species with no reference photo at all is exactly the case most worth an
  // extra look before it gets included in a specific sea zone's checklist — it's both the
  // most likely to be an undetected data-quality problem (nobody's verified it by eye yet)
  // and the most consequential to get wrong (a "legendary" showing up somewhere it doesn't
  // belong is a much bigger deal to a user hunting for it than a common species would be).
  // Widens the scrutiny gate below beyond just "low record count" to also cover these,
  // regardless of how many records they have.
  const gbifKeys = counts.map((c) => c.gbifKey);
  const scrutinyRes = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species s LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE s.gbif_key = ANY($1) AND s.reference_photo IS NULL AND r.tier IN ('epic', 'legendary', 'unrated')`,
    [gbifKeys],
  );
  const highTierNoPhotoGbifKeys = new Set(scrutinyRes.rows.map((r) => Number(r.gbif_key)));

  // See looksTypeSpecimenOnly/looksLikeGeographicOutlier/looksLikeInlandRecords's own
  // comments — same fix as the land-region path, same bounded-cost scoping
  // (GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS OR the high-tier/no-photo set above, not every
  // species). looksLikeInlandRecords applies regardless of record count within this group —
  // it's a pure geometry sanity check (does this resolve onto real land, far from any coast),
  // not a volume comparison, so a high-tier species with plenty of records but all of them
  // inland is just as wrong as one with only a few.
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
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

type SortBy = "taxonomic" | "rarity" | "name";
type StateFilter = "all" | "missing" | "collected" | "seen";

const TIER_RANK: Record<string, number> = { legendary: 0, epic: 1, rare: 2, uncommon: 3, common: 4 };

export async function regionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/regions", { preHandler: requireAuth }, async () => {
    const res = await pool.query(
      `SELECT id, name, parent_id, ebird_region_code, boundary_geojson, has_children, external_codes FROM regions ORDER BY parent_id NULLS FIRST, name`,
    );
    return {
      regions: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: r.parent_id,
        ebirdRegionCode: r.ebird_region_code,
        boundaryGeoJson: r.boundary_geojson,
        hasChildren: r.has_children,
        hasScopedChecklist: (r.external_codes?.length ?? 0) > 0,
      })),
    };
  });

  // Countries have the fish found locally in their actual land area by default, with an
  // option to include nearby major sources of water. This list is
  // only for surfacing reasonable checkbox options; the species themselves are counted from
  // each sea zone's real, unbuffered polygon (see fetchSpeciesCountsForZone).
  app.get<{ Params: { id: string } }>("/regions/:id/sea-zones", { preHandler: requireAuth }, async (request, reply) => {
    const { id: regionId } = request.params;
    const regionRes = await pool.query(`SELECT boundary_geojson FROM regions WHERE id = $1`, [regionId]);
    const region = regionRes.rows[0];
    if (!region) return reply.code(404).send({ error: "Region not found" });

    const bbox = region.boundary_geojson?.bbox as [number, number, number, number] | undefined;
    const geometry = region.boundary_geojson?.geometry;
    if (!bbox || !geometry) return { zones: [] };
    const regionBbox: BoundingBox = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
    const zones = await nearbyZones(regionBbox, exteriorRingsFromGeometry(geometry));
    return { zones: zones.map((z) => ({ id: z.id, name: z.name })) };
  });

  app.get<{
    Params: { id: string };
    Querystring: {
      sort?: SortBy;
      filter?: StateFilter;
      taxon?: string;
      seaZoneIds?: string;
      includeLand?: string;
    };
  }>(
    "/regions/:id/species",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: regionId } = request.params;
      const userId = request.user!.id;
      const sort = request.query.sort ?? "taxonomic";
      const filter = request.query.filter ?? "all";
      const taxon = request.query.taxon ?? null;
      const hideObscure = await getHideObscurePreference(userId);
      // Multiple sea zones can be toggled on at once (e.g. Red Sea AND Gulf of Aqaba) —
      // comma-separated, same simple-string-param convention already used for `taxon` etc.
      // in this file, rather than adding array querystring parsing.
      const seaZoneIds = request.query.seaZoneIds ? request.query.seaZoneIds.split(",").filter(Boolean) : [];
      // Lets a sea zone checkbox show ONLY that zone's species (e.g. just the Red Sea's
      // fish) rather than always adding to the region's own land/freshwater checklist.
      // Defaults true so every existing bookmarked/shared URL (which never had this param)
      // keeps its old "land + selected zones" behavior.
      const includeLand = request.query.includeLand !== "0";

      // Sea zone species come exclusively from a downloaded offline pack now — see
      // offlinePacks/routes.ts's applyPack, which populates sea_zone_species and stamps
      // occurrence_computed_at itself. A zone with no pack applied yet just contributes zero
      // species to the "include nearby water" toggle rather than blocking this request on a
      // live GBIF call (computeRegionOccurrences/ensureSeaZoneComputed's own GBIF-fetching
      // logic still exists, but only for the offline pack-building scripts to call).
      if (seaZoneIds.length > 0) {
        const zonesRes = await pool.query(`SELECT id FROM sea_zones WHERE id = ANY($1)`, [seaZoneIds]);
        if (zonesRes.rows.length !== seaZoneIds.length) return reply.code(404).send({ error: "Sea zone not found" });
      }

      // canDrillDown (below) needs to know whether THIS region is itself a country (parent is
      // a continent/hub with no code of its own) as opposed to already a province/state —
      // fetchProvincesForCountry only has admin1 (country -> province) data, no admin2, so
      // "drill down" on an already-province region always yields zero children.
      const regionRes = await pool.query(
        `SELECT r.id, r.name, r.ebird_region_code, r.boundary_geojson, r.external_codes, r.occurrence_computed_at, r.has_children,
                COALESCE(array_length(p.external_codes, 1), 0) = 0 AS region_is_country_level
         FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
         WHERE r.id = $1`,
        [regionId],
      );
      const region = regionRes.rows[0];
      if (!region) return reply.code(404).send({ error: "Region not found" });

      // A region's checklist comes exclusively from a downloaded offline pack now — see
      // offlinePacks/routes.ts's applyPack, which populates region_species and stamps
      // occurrence_computed_at itself. computeRegionOccurrences (below) still exists and does
      // real GBIF work, but only for the maintainer-side pack-building scripts to call — a
      // self-hosted install's own API must never make that live call itself (it can take
      // minutes per region). A region with a GADM code but no pack applied yet just tells the
      // client so, rather than blocking this request on GBIF.
      if (!region.occurrence_computed_at && region.external_codes?.length > 0) {
        return { needsPack: true, region: { id: region.id, name: region.name } };
      }

      // Same per-user state computation as GET /collection (see collectionItem.ts) — collected
      // if a capture exists, seen if eBird-imported without a photo, else unseen. Species
      // ids come from a UNION of this region's own checklist AND (when a sea zone checkbox
      // is active) the zone's checklist — a species can be in both, hence UNION not
      // UNION ALL. Sea-zone-only species get local_tier = NULL (LEFT JOINed from
      // region_species, which won't have a row for them) rather than a fabricated
      // region-scoped rarity: "local tier" specifically means "ranked against this region's
      // OTHER species," and a Red-Sea reef fish was never ranked against Egypt's checklist.
      const res = await pool.query(
        `WITH species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = $2 AND $5
           UNION
           SELECT species_id FROM sea_zone_species WHERE sea_zone_id = ANY($4)
         )
         SELECT
           s.id AS species_id,
           s.scientific_name,
           s.common_name,
           s.taxon_class,
           s.family,
           s.reference_photo,
           s.reference_credit,
           s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
           s.reference_focal_x,
           s.reference_focal_y,
           r.tier,
           rs.local_tier,
           rs.is_vagrant,
           t.endemic_country_iso3,
           t.endemic_region_label,
           us.state,
           us.cover_photo_id,
           us.card_crop_x,
           us.card_crop_y,
           us.card_crop_size,
           p.thumb_path IS NOT NULL AS has_cover_photo,
           sv.label AS cover_volume_label
         FROM species_ids si
         JOIN species s ON s.id = si.species_id
         LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id = $2
         LEFT JOIN species_rarity r ON r.species_id = s.id
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
         LEFT JOIN photos p ON p.id = us.cover_photo_id
         LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
         LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
         LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
         WHERE ($3::text IS NULL OR s.taxon_class = $3) AND COALESCE(t.fully_extinct, false) = false
           AND ($6 = false OR ${ALREADY_OWNED_SQL} OR NOT (${OBSCURE_SPECIES_SQL} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}
         ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
        [userId, regionId, taxon, seaZoneIds, includeLand, hideObscure],
      );

      let items = res.rows.map(toCollectionItem);

      const stats = {
        total: items.length,
        collected: items.filter((i) => i.state === "collected").length,
        seen: items.filter((i) => i.state === "seen").length,
      };

      if (filter === "missing") items = items.filter((i) => i.state !== "collected");
      else if (filter === "collected") items = items.filter((i) => i.state === "collected");
      else if (filter === "seen") items = items.filter((i) => i.state === "seen");

      if (sort === "rarity") {
        items.sort((a, b) => (TIER_RANK[a.tier ?? "common"] ?? 5) - (TIER_RANK[b.tier ?? "common"] ?? 5));
      } else if (sort === "name") {
        items.sort((a, b) => (a.commonName ?? a.scientificName).localeCompare(b.commonName ?? b.scientificName));
      }

      return {
        region: {
          id: region.id,
          name: region.name,
          ebirdRegionCode: region.ebird_region_code,
          boundaryGeoJson: region.boundary_geojson,
          hasChildren: region.has_children,
          canDrillDown: (region.external_codes?.length ?? 0) > 0 && region.region_is_country_level,
        },
        stats,
        items,
      };
    },
  );

  // Count-only counterpart to GET /regions/:id/species — same species_ids/taxon/extinct
  // filtering, but skips the reference-photo/tier/rarity joins and per-row mapping the full
  // list needs, so the header can show a total on a region/taxon switch without waiting on
  // the full item list. Deliberately does NOT trigger computeRegionOccurrences if the region
  // isn't computed yet — that's still the full endpoint's job; this just reflects whatever's
  // already cached, so it never itself becomes a slow path.
  app.get<{
    Params: { id: string };
    Querystring: { taxon?: string; seaZoneIds?: string; includeLand?: string };
  }>(
    "/regions/:id/species/count",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: regionId } = request.params;
      const userId = request.user!.id;
      const taxon = request.query.taxon ?? null;
      const seaZoneIds = request.query.seaZoneIds ? request.query.seaZoneIds.split(",").filter(Boolean) : [];
      const includeLand = request.query.includeLand !== "0";
      const hideObscure = await getHideObscurePreference(userId);

      const regionRes = await pool.query(`SELECT id FROM regions WHERE id = $1`, [regionId]);
      if (!regionRes.rows[0]) return reply.code(404).send({ error: "Region not found" });

      const res = await pool.query<{ total: string; collected: string; seen: string }>(
        `WITH species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = $2 AND $5
           UNION
           SELECT species_id FROM sea_zone_species WHERE sea_zone_id = ANY($4)
         )
         SELECT
           count(*) AS total,
           count(*) FILTER (WHERE us.state = 'collected') AS collected,
           count(*) FILTER (WHERE us.state = 'seen') AS seen
         FROM species_ids si
         JOIN species s ON s.id = si.species_id
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id = $2
         LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
         LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
         WHERE ($3::text IS NULL OR s.taxon_class = $3) AND COALESCE(t.fully_extinct, false) = false
           AND ($6 = false OR ${ALREADY_OWNED_SQL} OR NOT (${OBSCURE_SPECIES_SQL} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}`,
        [userId, regionId, taxon, seaZoneIds, includeLand, hideObscure],
      );
      const row = res.rows[0];
      return { total: Number(row.total), collected: Number(row.collected), seen: Number(row.seen) };
    },
  );

  // Drill-down: create a country's provinces/states as child regions on demand, filtering
  // the already-cached Natural Earth admin-1 file (no network call) — only when a user
  // actually opens this country, not eagerly for all ~258 countries worldwide at seed time.
  app.post<{ Params: { id: string } }>("/regions/:id/drill-down", { preHandler: requireAuth }, async (request, reply) => {
    const { id: regionId } = request.params;

    const regionRes = await pool.query(`SELECT id, name, external_codes, has_children FROM regions WHERE id = $1`, [
      regionId,
    ]);
    const region = regionRes.rows[0];
    if (!region) return reply.code(404).send({ error: "Region not found" });
    if (region.has_children) return { ok: true, created: 0 };
    if (!region.external_codes?.length) {
      return reply.code(400).send({ error: "This region has no country code to drill down from" });
    }

    const provinces = await fetchProvincesForCountry(region.external_codes[0]);
    let created = 0;
    for (const province of provinces) {
      await pool.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (name, parent_id) DO NOTHING`,
        [
          province.name,
          regionId,
          province.iso3166_2 ? [province.iso3166_2] : [],
          province.iso3166_2 ?? null,
          JSON.stringify(province.feature),
        ],
      );
      created++;
    }
    await pool.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);

    return { ok: true, created };
  });
}

// Factored out of the /regions/:id/species lazy-compute block so it can also be called
// eagerly by a script (see scripts/prioritize-region.ts — North America prioritization),
// not just triggered by a user's first view of a region.
export async function computeRegionOccurrences(region: {
  id: string;
  boundary_geojson: { bbox?: [number, number, number, number]; geometry?: { type: string; coordinates: unknown } } | null;
  external_codes: string[] | null;
}): Promise<void> {
  const regionId = region.id;
  const code = region.external_codes![0];
  const fishKeys = await fetchFishTaxonKeys();
  // Switched from the land-polygon-only gadmGid match back to the broader `country` field
  // (landOnly=false) — gadmGid requires GBIF to have reverse-geocoded a record onto a real
  // land polygon, which needs actual GPS coordinates on the occurrence. A lot of real,
  // well-documented African freshwater fish data (older museum/ichthyological collections
  // especially) only has a textual country field, no coordinates — so Egypt's own native
  // Nile fish (Nile Perch, various catfish/tilapia, ~60 of them) were silently missing from
  // its own checklist despite being genuinely documented species already in this app's own
  // catalog. `country` alone would reintroduce reef fish that only border Egypt by sea, but
  // that's exactly what the marine cross-reference exclusion pass below already exists to
  // catch (with its own MARINE_EXCLUSION_MAX_NOISE_RECORDS safety valve, already proven not
  // to over-exclude globally-farmed species like tilapia) — so this doesn't need a second,
  // narrower filter of its own, just the wider net feeding the one that's already there.
  const [birdMammalCountsRaw, fishCountsRaw, marineMammalCounts] = await Promise.all([
    fetchSpeciesCountsForRegion(code, BIRD_MAMMAL_TAXON_KEYS),
    fetchSpeciesCountsForRegion(code, fishKeys, FISH_YEARS_WINDOW, false),
    // yearsWindow=null (all-time) rather than the default recent window — this query is only
    // ever used as an identity set ("is this gbifKey a Cetacea/Sirenia species"), not for a
    // count threshold, so it should catch every marine mammal ever recorded here, including
    // one whose only records predate the recent window — otherwise it could slip past this
    // exclusion and then get "rescued" back in by the below all-time recurrence pass anyway.
    fetchSpeciesCountsForRegion(code, MARINE_MAMMAL_ORDER_KEYS, null),
  ]);
  // See MARINE_MAMMAL_ORDER_KEYS's own comment — birdMammalCountsRaw already includes every
  // Cetacea/Sirenia species GBIF's country field caught in this region's waters (it's a
  // superset query); this second, narrower query exists only to know WHICH of those gbifKeys
  // are the obligate marine mammals, so they can be pulled back out before a land region's
  // default checklist ever sees them.
  const marineMammalGbifKeys = new Set(marineMammalCounts.map((c) => c.gbifKey));
  const birdMammalCounts = birdMammalCountsRaw.filter((c) => !marineMammalGbifKeys.has(c.gbifKey));
  // A fish with a SINGLE regional record is exactly the case where one lonely, often
  // decades/centuries-old museum type specimen (see looksTypeSpecimenOnly's own comment —
  // Acipenser carbonarius/Canada) can singlehandedly add a species that was never actually
  // found there. Widened from exactly 1 to GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS (see
  // looksLikeGeographicOutlier's own comment — Barrier Reef Anemonefish showed up in the Red
  // Sea off 3 records, not 1, from a single low-reliability citizen-science misidentification
  // that neither the type-specimen nor captive-locality checks are shaped to catch) rather
  // than every low-count fish, so this stays a handful of extra per-species GBIF calls per
  // region, not hundreds — FISH_MIN_RECORDS=1 means most permissively-included fish sit at
  // exactly this count anyway. Also widened (see ensureSeaZoneComputed's own comment) to
  // always scrutinize a rare-tier species with no reference photo at all, regardless of
  // record count — the most likely to be an undetected problem, and the most consequential
  // to get wrong.
  const fishCandidateGbifKeys = fishCountsRaw.map((c) => c.gbifKey);
  const fishScrutinyRes = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species s LEFT JOIN species_rarity r ON r.species_id = s.id
     WHERE s.gbif_key = ANY($1) AND s.reference_photo IS NULL AND r.tier IN ('epic', 'legendary', 'unrated')`,
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

  // Rather than guess at a habitat type (which breaks on salt
  // lakes — a landlocked salt lake fish would wrongly read as "marine"), a fish is
  // excluded from the country's own DEFAULT list only if it's ALSO demonstrably
  // present in a real nearby sea zone's own polygon-based checklist — reef fish that
  // only really belong to this country's territorial waters (now caught by the broader
  // `country` match above, see fishCountsRaw's own comment) get filtered back out here,
  // using the same real marine data the "include nearby water" toggle itself uses, not a
  // heuristic.
  const bbox = region.boundary_geojson?.bbox as [number, number, number, number] | undefined;
  const geometry = region.boundary_geojson?.geometry;
  const marineGbifKeys = new Set<number>();
  if (bbox && geometry && fishCounts.length > 0) {
    const regionBbox: BoundingBox = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
    const zones = await nearbyZones(regionBbox, exteriorRingsFromGeometry(geometry));
    for (const zone of zones) {
      const zoneRow = await pool.query<{ occurrence_computed_at: Date | null }>(
        `SELECT occurrence_computed_at FROM sea_zones WHERE id = $1`,
        [zone.id],
      );
      try {
        await ensureSeaZoneComputed(zone.id, zone.wkt, !!zoneRow.rows[0]?.occurrence_computed_at);
      } catch (err) {
        // Best-effort exclusion signal, not user-critical (see this function's own comment
        // on the exclusion logic) — one zone's GBIF call failing (a self-intersecting-
        // polygon bug in the Gulf of Mexico's geometry once crashed an entire overnight
        // enrichment run before this try/catch existed) should
        // never take down the whole region's computation, just skip that zone's contribution.
        console.error(`[computeRegionOccurrences] sea zone ${zone.name} failed, skipping:`, err);
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

  // "Also found in a nearby sea zone" is not, on its own, proof a fish's land-polygon records
  // are coastal noise — Nile Tilapia, Nile Perch, and African/Synodontis catfish are all
  // globally farmed/introduced species with real, separate populations in brackish coastal
  // water FAR from Egypt (Gulf of Mexico, the Caribbean, etc.) as well as their genuine native
  // Nile range; the naive "any overlap -> exclude" rule was stripping ~90 real Nile species
  // from Egypt's own checklist because of introductions on the other side of the planet. Only
  // treat the sea-zone signal as noise-evidence when the land record count itself is small
  // enough to plausibly BE noise (a handful of near-shore points spilling just inside the land
  // polygon) — a fish with dozens of its own land records is documented enough to keep
  // regardless of what else shares its gbifKey in a marine dataset.
  const MARINE_EXCLUSION_MAX_NOISE_RECORDS = 10;
  const filtered: RegionSpeciesCount[] = [
    ...birdMammalCounts.filter((c) => c.recordCount >= MIN_RECORDS),
    ...fishCounts.filter(
      (c) =>
        c.recordCount >= FISH_MIN_RECORDS &&
        !(marineGbifKeys.has(c.gbifKey) && c.recordCount <= MARINE_EXCLUSION_MAX_NOISE_RECORDS),
    ),
  ];

  // Recurrence rescue pass (see fetchYearCountsForSpecies/passesRecurrenceCheck's own
  // comments — this addresses cases like Northern Goshawk missing from BC's checklist)
  // — bird/mammal species the recent-window MIN_RECORDS threshold above excluded, but
  // which have SOME real
  // all-time presence, get one more check: do they turn up across several different years
  // with no single year dominating? If so they're a genuine sparse resident, not a vagrant
  // burst, and belong on the list. Only a modest number of species need this extra check
  // (whatever the window threshold excluded, not the whole checklist), so the extra
  // per-species GBIF call this costs stays bounded.
  const passedGbifKeys = new Set(filtered.map((c) => c.gbifKey));
  const [allTimeBirdMammalCountsRaw] = await Promise.all([fetchSpeciesCountsForRegion(code, BIRD_MAMMAL_TAXON_KEYS, null)]);
  // Same marine-mammal carve-out as birdMammalCounts above — otherwise a Red Sea dolphin
  // that failed the recent-window MIN_RECORDS threshold could get "rescued" right back onto
  // Egypt's land checklist via its real, but entirely marine, all-time record spread.
  const allTimeBirdMammalCounts = allTimeBirdMammalCountsRaw.filter((c) => !marineMammalGbifKeys.has(c.gbifKey));
  const rescueCandidates = allTimeBirdMammalCounts.filter(
    (c) => !passedGbifKeys.has(c.gbifKey) && c.recordCount >= RECURRENCE_ALLTIME_FLOOR,
  );
  for (const candidate of rescueCandidates) {
    const yearCounts = await fetchYearCountsForSpecies(code, candidate.gbifKey);
    if (!passesRecurrenceCheck(yearCounts)) continue;
    // Second check (see fetchRecordSampleForSpecies/looksCaptiveOnly's own comments — this
    // catches cases like Swinhoe's Pheasant "found" in Canada via Calgary Zoo/Hancock
    // Wildlife Centre specimens) — recurrence alone can't tell a genuine sparse resident from a
    // species whose only records are captive specimens spread across different years and
    // institutions, which looks identical by year-spread alone.
    const sample = await fetchRecordSampleForSpecies(code, candidate.gbifKey);
    if (looksCaptiveOnly(sample)) continue;
    filtered.push(candidate);
    passedGbifKeys.add(candidate.gbifKey);
  }

  // "Local tier" — the global species_rarity.tier stays fixed and
  // comparable between users, but weighting elusiveness by each country's total record
  // volume means a country with unusually heavy birding effort can skew a species'
  // GLOBAL score even when its OWN local numbers wouldn't suggest that. This ranks
  // species purely against each other within THIS region's own checklist instead, so
  // "how findable is this species HERE" never depends on birding effort anywhere else.
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
  // Real AVONET habitat-cover data, the same signal used for the global tier's
  // habitat-density boost.
  const habitatDensityByGbifKey = new Map(traitsRes.rows.map((r) => [Number(r.gbif_key), r.habitat_density]));
  // Domestic species (cattle, goats, sheep, etc.) never enter the local-tier ranking
  // pool — their local record counts measure how often people photograph farm animals
  // in this region, not how findable they are, so they're excluded from `filtered`
  // below and forced to "common" instead (same reasoning as the global tier fix, see
  // apply-rarity-phase4.ts).
  const domesticGbifKeys = new Set(traitsRes.rows.filter((r) => r.domestic).map((r) => Number(r.gbif_key)));

  // Real population ÷ real range = a genuine density signal, computed within this
  // region's own checklist just like the
  // record-count rank below — a species' population/range is a fixed trait, but
  // ranking it against only the species actually found here keeps this consistent
  // with "how findable is this species HERE," same as the rest of local tier.
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

  // For example, Costa's Hummingbird once read "uncommon" in BC despite being a single bird
  // chased/photographed by dozens of birders over ~10 days in Sept 2024: raw local record
  // count can't distinguish that from a genuinely-present
  // species recorded steadily over time — 294 records from one vagrant event and 294 from a
  // real resident look identical by count alone. Reuses the exact recurrence-check
  // machinery already built for the opposite problem (Northern Goshawk: real but SPARSE
  // resident, wrongly excluded) — here checked for every species already ON the checklist,
  // not just rescue candidates, since a burst can pass the raw MIN_RECORDS threshold outright
  // and look superficially common. A real, uncosted-until-now increase to region
  // computation: one extra GBIF year-facet call per species, same fetchWithRetry/backoff as
  // every other per-species call in this file.
  const wildFiltered = filtered.filter((c) => !domesticGbifKeys.has(c.gbifKey));
  // Fish never get the recurrence/vagrancy check at all — it's tuned around bird cases
  // (3+ distinct years) and runs against the same tiny land-only polygon fish are counted
  // in. For a small island (Antigua and Barb.: land area ~280km²), a real, permanent reef
  // resident's occurrences are almost all just offshore — only a sliver of GBIF points
  // (geolocation noise) ever fall inside the literal land polygon, so it rarely reaches 3
  // distinct years and gets wrongly flagged vagrant (89% of Antigua's fish, vs. 0% for every
  // other Caribbean country in this dataset, where a bigger land polygon "catches" enough
  // points regardless). Fish already get a deliberately permissive inclusion bar for the same
  // sparse-citizen-science reason (FISH_MIN_RECORDS=1, no year window) — applying a strict
  // bird-tuned check on top of that permissive inclusion was never consistent to begin with.
  const fishGbifKeys = new Set(fishCounts.map((c) => c.gbifKey));
  const yearConcentrationByGbifKey = new Map<number, number>();
  const isVagrantByGbifKey = new Map<number, boolean>();
  // Batched — a fixed, small number of calls (one facet=speciesKey per year in the window,
  // see fetchYearlyRecordCounts's own comment) covering every bird/mammal species on the
  // checklist at once, instead of one live GBIF call per already-included species. This was
  // the actual bottleneck making region computation take a very long time under GBIF's rate
  // limits — hundreds of sequential per-species calls for a well-recorded region.
  const yearlyCountsByGbifKey = await fetchYearlyRecordCounts(code, BIRD_MAMMAL_TAXON_KEYS);
  for (const c of wildFiltered) {
    if (fishGbifKeys.has(c.gbifKey)) {
      isVagrantByGbifKey.set(c.gbifKey, false);
      continue;
    }
    const yearCounts = yearlyCountsByGbifKey.get(c.gbifKey) ?? [];
    const total = yearCounts.reduce((sum, y) => sum + y.count, 0);
    const isVagrant = total > 0 && !passesRecurrenceCheck(yearCounts);
    isVagrantByGbifKey.set(c.gbifKey, isVagrant);
    // How concentrated into a single year, continuous (0 = spread evenly, 1 = literally
    // every record from one year) — a species that JUST misses the recurrence bar (maxShare
    // 0.51) shouldn't get shoved to "legendary" as hard as one that's 100% one event.
    const maxShare = total > 0 ? Math.max(...yearCounts.map((y) => y.count)) / total : 0;
    if (isVagrant) yearConcentrationByGbifKey.set(c.gbifKey, maxShare);
  }

  // Base score from record-count rank (0 = most-recorded/easiest here, 1 = rarest
  // here), then nocturnal + low-density species (real EltonTraits/Callaghan-et-al.
  // data, not a guess — see compute-rarity-phase1.ts) get boosted before tiers are
  // assigned, not after, so re-ranking by the boosted score still means something for
  // the tier shares. Domestic species are excluded from this ranking pool entirely
  // (see above) — their own record counts would be meaningless noise in it either way.
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
  const sortedByBoostedScore = [...boostedScores].sort((a, b) => b.score - a.score);
  const localTierByGbifKey = new Map<number, string>();
  const localN = sortedByBoostedScore.length;
  sortedByBoostedScore.forEach((row, idx) => {
    // idx 0 = highest boosted score (rarest here) -> smallest percentile -> legendary.
    localTierByGbifKey.set(row.gbifKey, tierForPercentile((idx + 1) / localN));
  });

  // Local tier ranks purely by in-region record-count percentile, which can badly
  // undersell a species that's globally hard to find but happens to have decent record
  // density HERE specifically — Whooping Crane (globally "rare", ~500-800 birds worldwide)
  // reads "common" in Canada purely because it's so intensively conservation-monitored that
  // its sparse population still generates thousands of records; Wolverine (globally
  // "legendary") read "uncommon" in Canada the same way. A region genuinely CAN be the best
  // place on Earth to find something without that species stopping being globally rare, so
  // local tier is allowed to read up to LOCAL_TIER_GLOBAL_FLOOR_STEPS easier than the global
  // tier (rewarding "this is comparatively the spot for it") but never further than that —
  // "easier to find here" should never mean "not actually rare," just "less rare than usual."
  const LOCAL_TIER_GLOBAL_FLOOR_STEPS = 1;
  const TIER_ORDER = ["legendary", "epic", "rare", "uncommon", "common"];
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
    const flooredRank = Math.min(localRank, globalRank + LOCAL_TIER_GLOBAL_FLOOR_STEPS);
    if (flooredRank !== localRank) localTierByGbifKey.set(gbifKey, TIER_ORDER[flooredRank]);
  }

  for (const gbifKey of domesticGbifKeys) localTierByGbifKey.set(gbifKey, "common");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // A species that no longer clears the threshold (e.g. after a threshold/logic
    // retune — such as Anhinga being removed from Canada's checklist) must actually
    // disappear, not just sit un-updated forever — the old insert-only loop below never deleted
    // anything, so a stale row would never leave once written.
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
    await client.query(`UPDATE regions SET occurrence_computed_at = now() WHERE id = $1`, [regionId]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
