import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { requireAuth } from "../auth/session.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import { MEDIA_CACHE_BUST } from "../config.js";
import {
  obscureSpeciesSql,
  REGION_VAGRANT_SQL,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  NOT_REGION_HIDDEN_SQL,
  getObscurityPreferences,
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
  RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN,
  medianOf,
  type RegionSpeciesCount,
} from "data-pipeline/src/build/build-region-species.js";
import { fetchProvincesForCountry, fetchAllCountries } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { AVES_CLASS_KEY, MAMMALIA_CLASS_KEY } from "data-pipeline/src/fetch/fetch-gbif-backbone.js";
import { fetchFishTaxonKeys } from "data-pipeline/src/fetch/fetch-fish-orders.js";
import { matchedSpeciesIdsForRegion, resolveRemovalRescues } from "../scripts/inatChecklist.js";
import { NO_RARITY_TIER_TAXON_CLASSES, type TaxonClass } from "@lifer/shared";
import {
  bboxesNear,
  bboxContains,
  bboxDiagonalDegrees,
  SMALL_ISLAND_MAX_BBOX_DIAGONAL_DEGREES,
  minRingDistance,
  closestPointBetweenRings,
  pointInAnyRing,
  exteriorRingsFromGeometry,
  parseWktPolygonRing,
  type BoundingBox,
  type Point,
} from "data-pipeline/src/geometry.js";
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

