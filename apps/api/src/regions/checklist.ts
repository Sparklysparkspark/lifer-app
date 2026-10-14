// A region's species checklist with the user's state: one region (plus any selected sea zones),
// its header count, and the union over a continent's or World's downloaded countries.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "../auth/session.js";
import { IdParams, Open, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { toCollectionItem } from "../collection/collectionItem.js";
import { AggregateSpecies, RegionSpecies } from "./responses.js";
import { markNameChanged } from "../species/speciesSplits.js";
import {
  obscureSpeciesSql,
  REGION_VAGRANT_SQL,
  ALREADY_OWNED_SQL,
  NOT_ARCHIVED_SQL,
  NOT_REGION_HIDDEN_SQL,
  getObscurityPreferences,
} from "../species/obscurity.js";
import {
  addedByUserSql,
  userAddedColumnsSql,
  userAddedInSeaZonesSql,
  addedFromAboveCteSql,
  userAddedInTreeSql,
  userAddedLateralSql,
  userAddedSeaZoneLateralSql,
} from "./checklistAdditions.js";

const regionNotFound = notFoundOnInvalidId("Region not found");
// Comma-separated taxon classes, like the Collection's filter.
const TaxonQuery = Type.Optional(Type.String());
// Comma-separated sea zone ids, each checked in the handler (404 like an unknown zone).
const SeaZoneIdsQuery = Type.Optional(Type.String());
// "0" shows only the selected sea zones' species; anything else (or nothing) includes land.
const IncludeLandQuery = Type.Optional(Type.Enum(["0", "1"]));

const TIER_RANK: Record<string, number> = { legendary: 0, rare: 1, uncommon: 2, occasional: 3, common: 4 };

// Packs are named after countries, so this resolves a region (a country, one of its regional
// groups or provinces) to the country name downloaded_packs uses: the nearest region up the tree
// whose parent has no codes (a continent). A province shown under its continent has packs of its own.
async function resolvePackRegionName(regionId: string): Promise<string | null> {
  const res = await pool.query<{ name: string }>(
    `WITH RECURSIVE up AS (
       SELECT id, name, parent_id, 0 AS depth FROM regions WHERE id = $1
       UNION ALL SELECT r.id, r.name, r.parent_id, up.depth + 1 FROM regions r JOIN up ON r.id = up.parent_id WHERE up.depth < 10
     )
     SELECT up.name FROM up LEFT JOIN regions p ON p.id = up.parent_id
     WHERE COALESCE(array_length(p.external_codes, 1), 0) = 0
     ORDER BY up.depth LIMIT 1`,
    [regionId],
  );
  return res.rows[0]?.name ?? null;
}

// A region_species row doesn't mean its taxon's pack was downloaded (the catalog seed ships every
// taxon's rows), so a species shows only when its taxon's pack for the country is installed. A
// NULL country matches nothing. Hand-imported species have no region_species rows (they're
// checklist additions), so this never sees one.
export const taxonPackDownloadedSql = (packRegionParam: string) => `EXISTS (
  SELECT 1 FROM downloaded_packs dp WHERE dp.region = ${packRegionParam} AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class)
)`;

// A species the user added to this view's checklist by hand (the region or one inside it, or a
// selected sea zone): it shows whatever the obscure filter or the taxon's pack would say, since
// the user asked for it. Requires `ua`, and `uz` on a view that can include sea zones
// (checklistAdditions.ts).
const ADDED_BY_USER_SQL = addedByUserSql(true);
const ADDED_IN_TREE_SQL = addedByUserSql(false);

// Species the user photographed in this region or one inside it, so they show on its checklist
// even when it doesn't list them or their taxon's pack isn't downloaded. `includeLand` is the SQL
// for the land toggle: a sea-zone-only view leaves these out.
export const capturedInTreeSql = (userParam: string, includeLand: string) =>
  `SELECT c.species_id FROM captures c WHERE c.user_id = ${userParam} AND ${includeLand} AND c.region_id IN (SELECT id FROM region_tree)`;

// The parameters GET /regions/:id/species and its count share, in order.
const P = {
  user: "$1",
  region: "$2",
  taxon: "$3",
  seaZones: "$4",
  includeLand: "$5",
  hideObscure: "$6",
  packRegion: "$7",
  hasPack: "$8",
} as const;

function regionViewParams(v: {
  userId: string;
  regionId: string;
  taxon: string[] | null;
  seaZoneIds: string[];
  includeLand: boolean;
  hideObscure: boolean;
  packRegionName: string | null;
  needsPack: boolean;
}): unknown[] {
  return [v.userId, v.regionId, v.taxon, v.seaZoneIds, v.includeLand, v.hideObscure, v.packRegionName, !v.needsPack];
}

// The region view's species: the region's checklist plus any selected sea zones' (UNION, since
// one can be in both), what the user photographed or added there, and the region tree that needs.
// Without the pack the catalog's own checklist stays out.
const REGION_VIEW_SPECIES_CTE = `WITH RECURSIVE region_tree AS (
           SELECT id FROM regions WHERE id = ${P.region}
           UNION ALL
           SELECT r.id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         )${addedFromAboveCteSql(P.user, P.region)},
         species_ids AS (
           SELECT species_id FROM region_species WHERE region_id = ${P.region} AND ${P.includeLand} AND ${P.hasPack}
           UNION
           SELECT species_id FROM sea_zone_species WHERE sea_zone_id = ANY(${P.seaZones})
           UNION
           ${capturedInTreeSql(P.user, P.includeLand)}
           UNION
           ${userAddedInTreeSql(P.user, P.includeLand, true)}
           UNION
           ${userAddedInSeaZonesSql(P.user, P.seaZones)}
         )`;

// Joins `rs`, `ua` and `uz` for the region view; without the pack ($8 false) the region's catalog
// row isn't shown, so its tiers aren't either.
const REGION_VIEW_JOINS = `LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id = ${P.region} AND ${P.hasPack}
         ${userAddedLateralSql(P.user, P.region, P.includeLand, true)}
         ${userAddedSeaZoneLateralSql(P.user, P.seaZones)}`;

const TAXON_FILTER_SQL = (taxonParam: string) =>
  `((${taxonParam}::text[] IS NULL) OR (${taxonParam} @> ARRAY['other-taxa']::text[] AND s.is_other_taxa = true) OR s.taxon_class = ANY(${taxonParam})) AND COALESCE(t.fully_extinct, false) = false`;

// Needs `t`, `us`, `uas`, `rsh` and REGION_VIEW_JOINS.
const regionViewFilterSql = (maxDepthM: number) => `${TAXON_FILTER_SQL(P.taxon)}
           AND (${P.hideObscure} = false OR ${ALREADY_OWNED_SQL} OR ${ADDED_BY_USER_SQL} OR NOT (${obscureSpeciesSql(maxDepthM)} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}
           AND ${NOT_REGION_HIDDEN_SQL}
           AND (rs.region_id IS NULL OR ${ADDED_BY_USER_SQL} OR s.id IN (${capturedInTreeSql(P.user, "true")}) OR ${taxonPackDownloadedSql(P.packRegion)})`;

/** Select-list columns toCollectionItem reads, for a checklist row joined as in the routes below.
 *  `userParam` is the user id's placeholder. */
const checklistItemColumns = (userParam: string, userAddedColumns: string) => `s.id AS species_id,
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
           ${userAddedColumns},
           (SELECT array_agg(DISTINCT EXTRACT(YEAR FROM cy.taken_at)::int)
              FROM captures cy WHERE cy.user_id = ${userParam} AND cy.species_id = s.id AND cy.taken_at IS NOT NULL) AS captured_years`;

/** The rest of a checklist row's joins: tier, traits, the user's state and cover photo, and
 *  whether it's archived. */
const checklistItemJoins = (userParam: string) => `LEFT JOIN species_traits t ON t.species_id = s.id
         LEFT JOIN user_species us ON us.user_id = ${userParam} AND us.species_id = s.id
         LEFT JOIN photos p ON p.id = us.cover_photo_id
         LEFT JOIN originals o ON o.capture_id = p.capture_id AND o.kind = 'jpeg'
         LEFT JOIN storage_volumes sv ON sv.id = o.volume_id
         LEFT JOIN user_archived_species uas ON uas.user_id = ${userParam} AND uas.species_id = s.id`;

function splitList(value: string | undefined): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

export async function regionChecklistRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/regions/:id/species",
    {
      preValidation: requireAuth,
      config: regionNotFound,
      schema: {
        params: IdParams,
        querystring: Type.Object({
          sort: Type.Optional(Type.Enum(["taxonomic", "rarity", "name"])),
          filter: Type.Optional(Type.Enum(["all", "missing", "collected", "seen"])),
          taxon: TaxonQuery,
          seaZoneIds: SeaZoneIdsQuery,
          includeLand: IncludeLandQuery,
        }),
        response: replies(RegionSpecies),
      },
    },
    async (request, reply) => {
      const { id: regionId } = request.params;
      const userId = request.user!.id;
      const sort = request.query.sort ?? "taxonomic";
      const filter = request.query.filter ?? "all";
      const taxon = request.query.taxon ? splitList(request.query.taxon) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);
      // Comma-separated, like `taxon`: several sea zones can be on at once.
      const seaZoneIds = splitList(request.query.seaZoneIds);
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
                COALESCE(array_length(p.external_codes, 1), 0) = 0 AND r.home_country_id IS NULL AS region_is_country_level
         FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
         WHERE r.id = $1`,
        [regionId],
      );
      const region = regionRes.rows[0];
      if (!region) return reply.code(404).send({ error: "Region not found" });

      // Checklists come only from downloaded packs (the live GBIF computation is for the
      // pack-building scripts), so a region without one tells the client it needs a pack. It
      // still lists what's yours there (species you photographed in it or added to it), so those
      // don't wait for a download; the catalog's own checklist stays out until then.
      const needsPack = !region.occurrence_computed_at && region.external_codes?.length > 0;

      const packRegionName = await resolvePackRegionName(regionId);

      // Per-user state as in GET /collection. Sea-zone-only species have no local_tier: they were
      // never ranked against this region's checklist.
      const res = await pool.query(
        `${REGION_VIEW_SPECIES_CTE}
         SELECT
           ${checklistItemColumns(P.user, userAddedColumnsSql({ seaZonesParam: P.seaZones, includeLandParam: P.includeLand }))}
         FROM species_ids si
         JOIN species s ON s.id = si.species_id
         ${REGION_VIEW_JOINS}
         LEFT JOIN species_rarity r ON r.species_id = s.id
         -- The user's own tier for this species: for this region if set, else everywhere.
         LEFT JOIN LATERAL (
           SELECT o.tier FROM user_tier_overrides o
           WHERE o.user_id = ${P.user} AND o.species_id = s.id AND (o.region_id = ${P.region} OR o.region_id IS NULL)
           ORDER BY o.region_id NULLS LAST LIMIT 1
         ) uto ON true
         ${checklistItemJoins(P.user)}
         LEFT JOIN region_species_hidden rsh ON rsh.user_id = ${P.user} AND rsh.species_id = s.id AND rsh.region_id = ${P.region}
         WHERE ${regionViewFilterSql(maxDepthM)}
         ORDER BY s.sort_order NULLS LAST, s.scientific_name`,
        regionViewParams({ userId, regionId, taxon, seaZoneIds, includeLand, hideObscure, packRegionName, needsPack }),
      );

      let items = await markNameChanged(
        userId,
        res.rows.map((row) => toCollectionItem(row, maxDepthM)),
      );

      // For a single requested taxon, tells "nothing here" apart from "that taxon's pack isn't
      // downloaded" so the UI can prompt for it.
      let taxonPackMissing = false;
      if (taxon?.length === 1 && packRegionName && !needsPack) {
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
        ...(needsPack && { needsPack: true }),
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
  app.get(
    "/regions/:id/aggregate-species",
    {
      preValidation: requireAuth,
      config: regionNotFound,
      schema: {
        params: IdParams,
        querystring: Type.Object({ taxon: TaxonQuery }),
        response: replies(AggregateSpecies),
      },
    },
    async (request, reply) => {
      const { id: hubId } = request.params;
      const userId = request.user!.id;
      const taxon = request.query.taxon ? splitList(request.query.taxon) : null;
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const hubRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE id = $1`, [
        hubId,
      ]);
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
           UNION
           ${capturedInTreeSql("$1", "true")}
           UNION
           ${userAddedInTreeSql("$1")}
         )
         SELECT DISTINCT ON (s.id)
           ${checklistItemColumns("$1", userAddedColumnsSql())}
         FROM species_ids si
         JOIN species s ON s.id = si.species_id
         -- The whole region_tree, so a species on the list only through a province (photographed or
         -- added there) still gets that province's row.
         LEFT JOIN region_species rs ON rs.species_id = s.id AND rs.region_id IN (SELECT id FROM region_tree)
         ${userAddedLateralSql("$1", null)}
         LEFT JOIN species_rarity r ON r.species_id = s.id
         LEFT JOIN user_tier_overrides uto ON uto.user_id = $1 AND uto.species_id = s.id AND uto.region_id IS NULL
         ${checklistItemJoins("$1")}
         LEFT JOIN region_species_hidden rsh ON rsh.user_id = $1 AND rsh.species_id = s.id AND rsh.region_id = rs.region_id
         WHERE ${TAXON_FILTER_SQL("$3")}
           AND ($4 = false OR ${ALREADY_OWNED_SQL} OR ${ADDED_IN_TREE_SQL} OR NOT (${obscureSpeciesSql(maxDepthM)} OR ${REGION_VAGRANT_SQL}))
           AND ${NOT_ARCHIVED_SQL}
           AND ${NOT_REGION_HIDDEN_SQL}
           -- A species you've photographed or added yourself stays even without its group's pack.
           AND (${ALREADY_OWNED_SQL} OR ${ADDED_IN_TREE_SQL} OR EXISTS (SELECT 1 FROM downloaded_packs dp WHERE dp.region = ANY($5) AND (dp.taxon IS NULL OR dp.taxon = s.taxon_class)))
         ORDER BY s.id, (rs.local_tier IS NULL), s.scientific_name`,
        [userId, countryIds, taxon, hideObscure, countryNames],
      );

      const items = await markNameChanged(
        userId,
        res.rows.map((row) => toCollectionItem(row, maxDepthM)),
      );
      return { items, downloadedCountryNames: countryNames };
    },
  );

  // Counts only, with the same filtering as GET /regions/:id/species, so the header can show a
  // total without waiting for the full list.
  app.get(
    "/regions/:id/species/count",
    {
      preValidation: requireAuth,
      config: regionNotFound,
      schema: {
        params: IdParams,
        querystring: Type.Object({ taxon: TaxonQuery, seaZoneIds: SeaZoneIdsQuery, includeLand: IncludeLandQuery }),
        response: replies(Open({ total: Type.Integer(), collected: Type.Integer(), seen: Type.Integer() })),
      },
    },
    async (request, reply) => {
      const { id: regionId } = request.params;
      const userId = request.user!.id;
      const taxon = request.query.taxon ? splitList(request.query.taxon) : null;
      const seaZoneIds = splitList(request.query.seaZoneIds);
      if (!seaZoneIds.every(isUuid)) return reply.code(404).send({ error: "Sea zone not found" });
      const includeLand = request.query.includeLand !== "0";
      const { hideObscure, maxDepthM } = await getObscurityPreferences(userId);

      const regionRes = await pool.query<{ occurrence_computed_at: Date | null; external_codes: string[] | null }>(
        `SELECT occurrence_computed_at, external_codes FROM regions WHERE id = $1`,
        [regionId],
      );
      const region = regionRes.rows[0];
      if (!region) return reply.code(404).send({ error: "Region not found" });
      // Same rule as GET /regions/:id/species: without its pack, only what's yours counts.
      const needsPack = !region.occurrence_computed_at && (region.external_codes?.length ?? 0) > 0;

      const packRegionName = await resolvePackRegionName(regionId);

      const res = await pool.query<{ total: string; collected: string; seen: string }>(
        `${REGION_VIEW_SPECIES_CTE}
         SELECT
           count(*) AS total,
           count(*) FILTER (WHERE us.state = 'collected') AS collected,
           count(*) FILTER (WHERE us.state = 'seen') AS seen
         FROM species_ids si
         JOIN species s ON s.id = si.species_id
         LEFT JOIN species_traits t ON t.species_id = s.id
         ${REGION_VIEW_JOINS}
         LEFT JOIN user_species us ON us.user_id = ${P.user} AND us.species_id = s.id
         LEFT JOIN user_archived_species uas ON uas.user_id = ${P.user} AND uas.species_id = s.id
         LEFT JOIN region_species_hidden rsh ON rsh.user_id = ${P.user} AND rsh.species_id = s.id AND rsh.region_id = ${P.region}
         WHERE ${regionViewFilterSql(maxDepthM)}`,
        regionViewParams({ userId, regionId, taxon, seaZoneIds, includeLand, hideObscure, packRegionName, needsPack }),
      );
      const row = res.rows[0];
      return { total: Number(row.total), collected: Number(row.collected), seen: Number(row.seen) };
    },
  );
}
