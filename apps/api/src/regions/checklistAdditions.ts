// Checklist additions: a species you put on a region's or a sea zone's checklist yourself, like a
// hand-imported Other Taxa species on a second province, or a catalog species a checklist is
// missing. Stored in region_species_user_added (migration 124) and sea_zone_species_user_added
// (migration 126), apart from the catalog's region_species and sea_zone_species, so a catalog
// update or a pack install never removes them and removing one never touches catalog data.
// Hand imports (species/otherTaxa.ts) are stored here too.
import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireScope } from "../auth/session.js";
import { IdParams, Nullable, Ok, Uuid, replies, withSchemas } from "../lib/schema.js";

/** Species ids the user added to a region in `region_tree`, for a checklist's species_ids CTE.
 *  `userParam` is the user id's placeholder; `include` is extra SQL that must be true (the land
 *  toggle). Additions roll up: one added to a province shows on its country. */
export const userAddedInTreeSql = (userParam: string, include = "true") =>
  `SELECT species_id FROM region_species_user_added WHERE user_id = ${userParam} AND ${include} AND region_id IN (SELECT id FROM region_tree)`;

/** LEFT JOIN LATERAL as `ua`: the region in `region_tree` the user added species `s` to, with its
 *  name. `preferRegionParam` (the viewed region) wins when it's one of several. */
export const userAddedLateralSql = (userParam: string, preferRegionParam: string | null, include = "true") =>
  `LEFT JOIN LATERAL (
     SELECT a.region_id, ar.name AS region_name
     FROM region_species_user_added a JOIN regions ar ON ar.id = a.region_id
     WHERE a.user_id = ${userParam} AND a.species_id = s.id AND ${include} AND a.region_id IN (SELECT id FROM region_tree)
     ORDER BY ${preferRegionParam ? `(a.region_id = ${preferRegionParam}) DESC, ` : ""}ar.name
     LIMIT 1
   ) ua ON true`;

/** Species ids the user added to one of the selected sea zones (`zonesParam`, a uuid array), for a
 *  checklist's species_ids CTE. Like the catalog's own sea zone species, these show only on a view
 *  with that zone ticked. */
export const userAddedInSeaZonesSql = (userParam: string, zonesParam: string) =>
  `SELECT species_id FROM sea_zone_species_user_added WHERE user_id = ${userParam} AND sea_zone_id = ANY(${zonesParam})`;

/** LEFT JOIN LATERAL as `uz`: the selected sea zone the user added species `s` to, with its name. */
export const userAddedSeaZoneLateralSql = (userParam: string, zonesParam: string) =>
  `LEFT JOIN LATERAL (
     SELECT z.sea_zone_id, sz.name AS sea_zone_name
     FROM sea_zone_species_user_added z JOIN sea_zones sz ON sz.id = z.sea_zone_id
     WHERE z.user_id = ${userParam} AND z.species_id = s.id AND z.sea_zone_id = ANY(${zonesParam})
     ORDER BY sz.name
     LIMIT 1
   ) uz ON true`;

/** True when the user added species `s` to this view's checklist: needs `ua`, and `uz` when the
 *  view can include sea zones. */
export const addedByUserSql = (withSeaZones: boolean) =>
  withSeaZones ? `(ua.region_id IS NOT NULL OR uz.sea_zone_id IS NOT NULL)` : `ua.region_id IS NOT NULL`;

/** Select-list columns marking a row as one the user added, for toCollectionItem. Only where the
 *  catalog doesn't list it in this view (`rs` while the view includes land, or a selected sea
 *  zone's checklist), since removing the addition wouldn't change anything else. A land addition
 *  wins over a sea zone one. */
export function userAddedColumnsSql(view?: { seaZonesParam: string; includeLandParam: string }): string {
  if (!view) {
    return `CASE WHEN rs.region_id IS NULL THEN ua.region_id END AS user_added_region_id,
           CASE WHEN rs.region_id IS NULL THEN ua.region_name END AS user_added_region_name`;
  }
  const listed = `((rs.region_id IS NOT NULL AND ${view.includeLandParam}) OR EXISTS (
       SELECT 1 FROM sea_zone_species szs WHERE szs.species_id = s.id AND szs.sea_zone_id = ANY(${view.seaZonesParam})))`;
  return `CASE WHEN NOT ${listed} THEN COALESCE(ua.region_id, uz.sea_zone_id) END AS user_added_region_id,
           CASE WHEN NOT ${listed} THEN COALESCE(ua.region_name, uz.sea_zone_name) END AS user_added_region_name,
           CASE WHEN NOT ${listed} AND ua.region_id IS NULL AND uz.sea_zone_id IS NOT NULL THEN 'seaZone' END AS user_added_kind`;
}