// The requested region's own COUNTRY's exterior rings — for the land-mask check in
// nearbyZones (see its own comment). Mirrors resolvePackRegionName's own "no external_codes on
// the parent means THIS region already is the country" logic, just resolving real boundary
// geometry instead of a name. Returns null for a region with no resolvable country (shouldn't
// happen for any real country/province row, but callers treat null as "skip the land-mask
// check" rather than failing the whole request over it).
async function resolveCountryRings(regionId: string): Promise<Point[][] | null> {
  const res = await pool.query<{
    geometry: { type: string; coordinates: unknown } | null;
    parent_id: string | null;
    parent_external_codes: string[] | null;
  }>(
    `SELECT r.boundary_geojson->'geometry' AS geometry, r.parent_id, p.external_codes AS parent_external_codes
     FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  // This region itself is already the country (its parent is a continent/World, no code of
  // its own) — use its own geometry rather than looking one level up.
  if (!row.parent_external_codes?.length) return row.geometry ? exteriorRingsFromGeometry(row.geometry) : null;
  const parentRes = await pool.query<{ geometry: { type: string; coordinates: unknown } | null }>(
    `SELECT boundary_geojson->'geometry' AS geometry FROM regions WHERE id = $1`,
    [row.parent_id],
  );
  const geometry = parentRes.rows[0]?.geometry;
  return geometry ? exteriorRingsFromGeometry(geometry) : null;
}

// A generous bbox pre-filter (cheap, avoids computing real point-distance against all ~139
// zones every time) followed by a real point-to-point distance check with a much tighter
// threshold — a bbox-only check is wrong for large/irregular seas: Egypt's bbox spuriously
// "overlapped" the Ionian Sea's (612km away) and Aegean Sea's (545km away) bounding boxes
// even though their real coastlines are nowhere close, while its genuine neighbors
// (Mediterranean/Red Sea/Gulf of Suez/Gulf of Aqaba) all measured 0-1km.
//
// 2 degrees (~220km) turned out far too loose once tested against landlocked North American
// provinces/states: MEOW's own ecoregion polygons are coarse, generalized shapes that don't
// tightly hug the real coastline (confirmed against the raw shapefile — "Puget Trough/Georgia
// Basin"'s actual published boundary genuinely extends past Spokane, WA), so a 2° cutoff
// falsely matched Alberta (193km from Puget Trough), Idaho (201km), Kentucky (152km), Utah
// (157km), and several more. 0.4 degrees (~44km) was chosen as the tightest threshold that
// still keeps every CONFIRMED real match (Manitoba/Hudson Complex measured 35km) while
// excluding all of the above.
//
// This is NOT a complete fix: raw point-set distance has no notion of "a whole other country's
// landmass sits in between" — Arizona (7km from Cortezian/the Gulf of California, but actually
// separated from it by Mexico) and West Virginia (6km from the Virginian ecoregion, but never
// reaching the Atlantic) both measured CLOSER than Manitoba's real 35km match, so no single
// threshold can include one and exclude the others. Properly fixing those remaining cases
// needs a genuine land-mask/intervening-territory check, not just a tighter number here.
const BBOX_PREFILTER_BUFFER_DEGREES = 10;
const NEARBY_MAX_DISTANCE_DEGREES = 0.4;

// How close the zone's own closest point needs to sit to the country's boundary to count as
// "actually on this country's coastline" — not 0, since the country polygon here is itself
// independently simplified (see fetch-region-boundary.ts) and pointInRing is an exact test, a
// coastal point sitting fractionally outside the simplified country ring due to that shouldn't
// fail the check. Small next to NEARBY_MAX_DISTANCE_DEGREES on purpose — this is a tolerance
// for simplification noise, not a second "how far away is still nearby" threshold.
const COUNTRY_COASTLINE_TOLERANCE_DEGREES = 0.05;

export async function nearbyZones(
  regionBbox: BoundingBox,
  regionRings: Point[][],
  // The REGION's own country's exterior ring(s) — optional (some callers, e.g. the archived
  // one-off backfill script, don't have this handy) but strongly recommended: without it, nearby
  // water is verified with raw point-set distance only, which has no notion of "a whole other
  // country's landmass sits in between." Confirmed via real cases: Arizona measured 7km from
  // the Cortezian ecoregion (the Gulf of California) — closer than Manitoba's genuine 35km
  // match to Hudson Bay — even though Arizona is landlocked and Mexico's own Sonora coastline
  // is what's actually 7km away, not Arizona's. Passing the country's rings lets this reject
  // that: the zone's closest point has to actually fall on/near the SAME country's coastline
  // the region belongs to, not just be geometrically nearby in the abstract.
  countryRings?: Point[][],
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
    const { distance, point: closestZonePoint } = closestPointBetweenRings(regionRings, [zoneRing]);
    if (distance > NEARBY_MAX_DISTANCE_DEGREES) return false;
    if (!countryRings) return true;
    // The zone's closest approach has to actually BE this country's coastline — either
    // literally inside its landmass polygon (a river mouth/inlet the zone polygon reaches
    // into) or within simplification tolerance of its boundary ring, not just nearby in the
    // abstract with no regard for whose territory is actually adjacent there.
    return pointInAnyRing(closestZonePoint, countryRings) || minRingDistance([[closestZonePoint]], countryRings) <= COUNTRY_COASTLINE_TOLERANCE_DEGREES;
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


// Packs are only ever built at country level (bundling every province inside), so a downloaded
// pack's own `downloaded_packs.region` value is always a country name — resolves regionId
// (which might be that country itself, or one of its provinces) up to whichever one that is.
async function resolvePackRegionName(regionId: string): Promise<string | null> {
  const res = await pool.query<{ name: string; parent_id: string | null; parent_external_codes: string[] | null }>(
    `SELECT r.name, r.parent_id, p.external_codes AS parent_external_codes
     FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  // Parent has no external codes (a continent/World, purely organizational) means THIS region
  // is itself the country. Otherwise the parent IS a country, and this region is one of its
  // provinces — the province's own name never appears in downloaded_packs.
  if (!row.parent_external_codes?.length) return row.name;
  const parentRes = await pool.query<{ name: string }>(`SELECT name FROM regions WHERE id = $1`, [row.parent_id]);
  return parentRes.rows[0]?.name ?? null;
}

// A species/region row existing in region_species does NOT by itself mean its pack was ever
// downloaded — a portable catalog seed (see desktop's embedded_db.rs) brings over the WHOLE
// region_species table up front, across every taxon, purely so there's something to browse
// before any pack is downloaded at all. Packs are taxon-split (Canada's birds pack is separate
// from its fish pack) — downloading only birds+mammals for a country must not also surface
// fish that were only ever in the catalog seed, never actually downloaded. NULL (no packs
// tracked, or this region isn't under any tracked country) means nothing is available yet —
// callers should treat that as "show nothing" via the returned SQL fragment's own false-y NULL
// behavior, not "show everything."
// Other Taxa species (s.is_other_taxa) have no pack concept at all — no pack is ever built for
// "other-taxa", so without this carve-out one would only ever pass this check by accident (a
// user who happens to have an all-taxa pack downloaded for that region), staying invisible on
// this region's own checklist despite being manually, deliberately added to it.
const TAXON_PACK_DOWNLOADED_SQL = `(
  s.is_other_taxa = true OR EXISTS (
    SELECT 1 FROM downloaded_packs dp WHERE dp.region = $7 AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class)
  )
)`;

export async function regionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/regions", { preHandler: requireAuth }, async () => {
    // boundary_geojson deliberately excluded — a real Natural Earth polygon per region, easily
    // hundreds of KB each, and nothing here ever reads it: CollectionPage's allRegions only
    // uses id/name/parentId/hasChildren/hasScopedChecklist for tree building and lookups; the
    // actual map renders from regionMeta.boundaryGeoJson, the ONE region's own copy returned by
    // GET /regions/:id/species below. Pulling and serializing all ~300 regions' full polygons
    // on every app load for data nothing uses was most of this endpoint's own latency.
    const res = await pool.query(
      // USNB Guantanamo Bay ("USG") excluded — it's a small leased naval base with no civilian
      // access, not a real photography destination like Puerto Rico or the Galapagos, and its
      // Cuba-vs-US sovereignty distinction (see migration 066's own comment) isn't a useful one
      // to surface here even though Natural Earth's data models it correctly.
      `SELECT id, name, parent_id, ebird_region_code, has_children, external_codes, sovereignty_group, is_sovereign_dependency
       FROM regions WHERE external_codes[1] IS DISTINCT FROM 'USG' ORDER BY parent_id NULLS FIRST, name`,
    );
    return {
      regions: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        parentId: r.parent_id,
        ebirdRegionCode: r.ebird_region_code,
        boundaryGeoJson: null,
        hasChildren: r.has_children,
        hasScopedChecklist: (r.external_codes?.length ?? 0) > 0,
        // Country-level only (null for World/continents/provinces) — see migration 065's own
        // comment. Lets the picker group a country with its own geographically-separate
        // territories (Puerto Rico under "United States of America", New Caledonia under
        // "France") without a second, hand-curated continent mapping.
        sovereigntyGroup: r.sovereignty_group,
        // Country-level only — see migration 066's own comment.
        isSovereignDependency: r.is_sovereign_dependency,
      })),
    };
  });

  // Every country's own boundary polygon at once, for the offline-packs map picker — GET
  // /regions above deliberately EXCLUDES boundary_geojson for every other caller's sake (see
  // its own comment: hundreds of KB per region, nothing else reads it). This is the one real
  // caller that needs all of them simultaneously, so it gets its own endpoint rather than
  // reopening that endpoint's fast/small contract for everyone else. Country-level only (not
  // provinces) — external_codes[1] matching a bare 3-letter code (no dot, not a WKT polygon
  // string) is exactly how gbifRegionParam/compute-all-regions-bulk.ts already distinguish a
  // country row from a province row elsewhere in this codebase.
  app.get<{ Querystring: { level?: string } }>("/regions/boundaries", { preHandler: requireAuth }, async (request, reply) => {
    if (request.query.level && request.query.level !== "country") {
      return reply.code(400).send({ error: 'only level=country is supported' });
    }
    const res = await pool.query<{ id: string; name: string; parent_id: string | null; boundary_geojson: unknown }>(
      // USG (USNB Guantanamo Bay) excluded — see GET /regions's own comment above.
      `SELECT id, name, parent_id, boundary_geojson FROM regions
       WHERE external_codes IS NOT NULL AND array_length(external_codes, 1) > 0
         AND external_codes[1] ~ '^[A-Z]{3}$' AND external_codes[1] != 'USG' AND boundary_geojson IS NOT NULL`,
    );
    return {
      regions: res.rows.map((r) => ({ id: r.id, name: r.name, parentId: r.parent_id, boundaryGeoJson: r.boundary_geojson })),
    };
  });

  // Which taxon groups a set of regions actually has ANY species in, for the offline-packs
  // download picker to hide a taxon pill that would just download zero species (e.g. no
  // "Crocodilians" pill for Canada) — while still showing it if ANY other selected region has
  // it (the frontend unions this response across every selected region itself; this endpoint
  // just answers per-region, once, in a single batched query rather than per-taxon-per-region
  // round trips). Answers "does this taxon exist at all for this region" from the region's own
  // seeded checklist — a broader signal than "is this taxon's pack downloaded" (see
  // TAXON_PACK_DOWNLOADED_SQL's own comment on that distinction), which is exactly what's
  // wanted here: deciding whether a DOWNLOAD option makes sense, not whether one's already
  // been exercised.
  app.get<{ Querystring: { regionIds?: string } }>("/regions/taxon-presence", { preHandler: requireAuth }, async (request, reply) => {
    const regionIds = request.query.regionIds?.split(",").filter(Boolean) ?? [];
    if (regionIds.length === 0) return reply.code(400).send({ error: "regionIds is required" });
    // Same Other Taxa rollup as GET /regions/:id/species (see its own comment) — an Other
    // Taxa species added at a province only ever gets ONE region_species row, at that exact
    // province, so a plain exact-region match here left the "Insects"-style filter pill
    // missing whenever this same species was actually being shown (via that endpoint's own
    // rollup) while browsing the country or continent above it. `root_region_id` tracks which
    // originally-requested region each row's rollup came from, so a country's map back to
    // itself, not to whichever descendant province the species happened to be added under.
    const res = await pool.query<{ root_region_id: string; taxon_class: string }>(
      `WITH RECURSIVE region_tree AS (
         SELECT id, id AS root_region_id FROM regions WHERE id = ANY($1)
         UNION ALL
         SELECT r.id, rt.root_region_id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
       )
       SELECT DISTINCT root_region_id, taxon_class FROM (
         -- Exact requested region: every taxon, same as before.
         SELECT rt.root_region_id, s.taxon_class
         FROM region_tree rt
         JOIN region_species rs ON rs.region_id = rt.id
         JOIN species s ON s.id = rs.species_id
         WHERE rt.id = rt.root_region_id
         UNION ALL
         -- A DESCENDANT region: only Other Taxa species roll up — a real taxon's own checklist
         -- is independently computed at every level already, so bubbling a province's real-taxa
         -- presence up to its country here would incorrectly offer filter pills (e.g. a taxon
         -- the country pack itself was never actually given). Kept as its own UNION branch
         -- (not one OR'd join condition) so each branch can use its own index — an OR here
         -- forced Postgres to hash/seq-scan the entire species table on every request.
         SELECT rt.root_region_id, s.taxon_class
         FROM region_tree rt
         JOIN region_species rs ON rs.region_id = rt.id
         JOIN species s ON s.id = rs.species_id AND s.is_other_taxa = true
         WHERE rt.id != rt.root_region_id
       ) combined`,
      [regionIds],
    );
    const byRegion: Record<string, string[]> = {};
    for (const id of regionIds) byRegion[id] = [];
    for (const row of res.rows) byRegion[row.root_region_id]?.push(row.taxon_class);
    return byRegion;
  });

  // Surfaces nearby sea zones as checkbox options (species counts themselves come from each
  // zone's real polygon via fetchSpeciesCountsForZone). Reads the precomputed
  // regions.nearby_sea_zone_ids (migration 052, backfill-nearby-sea-zones.ts) rather than
  // running nearbyZones' real ring-distance geometry live — that's CPU-bound enough on a large
  // coastline to block the event loop for other requests, and it's a pure function of static
  // data that never changes at runtime anyway. NULL (pre-migration-052 pack) falls back to the
  // old live computation once, rather than showing zero options.
  app.get<{ Params: { id: string } }>("/regions/:id/sea-zones", { preHandler: requireAuth }, async (request, reply) => {
    const { id: regionId } = request.params;
    const regionRes = await pool.query<{
      boundary_geojson: { bbox?: number[]; geometry?: { type: string; coordinates: unknown } } | null;
      nearby_sea_zone_ids: string[] | null;
    }>(`SELECT boundary_geojson, nearby_sea_zone_ids FROM regions WHERE id = $1`, [regionId]);
    const region = regionRes.rows[0];
    if (!region) return reply.code(404).send({ error: "Region not found" });

    let zoneIds = region.nearby_sea_zone_ids;
    if (zoneIds == null) {
      const bbox = region.boundary_geojson?.bbox as [number, number, number, number] | undefined;
      const geometry = region.boundary_geojson?.geometry;
      if (!bbox || !geometry) return { zones: [] };
      const regionBbox: BoundingBox = { minLon: bbox[0], minLat: bbox[1], maxLon: bbox[2], maxLat: bbox[3] };
      const countryRings = await resolveCountryRings(regionId);
      const zones = await nearbyZones(regionBbox, exteriorRingsFromGeometry(geometry), countryRings ?? undefined);
      zoneIds = zones.map((z) => z.id);
      await pool.query(`UPDATE regions SET nearby_sea_zone_ids = $1 WHERE id = $2`, [zoneIds, regionId]);
    }
    if (zoneIds.length === 0) return { zones: [] };
    const namesRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM sea_zones WHERE id = ANY($1)`, [
      zoneIds,
    ]);
    return { zones: namesRes.rows };
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
      const taxon = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);
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

      const packRegionName = await resolvePackRegionName(regionId);

      // Same per-user state computation as GET /collection (see collectionItem.ts) — collected
      // if a capture exists, seen if eBird-imported without a photo, else unseen. Species
      // ids come from a UNION of this region's own checklist AND (when a sea zone checkbox
      // is active) the zone's checklist — a species can be in both, hence UNION not
      // UNION ALL. Sea-zone-only species get local_tier = NULL (LEFT JOINed from
      // region_species, which won't have a row for them) rather than a fabricated
      // region-scoped rarity: "local tier" specifically means "ranked against this region's
      // OTHER species," and a Red-Sea reef fish was never ranked against Egypt's checklist.
      const res = await pool.query(
        `WITH RECURSIVE region_tree AS (
           SELECT id FROM regions WHERE id = $2
           UNION ALL
           SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         ),
         species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = $2 AND $5
           -- An Other Taxa species has no pack/rollup story of its own — its region_species
           -- row exists ONLY at whichever single region it happened to be added at (see
           -- POST /species/other-taxa), unlike a real taxon's checklist, which every
           -- ancestor region gets its OWN independently-computed pack for. Without this,
           -- an Other Taxa species added while browsing a province never showed up again
           -- once the user backed out to view the country (or continent/world) it belongs
           -- to — checking the whole region_tree (this region and all its descendants),
           -- not just an exact region_id match, is what makes that rollup work. A separate
           -- UNION branch (not folded into the exact-match WHERE above via OR) so each side
           -- can use its own index — an OR'd join condition here previously defeated the
           -- region_species(region_id) index entirely, forcing a multi-hundred-ms sequential
           -- scan of the whole table on every single region view.
           UNION
           SELECT rs.species_id FROM region_species rs
           JOIN species sp ON sp.id = rs.species_id
           WHERE sp.is_other_taxa = true AND rs.region_id IN (SELECT id FROM region_tree)
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
           s.is_other_taxa,
           s.inat_iconic_taxon,
           r.tier,
           rs.local_tier,
           rs.is_vagrant,
           rs.seasonality,
           t.endemic_country_iso3,
           t.endemic_region_label,
           t.occurrence_count,
           t.last_occurrence_year,
           t.depth_min_m,
           us.state,
           us.is_target,
           us.was_ghost_when_collected,
           us.was_lost_when_collected,
           us.cover_photo_id,
           us.card_crop_x,
           us.card_crop_y,
           us.card_crop_size,
           p.thumb_path IS NOT NULL AS has_cover_photo,
           sv.label AS cover_volume_label,
           (SELECT array_agg(DISTINCT EXTRACT(YEAR FROM cy.taken_at)::int)
              FROM captures cy WHERE cy.user_id = $1 AND cy.species_id = s.id AND cy.taken_at IS NOT NULL) AS captured_years
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
         LEFT JOIN region_species_hidden rsh ON rsh.user_id = $1 AND rsh.species_id = s.id AND rsh.region_id = $2
         WHERE (($3::text[] IS NULL) OR ($3 @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY($3)) AND COALESCE(t.fully_extinct, false) = false
           AND ($6 = false OR ${ALREADY_OWNED_SQL} OR NOT (${obscureSpeciesSql(maxDepthM)} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}
           AND ${NOT_REGION_HIDDEN_SQL}
           AND (rs.region_id IS NULL OR ${TAXON_PACK_DOWNLOADED_SQL})
         ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
        [userId, regionId, taxon, seaZoneIds, includeLand, hideObscure, packRegionName],
      );

      let items = res.rows.map((row) => toCollectionItem(row, maxDepthM));

      // Distinguishes "this taxon genuinely has nothing here" from "this taxon's pack just
      // isn't downloaded" for the UI's own prompt — only relevant when a SINGLE specific taxon
      // was requested (the checkbox multi-select still allows several at once, e.g. Birds +
      // Mammals, but there's no single coherent "pack missing" screen to show for a mixed
      // selection — that view only ever makes sense pointed at one taxon); region_species
      // existing at all (regardless of taxon) already means the region overall has some pack
      // (see the needsPack check above), so this only asks whether THIS ONE taxon is covered.
      let taxonPackMissing = false;
      if (taxon?.length === 1 && packRegionName) {
        const taxonPackRes = await pool.query<{ exists: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM downloaded_packs WHERE region = $1 AND (taxon IS NULL OR taxon = $2)
           ) AS exists`,
          [packRegionName, taxon[0]],
        );
        taxonPackMissing = !taxonPackRes.rows[0]?.exists;
      }

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
        taxonPackMissing,
      };
    },
  );

  // World and every continent are purely organizational hubs (no GADM code, no scoped
  // checklist of their own — see regionKnownHub's comment on the frontend) — landing on one
  // used to mean nothing but a "pick a country" dead end, even though the whole point of
  // zooming back out is often to see everything collected/available across the countries
  // already downloaded underneath it. This unions those countries' own checklists instead of
  // requiring a single scoped region, deliberately restricted to DOWNLOADED countries only —
  // same "only show what's actually installed" rule the rest of this file already follows.
  app.get<{
    Params: { id: string };
    Querystring: { taxon?: string };
  }>(
    "/regions/:id/aggregate-species",
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id: hubId } = request.params;
      const userId = request.user!.id;
      const taxon = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const hubRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE id = $1`, [hubId]);
      const hub = hubRes.rows[0];
      if (!hub) return reply.code(404).send({ error: "Region not found" });

      // Covers both a continent (countries are direct children) and World (countries are
      // grandchildren, via each continent) in one query — a continent itself never has a
      // downloaded_packs row (packs are always country-named), so the EXISTS check alone
      // naturally excludes continents from this list when hubId is World.
      const countriesRes = await pool.query<{ id: string; name: string }>(
        `SELECT DISTINCT r.id, r.name
         FROM regions r
         WHERE (r.parent_id = $1 OR r.parent_id IN (SELECT id FROM regions WHERE parent_id = $1))
           AND EXISTS (SELECT 1 FROM downloaded_packs dp WHERE dp.region = r.name)
         ORDER BY r.name`,
        [hubId],
      );
      const countryIds = countriesRes.rows.map((r) => r.id);
      const countryNames = countriesRes.rows.map((r) => r.name);

      if (countryIds.length === 0) {
        return { items: [], downloadedCountryNames: [] };
      }

      // DISTINCT ON (s.id) collapses a species present in more than one downloaded country
      // down to a single row — which specific country's local_tier/is_vagrant it keeps is
      // arbitrary (whichever sorts first after preferring a non-null tier), acceptable here
      // since this view's whole point is "everything available across these countries," not a
      // single region's own ranked checklist.
      const res = await pool.query(
        `WITH RECURSIVE region_tree AS (
           SELECT id FROM regions WHERE id = ANY($2)
           UNION ALL
           SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         ),
         species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = ANY($2)
           -- Same Other Taxa rollup as GET /regions/:id/species (see its own comment, including
           -- why this is a separate UNION branch rather than one OR'd condition) — a province-
           -- level Other Taxa addition under one of these downloaded countries should still
           -- surface in this World/continent aggregate view.
           UNION
           SELECT rs.species_id FROM region_species rs
           JOIN species sp ON sp.id = rs.species_id
           WHERE sp.is_other_taxa = true AND rs.region_id IN (SELECT id FROM region_tree)
         )
         SELECT DISTINCT ON (s.id)
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
           s.is_other_taxa,
           s.inat_iconic_taxon,
           r.tier,
           rs.local_tier,
           rs.is_vagrant,
           rs.seasonality,
           t.endemic_country_iso3,
           t.endemic_region_label,
           t.occurrence_count,
           t.last_occurrence_year,
           t.depth_min_m,
           us.state,
           us.is_target,
           us.was_ghost_when_collected,
           us.was_lost_when_collected,
           us.cover_photo_id,
           us.card_crop_x,
           us.card_crop_y,
           us.card_crop_size,
           p.thumb_path IS NOT NULL AS has_cover_photo,
           sv.label AS cover_volume_label,
           (SELECT array_agg(DISTINCT EXTRACT(YEAR FROM cy.taken_at)::int)
              FROM captures cy WHERE cy.user_id = $1 AND cy.species_id = s.id AND cy.taken_at IS NOT NULL) AS captured_years
         FROM species_ids si
         JOIN species s ON s.id = si.species_id
         -- region_id = ANY($2) (countries only) matched a plain species fine, but a province-
         -- level Other Taxa row (see species_ids' own UNION branch above) never lives on a
         -- country id at all, so this join always missed it -- local_tier/is_vagrant/seasonality
         -- silently came back null for every rolled-up Other Taxa species even though its real
         -- region_species row exists. Matching against the whole region_tree (same set
         -- species_ids already rolls up from) finds it; DISTINCT ON (s.id) below already exists
         -- to arbitrarily pick one row for a species present in more than one place, same as any
         -- other multi-region species this view aggregates.
         LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id IN (SELECT id FROM region_tree)
         LEFT JOIN species_rarity r ON r.species_id = s.id
         LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN user_species us ON us.user_id = $1 AND us.species_id = s.id
         LEFT JOIN photos p ON p.id = us.cover_photo_id
         LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
         LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
         LEFT JOIN user_archived_species uas ON uas.user_id = $1 AND uas.species_id = s.id
         LEFT JOIN region_species_hidden rsh ON rsh.user_id = $1 AND rsh.species_id = s.id AND rsh.region_id = rs.region_id
         WHERE (($3::text[] IS NULL) OR ($3 @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY($3)) AND COALESCE(t.fully_extinct, false) = false
           AND ($4 = false OR ${ALREADY_OWNED_SQL} OR NOT (${obscureSpeciesSql(maxDepthM)} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}
           AND ${NOT_REGION_HIDDEN_SQL}
           AND EXISTS (SELECT 1 FROM downloaded_packs dp WHERE dp.region = ANY($5) AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class))
         ORDER BY s.id, (rs.local_tier IS NULL), s.scientific_name`,
        [userId, countryIds, taxon, hideObscure, countryNames],
      );

      const items = res.rows.map((row) => toCollectionItem(row, maxDepthM));
      return { items, downloadedCountryNames: countryNames };
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
      const taxon = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const seaZoneIds = request.query.seaZoneIds ? request.query.seaZoneIds.split(",").filter(Boolean) : [];
      const includeLand = request.query.includeLand !== "0";
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const regionRes = await pool.query(`SELECT id FROM regions WHERE id = $1`, [regionId]);
      if (!regionRes.rows[0]) return reply.code(404).send({ error: "Region not found" });

      const packRegionName = await resolvePackRegionName(regionId);

      const res = await pool.query<{ total: string; collected: string; seen: string }>(
        `WITH RECURSIVE region_tree AS (
           SELECT id FROM regions WHERE id = $2
           UNION ALL
           SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         ),
         species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = $2 AND $5
           UNION
           SELECT rs.species_id FROM region_species rs
           JOIN species sp ON sp.id = rs.species_id
           WHERE sp.is_other_taxa = true AND rs.region_id IN (SELECT id FROM region_tree)
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
         LEFT JOIN region_species_hidden rsh ON rsh.user_id = $1 AND rsh.species_id = s.id AND rsh.region_id = $2
         WHERE (($3::text[] IS NULL) OR ($3 @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY($3)) AND COALESCE(t.fully_extinct, false) = false
           AND ($6 = false OR ${ALREADY_OWNED_SQL} OR NOT (${obscureSpeciesSql(maxDepthM)} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}
           AND ${NOT_REGION_HIDDEN_SQL}
           AND (rs.region_id IS NULL OR ${TAXON_PACK_DOWNLOADED_SQL})`,
        [userId, regionId, taxon, seaZoneIds, includeLand, hideObscure, packRegionName],
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
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson, is_overseas_territory, subdivision_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (name, parent_id) DO NOTHING`,
        [
          province.name,
          regionId,
          province.iso3166_2 ? [province.iso3166_2] : [],
          province.iso3166_2 ?? null,
          JSON.stringify(province.feature),
          province.isOverseasTerritory,
          province.type,
        ],
      );
      created++;
    }
    await pool.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);

    return { ok: true, created };
  });

  // Region-scoped species archive (migration 100) — hides a species from ONE region's checklist
  // (e.g. a vagrant entry a user doesn't want cluttering that region) without touching its
  // global record or its presence on any other region's checklist. Deliberately separate from
  // POST/DELETE /species/:id/archive, which hides a species everywhere.
  app.post<{ Params: { regionId: string; speciesId: string } }>(
    "/regions/:regionId/species/:speciesId/hide",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      const regionRes = await pool.query<{ id: string; sovereignty_group: string | null }>(
        `SELECT id, sovereignty_group FROM regions WHERE id = $1`,
        [regionId],
      );
      if (regionRes.rows.length === 0) return reply.code(404).send({ error: "Region not found" });
      await pool.query(
        `INSERT INTO region_species_hidden (user_id, region_id, species_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [userId, regionId, speciesId],
      );
      // Hiding at the country level cascades to every direct child province too — a country
      // hide is meant to mean "I don't want to see this anywhere in this country," and without
      // this, unhiding is the only place that actually behaved that way (this asymmetry is
      // deliberate per the user's own framing: hide cascades automatically, unhide asks first —
      // hiding is easy to undo from the Hidden species page, so there's no harm defaulting wide).
      if (regionRes.rows[0].sovereignty_group != null) {
        await pool.query(
          `INSERT INTO region_species_hidden (user_id, region_id, species_id)
           SELECT $1, id, $2 FROM regions WHERE parent_id = $3
           ON CONFLICT DO NOTHING`,
          [userId, speciesId, regionId],
        );
      }
      return { ok: true };
    },
  );

  // Direct child regions (provinces) that already have their OWN hide row for this species —
  // used by the Hidden species page to ask "unhide from these too?" before actually cascading
  // an unhide down from a country, since (unlike hiding) that should never happen silently.
  app.get<{ Params: { regionId: string; speciesId: string } }>(
    "/regions/:regionId/species/:speciesId/hidden-children",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      const res = await pool.query<{ id: string; name: string }>(
        `SELECT r.id, r.name FROM regions r
         JOIN region_species_hidden rsh ON rsh.region_id = r.id
         WHERE r.parent_id = $1 AND rsh.user_id = $2 AND rsh.species_id = $3
         ORDER BY r.name`,
        [regionId, userId, speciesId],
      );
      return { children: res.rows.map((r) => ({ regionId: r.id, regionName: r.name })) };
    },
  );

  app.delete<{ Params: { regionId: string; speciesId: string }; Querystring: { cascadeRegionIds?: string } }>(
    "/regions/:regionId/species/:speciesId/hide",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      // The frontend resolves which child regions to also unhide (via the hidden-children
      // lookup above + a confirm prompt) and passes them back here so the whole cascade commits
      // as one call — same reasoning as the hide side, just opt-in instead of automatic.
      const cascadeRegionIds = request.query.cascadeRegionIds ? request.query.cascadeRegionIds.split(",").filter(Boolean) : [];
      const regionIds = [regionId, ...cascadeRegionIds];
      await pool.query(`DELETE FROM region_species_hidden WHERE user_id = $1 AND region_id = ANY($2) AND species_id = $3`, [
        userId,
        regionIds,
        speciesId,
      ]);
      return { ok: true };
    },
  );

  // Global hidden-species management view (mirrors GET /archive, just grouped by region
  // instead of family — a region-scoped hide can happen from any region's checklist, so a
  // single dedicated page needs to see all of them at once, not one region at a time).
  app.get("/regions/hidden-species", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const [res, regionsRes] = await Promise.all([
      pool.query<{
        species_id: string;
        scientific_name: string;
        common_name: string | null;
        reference_photo: string | null;
        has_reference_thumb: boolean;
        hidden_at: Date;
        region_id: string;
        region_name: string;
      }>(
        `SELECT s.id AS species_id, s.scientific_name, s.common_name,
                s.reference_photo, s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
                rsh.hidden_at, r.id AS region_id, r.name AS region_name
         FROM region_species_hidden rsh
         JOIN species s ON s.id = rsh.species_id
         JOIN regions r ON r.id = rsh.region_id
         WHERE rsh.user_id = $1
         ORDER BY r.name, s.scientific_name`,
        [userId],
      ),
      // Only fetched to walk each item's own region up to its enclosing country below — same
      // "walk parent_id until sovereignty_group is set" convention CollectionPage's own
      // countryAncestorFor uses client-side, just done once here server-side instead of
      // shipping the whole region tree to the frontend for the same purpose.
      pool.query<{ id: string; name: string; parent_id: string | null; sovereignty_group: string | null }>(
        `SELECT id, name, parent_id, sovereignty_group FROM regions`,
      ),
    ]);
    const byId = new Map(regionsRes.rows.map((r) => [r.id, r]));
    function countryAncestorOf(regionId: string): { id: string; name: string } | null {
      let region = byId.get(regionId);
      while (region && region.sovereignty_group == null && region.parent_id) {
        const parent = byId.get(region.parent_id);
        if (!parent) break;
        region = parent;
      }
      return region ? { id: region.id, name: region.name } : null;
    }
    return {
      items: res.rows.map((r) => {
        const country = countryAncestorOf(r.region_id);
        return {
          speciesId: r.species_id,
          scientificName: r.scientific_name,
          commonName: r.common_name,
          referencePhoto: r.reference_photo,
          referenceThumbUrl: r.has_reference_thumb
            ? `/api/species/${r.species_id}/reference-photo/thumb?v=${MEDIA_CACHE_BUST}`
            : null,
          hiddenAt: r.hidden_at,
          regionId: r.region_id,
          regionName: r.region_name,
          countryId: country?.id ?? null,
          countryName: country?.name ?? null,
          isCountry: country?.id === r.region_id,
        };
      }),
    };
  });

  // Small region-scoped management view (mirrors GET /archive's global counterpart) — every
  // species currently hidden from this one region, so a user can find and unhide one later
  // (e.g. reconsidering after archiving Japanese Quail off BC/Canada).
  app.get<{ Params: { id: string } }>("/regions/:id/hidden-species", { preHandler: requireAuth }, async (request) => {
    const userId = request.user!.id;
    const { id: regionId } = request.params;
    const res = await pool.query<{
      species_id: string;
      scientific_name: string;
      common_name: string | null;
      hidden_at: Date;
    }>(
      `SELECT s.id AS species_id, s.scientific_name, s.common_name, rsh.hidden_at
       FROM region_species_hidden rsh
       JOIN species s ON s.id = rsh.species_id
       WHERE rsh.user_id = $1 AND rsh.region_id = $2
       ORDER BY s.scientific_name`,
      [userId, regionId],
    );
    return {
      items: res.rows.map((r) => ({
        speciesId: r.species_id,
        scientificName: r.scientific_name,
        commonName: r.common_name,
        hiddenAt: r.hidden_at,
      })),
    };
  });
}

