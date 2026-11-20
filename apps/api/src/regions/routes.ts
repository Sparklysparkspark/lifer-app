// Region browsing: the region list, taxa present, sea zones and drill-down. A region's species
// checklist is in checklist.ts. The GBIF computation that builds checklists is script-only and
// lives in compute/.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth } from "../auth/session.js";
import { IdParams, Open, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { RAW_CACHE_DIR } from "@lifer/core/config.js";
import { fetchProvincesForCountry } from "@lifer/core/regions/regionBoundary.js";
import { exteriorRingsFromGeometry, type BoundingBox } from "@lifer/core/lib/geometry.js";
import { nearbyZones, resolveCountryRings } from "@lifer/core/regions/nearbyZones.js";
import { regionBoundaryRoutes } from "./boundaries.js";
import { regionAtRoutes } from "./regionAt.js";
import { RegionList } from "./responses.js";
import { regionChecklistRoutes } from "./checklist.js";
import { regionHiddenSpeciesRoutes } from "./hiddenSpecies.js";
import { regionChecklistAdditionRoutes } from "./checklistAdditions.js";
import { createProvinces } from "./provinces.js";

const regionNotFound = notFoundOnInvalidId("Region not found");

export async function regionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/regions", { preValidation: requireAuth, schema: { response: replies(RegionList) } }, async () => {
    // Boundaries are left out (hundreds of KB each); the map gets one region's outline from
    // GET /regions/:id/species and all countries' from GET /regions/boundaries.
    const res = await pool.query(
      // Guantanamo Bay naval base ("USG") is left out: no civilian access.
      `SELECT id, name, parent_id, ebird_region_code, has_children, external_codes, sovereignty_group, is_sovereign_dependency,
              example_city, populous_child_id, aliases
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
        exampleCity: r.example_city,
        populousChildId: r.populous_child_id,
        aliases: r.aliases,
      })),
    };
  });

  // Which taxa each region has any species in (downloaded or not), so the Collection can hide a
  // taxon filter that would show nothing. The client unions the result across its selection.
  app.get(
    "/regions/taxon-presence",
    {
      preValidation: requireAuth,
      // Comma-separated region ids, checked below.
      schema: { querystring: Type.Object({ regionIds: Type.String() }) },
    },
    async (request, reply) => {
      const regionIds = request.query.regionIds.split(",").filter(Boolean);
      if (regionIds.length === 0) return reply.code(400).send({ error: "regionIds is required" });
      if (!regionIds.every(isUuid)) return reply.code(400).send({ error: "regionIds must be region ids" });
      // The catalog's checklist for the region itself, plus the user's own additions, which roll
      // up from the regions inside it (and down from those above) like on the checklist (that's how a hand-imported group like
      // "insecta" gets its filter). root_region_id maps each row back to the requested region.
      const res = await pool.query<{ root_region_id: string; taxon_class: string }>(
        `WITH RECURSIVE region_tree AS (
           SELECT id, id AS root_region_id FROM regions WHERE id = ANY($1)
           UNION ALL
           SELECT r.id, rt.root_region_id FROM regions r JOIN region_tree rt ON r.parent_id = rt.id
         )
         SELECT DISTINCT root_region_id, taxon_class FROM (
           SELECT rs.region_id AS root_region_id, s.taxon_class
           FROM region_species rs
           JOIN species s ON s.id = rs.species_id
           WHERE rs.region_id = ANY($1)
           UNION ALL
           SELECT rt.root_region_id, s.taxon_class
           FROM region_tree rt
           JOIN region_species_user_added a ON a.region_id = rt.id AND a.user_id = $2
           JOIN species s ON s.id = a.species_id
           UNION ALL
           -- And down from a region above, like the checklist (migration 144).
           SELECT root.id, s.taxon_class
           FROM unnest($1::uuid[]) AS root(id)
           CROSS JOIN LATERAL user_added_from_above($2, root.id) f
           JOIN species s ON s.id = f.species_id
         ) combined`,
        [regionIds, request.user!.id],
      );
      const byRegion: Record<string, string[]> = {};
      for (const id of regionIds) byRegion[id] = [];
      for (const row of res.rows) byRegion[row.root_region_id]?.push(row.taxon_class);
      return byRegion;
    },
  );

  // Taxa the user has photographed in this region or anywhere inside it, so the Collection
  // offers that taxon's filter even without its pack.
  app.get(
    "/regions/:id/photographed-taxa",
    {
      preValidation: requireAuth,
      config: regionNotFound,
      schema: { params: IdParams, response: replies(Open({ taxa: Type.Array(Type.String()) })) },
    },
    async (request) => {
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
    },
  );

  // Nearby sea zones offered as checkboxes. Reads the precomputed nearby_sea_zone_ids, since the
  // geometry is costly enough to block the event loop; a NULL is computed once and stored.
  app.get(
    "/regions/:id/sea-zones",
    {
      preValidation: requireAuth,
      config: regionNotFound,
      schema: {
        params: IdParams,
        response: replies(
          Open({ zones: Type.Array(Open({ id: Uuid(), name: Type.String(), addedByYou: Type.Integer() })) }),
        ),
      },
    },
    async (request, reply) => {
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
      // addedByYou: species you added to that zone yourself, so the page can offer the zone even
      // where it otherwise wouldn't (no fish pack).
      const namesRes = await pool.query<{ id: string; name: string; added_by_you: number }>(
        `SELECT z.id, z.name,
                (SELECT count(*)::int FROM sea_zone_species_user_added a WHERE a.sea_zone_id = z.id AND a.user_id = $2) AS added_by_you
         FROM sea_zones z WHERE z.id = ANY($1) ORDER BY z.name`,
        [zoneIds, request.user!.id],
      );
      return { zones: namesRes.rows.map((z) => ({ id: z.id, name: z.name, addedByYou: z.added_by_you })) };
    },
  );

  // Creates a country's provinces from the cached Natural Earth admin-1 file. Downloading the
  // country's pack does this too; this covers countries with no pack yet.
  // No body schema: the web app sends `{}` and nothing in it is read.
  app.post(
    "/regions/:id/drill-down",
    {
      preValidation: requireAuth,
      config: regionNotFound,
      schema: { params: IdParams, response: replies(Type.Object({ ok: Type.Boolean(), created: Type.Integer() })) },
    },
    async (request, reply) => {
      const { id: regionId } = request.params;

      const regionRes = await pool.query(
        `SELECT id, name, external_codes, has_children, home_country_id FROM regions WHERE id = $1`,
        [regionId],
      );
      const region = regionRes.rows[0];
      if (!region) return reply.code(404).send({ error: "Region not found" });
      // A province shown under its continent has nothing below it.
      if (region.has_children || region.home_country_id) return { ok: true, created: 0 };
      if (!region.external_codes?.length) {
        return reply.code(400).send({ error: "This region has no country code to drill down from" });
      }

      const provinces = await fetchProvincesForCountry(region.external_codes[0], RAW_CACHE_DIR);
      await createProvinces(pool, regionId, provinces);
      const created = provinces.length;

      return { ok: true, created };
    },
  );

  await app.register(regionBoundaryRoutes);
  await app.register(regionAtRoutes);
  await app.register(regionChecklistRoutes);
  await app.register(regionHiddenSpeciesRoutes);
  await app.register(regionChecklistAdditionRoutes);
}