const AdditionParams = Type.Object({
  regionId: Uuid({ description: "The region whose checklist to change" }),
  speciesId: Uuid({ description: "The species to add or remove" }),
});

const SeaZoneAdditionParams = Type.Object({
  seaZoneId: Uuid({ description: "The sea zone whose checklist to change" }),
  speciesId: Uuid({ description: "The species to add or remove" }),
});

const AddResult = Type.Object({
  ok: Type.Boolean(),
  added: Type.Boolean({ description: "False when you had already added it (nothing changed)" }),
  alreadyOnChecklist: Type.Boolean({
    description: "The catalog already lists this species there, so it showed there before",
  }),
});

const AddedSpecies = Type.Object({
  items: Type.Array(
    Type.Object({
      speciesId: Type.String({ format: "uuid" }),
      scientificName: Type.String(),
      commonName: Type.Union([Type.String(), Type.Null()]),
      addedAt: Type.String({ format: "date-time" }),
      alreadyOnChecklist: Type.Boolean(),
    }),
  ),
});

const SpeciesAdditions = Type.Object({
  items: Type.Array(
    Type.Object({
      regionId: Type.String({ format: "uuid" }),
      regionName: Type.String(),
      addedAt: Type.String({ format: "date-time" }),
      alreadyOnChecklist: Type.Boolean(),
    }),
  ),
  seaZones: Type.Array(
    Type.Object({
      seaZoneId: Type.String({ format: "uuid" }),
      seaZoneName: Type.String(),
      addedAt: Type.String({ format: "date-time" }),
      alreadyOnChecklist: Type.Boolean(),
      nearRegionId: Nullable(
        Type.String({
          format: "uuid",
          description: "A region whose checklist offers this sea zone as nearby water, to view it from",
        }),
      ),
    }),
  ),
});

const SeaZoneList = Type.Object({
  zones: Type.Array(Type.Object({ id: Type.String({ format: "uuid" }), name: Type.String() })),
});

/** The region a checklist addition or a hand import targets, or null when there's none. World and
 *  the continents have no checklist of their own (their page unions their countries'), so an
 *  addition there would never show. A region has one when it, or its parent, has a code: a
 *  country has an ISO code, and a province sits under one (even the few without their own code). */
export async function findChecklistRegion(regionId: string): Promise<{ name: string; hasChecklist: boolean } | null> {
  const res = await pool.query<{ name: string; has_checklist: boolean }>(
    `SELECT r.name,
            COALESCE(array_length(r.external_codes, 1), 0) > 0 OR COALESCE(array_length(p.external_codes, 1), 0) > 0 AS has_checklist
     FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
     WHERE r.id = $1`,
    [regionId],
  );
  const row = res.rows[0];
  return row ? { name: row.name, hasChecklist: row.has_checklist } : null;
}

/** The 400 reply body for a region with no checklist of its own. */
export const noChecklistError = (regionName: string) => ({
  error: `${regionName} has no checklist of its own. Pick a country, or a province or state inside one.`,
  code: "no_checklist",
});

/** Puts a species on a region's checklist for one user. Returns false when it was already there
 *  (added before). Adding a species you'd hidden in that region also unhides it there, since you
 *  asked for it. */