// Walks up from any region (province or country) to the country-level ancestor's own ISO3 —
// countries are the level where `sovereignty_group` is set (see CollectionPage.tsx's
// packRegionNameFor for the same walk on the frontend); a province's own row always has it
// null. Used to look up species_nonnative_countries below, which is keyed by country, not
// province.
interface RegionAncestryRow {
  external_codes: string[] | null;
  sovereignty_group: string | null;
  parent_id: string | null;
}

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

// Species flagged as an escapee/introduced population in this country by the elusiveness
// crawl's geographic-distance check (compute-elusiveness.ts) — see compute-provinces-bulk.ts's
// own loadNonNativeSpeciesNames for the bulk-pipeline equivalent of this same lookup.
async function loadNonNativeGbifKeys(iso3: string): Promise<Set<number>> {
  const res = await pool.query<{ gbif_key: string }>(
    `SELECT s.gbif_key FROM species_nonnative_countries snc JOIN species s ON s.id = snc.species_id WHERE snc.country_iso3 = $1`,
    [iso3],
  );
  return new Set(res.rows.map((r) => Number(r.gbif_key)));
}

// Factored out of the /regions/:id/species lazy-compute block so it can also be called
// eagerly by a script (see scripts/prioritize-region.ts — North America prioritization),
// not just triggered by a user's first view of a region.
export async function computeRegionOccurrences(region: {
  id: string;
  name?: string;
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

  // Per-taxon-class recurrence-check floor (see build-region-species.ts's own comment on
  // RECURRENCE_MIN_RECORDS_FRACTION_OF_MEDIAN) — birds and mammals have wildly different record
  // volumes even in the same region, so each gets its own median, computed only from species
  // that already clearly passed (recordCount >= MIN_RECORDS in the recent window) rather than
  // the whole candidate pool, which is mostly noise.
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
  // Fish never get the STRICT bird recurrence check (3+ distinct years) — it runs against the
  // same tiny land-only polygon fish are counted in, and for a small island (Antigua and
  // Barb.: land area ~280km²), a real, permanent reef resident's occurrences are almost all
  // just offshore — only a sliver of GBIF points (geolocation noise) ever fall inside the
  // literal land polygon, so it rarely reaches 3 distinct years and gets wrongly flagged
  // vagrant (89% of Antigua's fish, vs. 0% for every other Caribbean country in this dataset,
  // where a bigger land polygon "catches" enough points regardless).
  //
  // That said, an UNCONDITIONAL exemption (this used to just hardcode isVagrant=false for
  // every fish, full stop) went too far the other way: real-world case — a Falklands/Argentina
  // skate and a Borneo-endemic minnow both ended up on Canada's own checklist as non-vagrant
  // "legendary" residents, each on just 1-2 total GBIF records ever, anywhere near Canada.
  // FISH_MIN_RECORDS=1 already means a single stray/misidentified point is enough to add a
  // fish to the checklist at all; skipping vagrancy on top of that left genuinely implausible
  // one-off records with no signal marking them as such. This keeps the exemption from the
  // strict distinct-years check (so real sparse island reef residents are unaffected — they
  // typically clear a handful of total records even when concentrated in 1-2 years) but adds a
  // much lower floor: a fish needs at least a few total records anywhere in the region, ever,
  // before it's treated as a real local population rather than noise.
  const FISH_VAGRANT_MIN_RECORDS = 3;
  const fishGbifKeys = new Set(fishCounts.map((c) => c.gbifKey));
  const fishRecordCountByGbifKey = new Map(fishCounts.map((c) => [c.gbifKey, c.recordCount]));
  const yearConcentrationByGbifKey = new Map<number, number>();
  const isVagrantByGbifKey = new Map<number, boolean>();
  // Batched — a fixed, small number of calls (one facet=speciesKey per year in the window,
  // see fetchYearlyRecordCounts's own comment) covering every bird/mammal species on the
  // checklist at once, instead of one live GBIF call per already-included species. This was
  // the actual bottleneck making region computation take a very long time under GBIF's rate
  // limits — hundreds of sequential per-species calls for a well-recorded region.
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
    // How concentrated into a single year, continuous (0 = spread evenly, 1 = literally
    // every record from one year) — a species that JUST misses the recurrence bar (maxShare
    // 0.51) shouldn't get shoved to "legendary" as hard as one that's 100% one event.
    const maxShare = total > 0 ? Math.max(...yearCounts.map((y) => y.count)) / total : 0;
    if (isVagrant) yearConcentrationByGbifKey.set(c.gbifKey, maxShare);
  }

  // Base score from record-count rank (0 = most-recorded/easiest here, 1 = rarest
  // here), then nocturnal + low-density species (real EltonTraits/Callaghan-et-al.
  // data, not a guess — see compute-rarity-phase1.ts) get boosted into a single composite.
  // Domestic species are excluded from this ranking pool entirely (see above) — their own
  // record counts would be meaningless noise in it either way.
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
  // Mirrors the GLOBAL tier logic (apply-rarity-phase4.ts) — and the same fix just applied to
  // compute-provinces-bulk.ts's province-level tier — instead of the old rank-based
  // tierForPercentile(idx/n): comparing the boosted score against the same taxon-calibrated
  // absolute thresholds used globally, so a species doesn't get bumped down a tier just because
  // other species in this SAME region happen to rank even higher on the same boosted scale. This
  // endpoint has no per-occurrence lat/lon (unlike the bulk province path), so there's no spatial
  // concentration axis available here — the fully-boosted record-count/elusiveness score above is
  // the best available composite, used directly rather than invented from scratch.
  const taxonClassRes = await pool.query<{ gbif_key: string; taxon_class: string | null }>(
    `SELECT gbif_key, taxon_class FROM species WHERE gbif_key = ANY($1)`,
    [wildFiltered.map((c) => c.gbifKey)],
  );
  const taxonClassByGbifKey = new Map(taxonClassRes.rows.map((r) => [Number(r.gbif_key), r.taxon_class]));
  const localTierByGbifKey = new Map<number, string>();
  boostedScores.forEach(({ gbifKey, score }) => {
    const taxonClass = taxonClassByGbifKey.get(gbifKey);
    // Marine invertebrates with no reliable data density to rank against (see
    // NO_RARITY_TIER_TAXON_CLASSES's own comment) stay untiered here too — same reasoning as
    // compute-provinces-bulk.ts's own province-level computation.
    if (taxonClass && NO_RARITY_TIER_TAXON_CLASSES.has(taxonClass as TaxonClass)) return;
    const thresholds = fishGbifKeys.has(gbifKey)
      ? FISH_ABSOLUTE_TIER_THRESHOLDS
      : taxonClass === "mammalia"
        ? MAMMAL_ABSOLUTE_TIER_THRESHOLDS
        : BIRD_ABSOLUTE_TIER_THRESHOLDS;
    localTierByGbifKey.set(gbifKey, tierForScore(score, thresholds));
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
  // The floor above stops local from reading too EASY relative to global, but nothing
  // originally stopped it reading too HARD — a globally "common" species has no valid "one
  // step easier than common" to floor against (Math.min(localRank, globalRank+1) is a no-op
  // once globalRank is already the last tier), so a species like Mallard, genuinely common
  // worldwide, could still swing all the way to "legendary" locally purely from thin-data
  // noise in one under-birded region. Confirmed live in South Africa. Caps the OTHER
  // direction too: local can't read more than this many steps harder than global — a real
  // regional scarcity is plausible, but a globally-abundant species reading as one of the
  // single hardest-to-find things on Earth almost never is.
  const LOCAL_TIER_GLOBAL_CEILING_STEPS = 2;
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
    const clampedRank = Math.min(
      Math.max(localRank, globalRank - LOCAL_TIER_GLOBAL_CEILING_STEPS),
      globalRank + LOCAL_TIER_GLOBAL_FLOOR_STEPS,
    );
    if (clampedRank !== localRank) localTierByGbifKey.set(gbifKey, TIER_ORDER[clampedRank]);
  }

  for (const gbifKey of domesticGbifKeys) localTierByGbifKey.set(gbifKey, "common");

  // iNaturalist Research-Grade records are the sole authority on WHICH species belong on this
  // region's checklist — everything above (GBIF sweep, fish scrutiny, vagrancy, tier scoring)
  // still supplies the occurrence DATA for whichever species land here, it just no longer gets
  // to decide membership by itself. Falls back to the old GBIF-only membership (inatMatchedIds
  // stays null) when iNat data genuinely can't be resolved for this region, so a lookup hiccup
  // never empties a real checklist.
  const inatMatchedIds = region.name ? await matchedSpeciesIdsForRegion(regionId, region.name) : null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (inatMatchedIds) {
      const { matchedSpeciesIds, rawTaxonIds } = inatMatchedIds;

      // Existing checklist BEFORE any changes — needed both to find removal candidates and to
      // know which already carry a real tier (see below).
      const existingRes = await client.query<{ species_id: string; local_tier: string | null }>(
        `SELECT species_id, local_tier FROM region_species WHERE region_id = $1`,
        [regionId],
      );
      const existingIds = new Set(existingRes.rows.map((r) => r.species_id));
      const alreadyTieredIds = new Set(existingRes.rows.filter((r) => r.local_tier != null).map((r) => r.species_id));

      // On the checklist today but not in iNat's matched set — before actually dropping any of
      // these, check whether that's a genuine absence or just a scientific name our catalog
      // hasn't caught up to yet (a species iNat moved to a new genus, say, still reads as
      // "iNat doesn't confirm this" under exact-name matching alone — see
      // resolveRemovalRescues's own comment, confirmed live for Kittlitz's Plover: Charadrius
      // pecuarius -> Anarhynchus pecuarius). Nothing gets removed without this check clearing it
      // first.
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
      // Species iNat no longer confirms here (after the rescue check above) get dropped
      // entirely — includes species this region previously carried from an earlier GBIF-only
      // computation.
      await client.query(
        `DELETE FROM region_species WHERE region_id = $1 AND NOT (species_id = ANY($2::uuid[]))`,
        [regionId, idList],
      );
      // Species already on this checklist AND already carrying a real rarity tier are left
      // completely untouched — no need to recompute a tier we already have (e.g. Mallard in BC:
      // already tiered, iNat re-confirming its presence there is not a reason to redo the work).
      // A species that's merely PRESENT but still untiered (every species inserted by the old
      // iNat-only province fill, which deliberately computes no tier at all) is treated the same
      // as brand new — otherwise every one of those provinces would stay permanently untiered
      // forever, since this same reconcile pass would keep seeing them as "already there" and
      // never give them the GBIF-backed tier computation they were always missing.
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
          // A species iNat confirms but the GBIF sweep never found (or that never cleared its
          // own MIN_RECORDS floor) has no percentile score to rank. Used to default this to the
          // rarest bucket ("iNat found it, GBIF barely has it" read as a strong hard-to-find
          // signal) — confirmed live this was wrong: for marine invertebrates, where almost
          // every checklist species only ever clears the bar via this exact iNat-only path, it
          // collapsed an entire taxon group to "legendary" uniformly, which reads as broken, not
          // informative. Left unrated (null) now, same as any other species with no percentile
          // score to rank.
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
      // Old fallback path, unchanged — GBIF's own discovered set decides membership when iNat
      // data isn't available for this region at all.
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
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
