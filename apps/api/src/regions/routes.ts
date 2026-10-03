// Region checklists and browsing. The GBIF computation that builds checklists is script-only
// and lives in compute/.
import type { FastifyInstance } from "fastify";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "../auth/session.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import { markNameChanged } from "../species/speciesSplits.js";
import {
  obscureSpeciesSql,
  REGION_VAGRANT_SQL,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  NOT_REGION_HIDDEN_SQL,
  getObscurityPreferences,
} from "../species/obscurity.js";
import { fetchProvincesForCountry } from "data-pipeline/src/fetch/fetch-region-boundary.js";
import { exteriorRingsFromGeometry, type BoundingBox } from "data-pipeline/src/geometry.js";
import { nearbyZones, resolveCountryRings } from "./nearbyZones.js";
import { regionBoundaryRoutes } from "./boundaries.js";
import { regionHiddenSpeciesRoutes } from "./hiddenSpecies.js";

type SortBy = "taxonomic" | "rarity" | "name";
type StateFilter = "all" | "missing" | "collected" | "seen";

const TIER_RANK: Record<string, number> = { legendary: 0, rare: 1, uncommon: 2, occasional: 3, common: 4 };


// Packs are named after countries, so this resolves a region (a country or one of its
// provinces) to the country name downloaded_packs uses.
async function resolvePackRegionName(regionId: string): Promise<string | null> {
  const res = await pool.query<{ name: string; parent_id: string | null; parent_external_codes: string[] | null }>(
    `SELECT r.name, r.parent_id, p.external_codes AS parent_external_codes
     FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  // A parent without codes is a continent, so this region is the country; otherwise the parent is.
  if (!row.parent_external_codes?.length) return row.name;
  const parentRes = await pool.query<{ name: string }>(`SELECT name FROM regions WHERE id = $1`, [row.parent_id]);
  return parentRes.rows[0]?.name ?? null;
}

// A region_species row doesn't mean its taxon's pack was downloaded (the catalog seed ships every
// taxon's rows), so a species shows only when its taxon's pack for the country is installed. A
// NULL country ($7) matches nothing. Other Taxa species have no packs and always show.
const TAXON_PACK_DOWNLOADED_SQL = `(
  s.is_other_taxa = true OR EXISTS (
    SELECT 1 FROM downloaded_packs dp WHERE dp.region = $7 AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class)
  )
)`;


// Species the user photographed in this region or one inside it, so they show on its checklist
// even when it doesn't list them or their taxon's pack isn't downloaded. `includeLand` is the SQL
// for the land toggle: a sea-zone-only view leaves these out.
const CAPTURED_IN_TREE_SQL = (includeLand: string) =>
  `SELECT c.species_id FROM captures c WHERE c.user_id = $1 AND ${includeLand} AND c.region_id IN (SELECT id FROM region_tree)`;

export async function regionRoutes(app: FastifyInstance): Promise<void> {
  app.get("/regions", { preHandler: requireAuth }, async () => {
    // Boundaries are left out (hundreds of KB each); the map gets one region's outline from
    // GET /regions/:id/species and all countries' from GET /regions/boundaries.
    const res = await pool.query(
      // Guantanamo Bay naval base ("USG") is left out: no civilian access.
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
        // Country level only: groups a country with its separate territories in the picker.
        sovereigntyGroup: r.sovereignty_group,
        isSovereignDependency: r.is_sovereign_dependency,
      })),
    };
  });

  // Which taxa each region has any species in (downloaded or not), so the pack picker can hide
  // a taxon that would download nothing. The client unions the result across its selection.
  app.get<{ Querystring: { regionIds?: string } }>("/regions/taxon-presence", { preHandler: requireAuth }, async (request, reply) => {
    const regionIds = request.query.regionIds?.split(",").filter(Boolean) ?? [];
    if (regionIds.length === 0) return reply.code(400).send({ error: "regionIds is required" });
    if (!regionIds.every(isUuid)) return reply.code(400).send({ error: "regionIds must be region ids" });
    // Same Other Taxa rollup as GET /regions/:id/species; root_region_id maps each row back to
    // the requested region it rolled up to.
    const res = await pool.query<{ root_region_id: string; taxon_class: string }>(
      `WITH RECURSIVE region_tree AS (
         SELECT id, id AS root_region_id FROM regions WHERE id = ANY($1)
         UNION ALL
         SELECT r.id, rt.root_region_id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
       )
       SELECT DISTINCT root_region_id, taxon_class FROM (
         -- The requested region itself: every taxon.
         SELECT rt.root_region_id, s.taxon_class
         FROM region_tree rt
         JOIN region_species rs ON rs.region_id = rt.id
         JOIN species s ON s.id = rs.species_id
         WHERE rt.id = rt.root_region_id
         UNION ALL
         -- Descendant regions: only Other Taxa roll up (real taxa have a checklist at every
         -- level). A separate branch rather than an OR, so each side can use its index.
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

  // Taxa the user has photographed in this region or anywhere inside it, so the Collection
  // offers that taxon's filter even without its pack.
  app.get<{ Params: { id: string } }>("/regions/:id/photographed-taxa", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Region not found" });
    const res = await pool.query<{ taxon_class: string }>(
      `WITH RECURSIVE region_tree AS (
         SELECT id FROM regions WHERE id = $2
         UNION ALL
         SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
       )
       SELECT DISTINCT s.taxon_class
       FROM captures c JOIN species s ON s.id = c.species_id
       WHERE c.user_id = $1 AND c.region_id IN (SELECT id FROM region_tree)`,
      [request.user!.id, request.params.id],
    );
    return { taxa: res.rows.map((r) => r.taxon_class) };
  });

  // Nearby sea zones offered as checkboxes. Reads the precomputed nearby_sea_zone_ids, since the
  // geometry is costly enough to block the event loop; a NULL is computed once and stored.
  app.get<{ Params: { id: string } }>("/regions/:id/sea-zones", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Region not found" });
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
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Region not found" });
      const { id: regionId } = request.params;
      const userId = request.user!.id;
      const sort = request.query.sort ?? "taxonomic";
      const filter = request.query.filter ?? "all";
      const taxon = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);
      // Comma-separated, like `taxon`: several sea zones can be on at once.
      const seaZoneIds = request.query.seaZoneIds ? request.query.seaZoneIds.split(",").filter(Boolean) : [];
      if (!seaZoneIds.every(isUuid)) return reply.code(404).send({ error: "Sea zone not found" });
      // includeLand=0 shows only the selected zones' species. Defaults to land plus zones.
      const includeLand = request.query.includeLand !== "0";

      // Sea zone species come only from downloaded packs; a zone without one adds nothing.
      if (seaZoneIds.length > 0) {
        const zonesRes = await pool.query(`SELECT id FROM sea_zones WHERE id = ANY($1)`, [seaZoneIds]);
        if (zonesRes.rows.length !== seaZoneIds.length) return reply.code(404).send({ error: "Sea zone not found" });
      }

      // canDrillDown needs to know whether this region is a country: there's no data below
      // provinces.
      const regionRes = await pool.query(
        `SELECT r.id, r.name, r.ebird_region_code, r.boundary_geojson, r.external_codes, r.occurrence_computed_at, r.has_children,
                COALESCE(array_length(p.external_codes, 1), 0) = 0 AS region_is_country_level
         FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
         WHERE r.id = $1`,
        [regionId],
      );
      const region = regionRes.rows[0];
      if (!region) return reply.code(404).send({ error: "Region not found" });

      // Checklists come only from downloaded packs (the live GBIF computation is for the
      // pack-building scripts), so a region without one tells the client it needs a pack.
      if (!region.occurrence_computed_at && region.external_codes?.length > 0) {
        return { needsPack: true, region: { id: region.id, name: region.name } };
      }

      const packRegionName = await resolvePackRegionName(regionId);

      // Per-user state as in GET /collection. Species are the region's checklist plus any
      // selected sea zones' (UNION, since one can be in both). Sea-zone-only species have no
      // local_tier: they were never ranked against this region's checklist.
      const res = await pool.query(
        `WITH RECURSIVE region_tree AS (
           SELECT id FROM regions WHERE id = $2
           UNION ALL
           SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         ),
         species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = $2 AND $5
           -- An Other Taxa species only has a row where it was added, so it rolls up from
           -- every descendant region. A separate branch rather than an OR, so each side can
           -- use its index.
           UNION
           SELECT rs.species_id FROM region_species rs
           JOIN species sp ON sp.id = rs.species_id
           WHERE sp.is_other_taxa = true AND rs.region_id IN (SELECT id FROM region_tree)
           UNION
           SELECT species_id FROM sea_zone_species WHERE sea_zone_id = ANY($4)
           UNION
           ${CAPTURED_IN_TREE_SQL("$5")}
         )
         SELECT
           s.id AS species_id,
           s.scientific_name,
           s.common_name,
           s.taxon_class,
           s.family,
           s.taxon_order,
           s.reference_photo,
           s.reference_credit,
           s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
           s.reference_focal_x,
           s.reference_focal_y,
           s.is_other_taxa,
           s.inat_iconic_taxon,
           r.tier,
           r.tier_reason,
           rs.local_tier,
           rs.tier_reason AS local_tier_reason,
           uto.tier AS override_tier,
           rs.is_vagrant,
           rs.seasonality,
           rs.weekly_frequency,
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
         -- The user's own tier for this species: for this region if set, else everywhere.
         LEFT JOIN LATERAL (
           SELECT o.tier FROM user_tier_overrides o
           WHERE o.user_id = $1 AND o.species_id = s.id AND (o.region_id = $2 OR o.region_id IS NULL)
           ORDER BY o.region_id NULLS LAST LIMIT 1
         ) uto ON true
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
           AND (rs.region_id IS NULL OR s.id IN (${CAPTURED_IN_TREE_SQL("true")}) OR ${TAXON_PACK_DOWNLOADED_SQL})
         ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
        [userId, regionId, taxon, seaZoneIds, includeLand, hideObscure, packRegionName],
      );

      let items = await markNameChanged(userId, res.rows.map((row) => toCollectionItem(row, maxDepthM)));

      // For a single requested taxon, tells "nothing here" apart from "that taxon's pack isn't
      // downloaded" so the UI can prompt for it.
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

  // World and continents have no checklist of their own, so this unions the checklists of the
  // downloaded countries under them.
  app.get<{
    Params: { id: string };
    Querystring: { taxon?: string };
  }>(
    "/regions/:id/aggregate-species",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Region not found" });
      const { id: hubId } = request.params;
      const userId = request.user!.id;
      const taxon = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const hubRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE id = $1`, [hubId]);
      const hub = hubRes.rows[0];
      if (!hub) return reply.code(404).send({ error: "Region not found" });

      // Countries are children of a continent and grandchildren of World. Continents never have
      // a downloaded_packs row, so EXISTS leaves them out.
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

      // DISTINCT ON keeps one row per species across countries (preferring one with a tier).
      const res = await pool.query(
        `WITH RECURSIVE region_tree AS (
           SELECT id FROM regions WHERE id = ANY($2)
           UNION ALL
           SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         ),
         species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = ANY($2)
           -- Same Other Taxa rollup as GET /regions/:id/species.
           UNION
           SELECT rs.species_id FROM region_species rs
           JOIN species sp ON sp.id = rs.species_id
           WHERE sp.is_other_taxa = true AND rs.region_id IN (SELECT id FROM region_tree)
           UNION
           ${CAPTURED_IN_TREE_SQL("true")}
         )
         SELECT DISTINCT ON (s.id)
           s.id AS species_id,
           s.scientific_name,
           s.common_name,
           s.taxon_class,
           s.family,
           s.taxon_order,
           s.reference_photo,
           s.reference_credit,
           s.reference_thumb_path IS NOT NULL AS has_reference_thumb,
           s.reference_focal_x,
           s.reference_focal_y,
           s.is_other_taxa,
           s.inat_iconic_taxon,
           r.tier,
           r.tier_reason,
           rs.local_tier,
           rs.tier_reason AS local_tier_reason,
           uto.tier AS override_tier,
           rs.is_vagrant,
           rs.seasonality,
           rs.weekly_frequency,
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
         -- The whole region_tree, so a province-level Other Taxa row is found too.
         LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id IN (SELECT id FROM region_tree)
         LEFT JOIN species_rarity r ON r.species_id = s.id
         LEFT JOIN user_tier_overrides uto ON uto.user_id = $1 AND uto.species_id = s.id AND uto.region_id IS NULL
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
           -- A species you've photographed stays even without its group's pack.
           AND (${ALREADY_OWNED_SQL} OR EXISTS (SELECT 1 FROM downloaded_packs dp WHERE dp.region = ANY($5) AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class)))
         ORDER BY s.id, (rs.local_tier IS NULL), s.scientific_name`,
        [userId, countryIds, taxon, hideObscure, countryNames],
      );

      const items = await markNameChanged(userId, res.rows.map((row) => toCollectionItem(row, maxDepthM)));
      return { items, downloadedCountryNames: countryNames };
    },
  );

  // Counts only, with the same filtering as GET /regions/:id/species, so the header can show a
  // total without waiting for the full list.
  app.get<{
    Params: { id: string };
    Querystring: { taxon?: string; seaZoneIds?: string; includeLand?: string };
  }>(
    "/regions/:id/species/count",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Region not found" });
      const { id: regionId } = request.params;
      const userId = request.user!.id;
      const taxon = request.query.taxon ? request.query.taxon.split(",").filter(Boolean) : null;
      const seaZoneIds = request.query.seaZoneIds ? request.query.seaZoneIds.split(",").filter(Boolean) : [];
      if (!seaZoneIds.every(isUuid)) return reply.code(404).send({ error: "Sea zone not found" });
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
           UNION
           ${CAPTURED_IN_TREE_SQL("$5")}
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
           AND (rs.region_id IS NULL OR s.id IN (${CAPTURED_IN_TREE_SQL("true")}) OR ${TAXON_PACK_DOWNLOADED_SQL})`,
        [userId, regionId, taxon, seaZoneIds, includeLand, hideObscure, packRegionName],
      );
      const row = res.rows[0];
      return { total: Number(row.total), collected: Number(row.collected), seen: Number(row.seen) };
    },
  );

  // Creates a country's provinces on first open, from the cached Natural Earth admin-1 file.
  app.post<{ Params: { id: string } }>("/regions/:id/drill-down", { preHandler: requireAuth }, async (request, reply) => {
    const { id: regionId } = request.params;
    if (!isUuid(regionId)) return reply.code(404).send({ error: "Region not found" });

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
    if (provinces.length > 0) {
      await pool.query(
        `INSERT INTO regions (name, parent_id, external_codes, ebird_region_code, boundary_geojson, is_overseas_territory, subdivision_type)
         SELECT p.name, $1::uuid, CASE WHEN p.code IS NULL THEN '{}'::text[] ELSE ARRAY[p.code] END, p.code, p.feature::jsonb, p.overseas, p.type
         FROM unnest($2::text[], $3::text[], $4::text[], $5::boolean[], $6::text[]) AS p(name, code, feature, overseas, type)
         ON CONFLICT (name, parent_id) DO NOTHING`,
        [
          regionId,
          provinces.map((p) => p.name),
          provinces.map((p) => p.iso3166_2 ?? null),
          provinces.map((p) => JSON.stringify(p.feature)),
          provinces.map((p) => p.isOverseasTerritory),
          provinces.map((p) => p.type),
        ],
      );
    }
    const created = provinces.length;
    await pool.query(`UPDATE regions SET has_children = true WHERE id = $1`, [regionId]);

    return { ok: true, created };
  });

  await app.register(regionBoundaryRoutes);
  await app.register(regionHiddenSpeciesRoutes);
}