export async function addToRegionChecklist(
  db: Pool | PoolClient,
  userId: string,
  regionId: string,
  speciesId: string,
): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO region_species_user_added (user_id, region_id, species_id) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING`,
    [userId, regionId, speciesId],
  );
  await db.query(`DELETE FROM region_species_hidden WHERE user_id = $1 AND region_id = $2 AND species_id = $3`, [
    userId,
    regionId,
    speciesId,
  ]);
  return (inserted.rowCount ?? 0) > 0;
}

const speciesExists = async (speciesId: string) =>
  ((await pool.query(`SELECT 1 FROM species WHERE id = $1`, [speciesId])).rowCount ?? 0) > 0;

const seaZoneExists = async (seaZoneId: string) =>
  ((await pool.query(`SELECT 1 FROM sea_zones WHERE id = $1`, [seaZoneId])).rowCount ?? 0) > 0;

type AddedSpeciesRow = {
  species_id: string;
  scientific_name: string;
  common_name: string | null;
  added_at: Date;
  on_catalog: boolean;
};
const toAddedSpecies = (rows: AddedSpeciesRow[]) => ({
  items: rows.map((r) => ({
    speciesId: r.species_id,
    scientificName: r.scientific_name,
    commonName: r.common_name,
    addedAt: r.added_at.toISOString(),
    alreadyOnChecklist: r.on_catalog,
  })),
});

export async function regionChecklistAdditionRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // PUT, since adding twice changes nothing: it answers 200 with added: false.
  app.put(
    "/regions/:regionId/checklist-additions/:speciesId",
    {
      preValidation: requireScope("collection.write"),
      schema: { params: AdditionParams, response: replies(AddResult) },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { regionId, speciesId } = request.params;
      const region = await findChecklistRegion(regionId);
      if (!region) return reply.code(404).send({ error: "Region not found" });
      if (!region.hasChecklist) return reply.code(400).send(noChecklistError(region.name));
      if (!(await speciesExists(speciesId))) return reply.code(404).send({ error: "Species not found" });

      const added = await addToRegionChecklist(pool, userId, regionId, speciesId);
      const catalog = await pool.query(`SELECT 1 FROM region_species WHERE region_id = $1 AND species_id = $2`, [
        regionId,
        speciesId,
      ]);
      return { ok: true, added, alreadyOnChecklist: (catalog.rowCount ?? 0) > 0 };
    },
  );

  // Removes only your addition. The catalog's own row for the species, if any, is never touched.
  app.delete(
    "/regions/:regionId/checklist-additions/:speciesId",
    {
      preValidation: requireScope("collection.write"),
      schema: { params: AdditionParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const { regionId, speciesId } = request.params;
      const res = await pool.query(
        `DELETE FROM region_species_user_added WHERE user_id = $1 AND region_id = $2 AND species_id = $3`,
        [request.user!.id, regionId, speciesId],
      );
      if (!res.rowCount) {
        return reply
          .code(404)
          .send({ error: "You haven't added that species to this region's checklist", code: "not_added" });
      }
      return { ok: true };
    },
  );

  app.get(
    "/regions/:id/checklist-additions",
    {
      preValidation: requireScope("collection.read"),
      schema: { params: IdParams, response: replies(AddedSpecies) },
    },
    async (request, reply) => {
      const { id: regionId } = request.params;
      if (!(await findChecklistRegion(regionId))) return reply.code(404).send({ error: "Region not found" });
      const res = await pool.query<AddedSpeciesRow>(
        `SELECT s.id AS species_id, s.scientific_name, s.common_name, a.added_at,
                EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = a.region_id AND rs.species_id = a.species_id) AS on_catalog
         FROM region_species_user_added a JOIN species s ON s.id = a.species_id
         WHERE a.user_id = $1 AND a.region_id = $2
         ORDER BY COALESCE(s.common_name, s.scientific_name)`,
        [request.user!.id, regionId],
      );
      return toAddedSpecies(res.rows);
    },
  );

  // Every sea zone, for picking one to add a species to. Each has a checklist of its own (its
  // pack), so any of them can take an addition.
  app.get(
    "/sea-zones",
    { preValidation: requireScope("collection.read"), schema: { response: replies(SeaZoneList) } },
    async () => {
      const res = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM sea_zones ORDER BY name`);
      return { zones: res.rows };
    },
  );

  app.put(
    "/sea-zones/:seaZoneId/checklist-additions/:speciesId",
    {
      preValidation: requireScope("collection.write"),
      schema: { params: SeaZoneAdditionParams, response: replies(AddResult) },
    },
    async (request, reply) => {
      const { seaZoneId, speciesId } = request.params;
      if (!(await seaZoneExists(seaZoneId))) return reply.code(404).send({ error: "Sea zone not found" });
      if (!(await speciesExists(speciesId))) return reply.code(404).send({ error: "Species not found" });
      const inserted = await pool.query(
        `INSERT INTO sea_zone_species_user_added (user_id, sea_zone_id, species_id) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [request.user!.id, seaZoneId, speciesId],
      );
      const catalog = await pool.query(`SELECT 1 FROM sea_zone_species WHERE sea_zone_id = $1 AND species_id = $2`, [
        seaZoneId,
        speciesId,
      ]);
      return { ok: true, added: (inserted.rowCount ?? 0) > 0, alreadyOnChecklist: (catalog.rowCount ?? 0) > 0 };
    },
  );

  app.delete(
    "/sea-zones/:seaZoneId/checklist-additions/:speciesId",
    {
      preValidation: requireScope("collection.write"),
      schema: { params: SeaZoneAdditionParams, response: replies(Ok) },
    },
    async (request, reply) => {
      const { seaZoneId, speciesId } = request.params;
      const res = await pool.query(
        `DELETE FROM sea_zone_species_user_added WHERE user_id = $1 AND sea_zone_id = $2 AND species_id = $3`,
        [request.user!.id, seaZoneId, speciesId],
      );
      if (!res.rowCount) {
        return reply
          .code(404)
          .send({ error: "You haven't added that species to this sea zone's checklist", code: "not_added" });
      }
      return { ok: true };
    },
  );

  app.get(
    "/sea-zones/:id/checklist-additions",
    {
      preValidation: requireScope("collection.read"),
      schema: { params: IdParams, response: replies(AddedSpecies) },
    },
    async (request, reply) => {
      const { id: seaZoneId } = request.params;
      if (!(await seaZoneExists(seaZoneId))) return reply.code(404).send({ error: "Sea zone not found" });
      const res = await pool.query<AddedSpeciesRow>(
        `SELECT s.id AS species_id, s.scientific_name, s.common_name, a.added_at,
                EXISTS (SELECT 1 FROM sea_zone_species zs WHERE zs.sea_zone_id = a.sea_zone_id AND zs.species_id = a.species_id) AS on_catalog
         FROM sea_zone_species_user_added a JOIN species s ON s.id = a.species_id
         WHERE a.user_id = $1 AND a.sea_zone_id = $2
         ORDER BY COALESCE(s.common_name, s.scientific_name)`,
        [request.user!.id, seaZoneId],
      );
      return toAddedSpecies(res.rows);
    },
  );

  app.get(
    "/species/:id/checklist-additions",
    {
      preValidation: requireScope("collection.read"),
      schema: { params: IdParams, response: replies(SpeciesAdditions) },
    },
    async (request, reply) => {
      const { id: speciesId } = request.params;
      const userId = request.user!.id;
      if (!(await speciesExists(speciesId))) return reply.code(404).send({ error: "Species not found" });
      const [regions, zones] = await Promise.all([
        pool.query<{ region_id: string; region_name: string; added_at: Date; on_catalog: boolean }>(
          `SELECT r.id AS region_id, r.name AS region_name, a.added_at,
                  EXISTS (SELECT 1 FROM region_species rs WHERE rs.region_id = a.region_id AND rs.species_id = a.species_id) AS on_catalog
           FROM region_species_user_added a JOIN regions r ON r.id = a.region_id
           WHERE a.user_id = $1 AND a.species_id = $2
           ORDER BY r.name`,
          [userId, speciesId],
        ),
        // A sea zone has no page of its own: it shows as nearby water on a coastal region's
        // checklist. nearRegionId is one such region, preferring a downloaded country.
        pool.query<{
          sea_zone_id: string;
          sea_zone_name: string;
          added_at: Date;
          on_catalog: boolean;
          near_region_id: string | null;
        }>(
          `SELECT z.id AS sea_zone_id, z.name AS sea_zone_name, a.added_at,
                  EXISTS (SELECT 1 FROM sea_zone_species zs WHERE zs.sea_zone_id = a.sea_zone_id AND zs.species_id = a.species_id) AS on_catalog,
                  (SELECT r.id FROM regions r LEFT JOIN regions p ON p.id = r.parent_id
                   WHERE a.sea_zone_id = ANY(r.nearby_sea_zone_ids)
                   ORDER BY EXISTS (SELECT 1 FROM downloaded_packs dp WHERE dp.region = r.name) DESC,
                            (COALESCE(array_length(p.external_codes, 1), 0) = 0) DESC,
                            r.name
                   LIMIT 1) AS near_region_id
           FROM sea_zone_species_user_added a JOIN sea_zones z ON z.id = a.sea_zone_id
           WHERE a.user_id = $1 AND a.species_id = $2
           ORDER BY z.name`,
          [userId, speciesId],
        ),
      ]);
      return {
        items: regions.rows.map((r) => ({
          regionId: r.region_id,
          regionName: r.region_name,
          addedAt: r.added_at.toISOString(),
          alreadyOnChecklist: r.on_catalog,
        })),
        seaZones: zones.rows.map((z) => ({
          seaZoneId: z.sea_zone_id,
          seaZoneName: z.sea_zone_name,
          addedAt: z.added_at.toISOString(),
          alreadyOnChecklist: z.on_catalog,
          nearRegionId: z.near_region_id,
        })),
      };
    },
  );
}
