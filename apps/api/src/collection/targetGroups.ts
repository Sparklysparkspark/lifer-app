// "Target a group": every species of a catalog group ("raptors", "owls", "Anatidae") on a region's
// downloaded checklist goes on a target list in one set-based statement. Groups the catalog doesn't
// hold (plants, insects, fungi) answer group: null, and the dialog adds them from iNaturalist.
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { groupTermFor, NAME_MAX_LENGTH, type GroupPredicate } from "@lifer/shared";
import { requireAuth } from "../auth/session.js";
import { Nullable, Uuid, replies, withSchemas } from "../lib/schema.js";
import { speciesInGroupSql } from "../species/speciesInGroupSql.js";
import { addToList } from "./targetLists.js";

const EXAMPLES = 6;

/** The predicate a phrase names: a group word, else a Latin order or family in the catalog. Null
 *  unless at least one catalog species (not an iNaturalist addition) is in it. */
export async function catalogGroup(query: string): Promise<{ label: string; predicate: GroupPredicate } | null> {
  const text = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (text.length < 2) return null;
  let group: { label: string; predicate: GroupPredicate } | null = groupTermFor(text) ?? null;
  if (!group) {
    const latin = await pool.query<{ kind: "order" | "family"; name: string }>(
      `(SELECT 'order' AS kind, taxon_order AS name FROM species WHERE lower(taxon_order) = $1 AND NOT is_other_taxa LIMIT 1)
       UNION ALL
       (SELECT 'family', family FROM species WHERE lower(family) = $1 AND NOT is_other_taxa LIMIT 1)`,
      [text],
    );
    const hit = latin.rows[0];
    if (hit)
      group = {
        label: hit.name,
        predicate: hit.kind === "order" ? { orders: [text] } : { families: [text] },
      };
  }
  if (!group) return null;
  const held = await pool.query(`SELECT 1 ${speciesInGroupSql("$1")} AND NOT s.is_other_taxa LIMIT 1`, [
    JSON.stringify(group.predicate),
  ]);
  return held.rowCount ? group : null;
}

// $1 predicate, $2 region, $3 user, $4 include photographed. The region's checklist and everything
// inside it, the user's own additions there, and its nearby sea zones; never extinct or archived.
const GROUP_SPECIES_SQL = `
  WITH RECURSIVE region_tree AS (
    SELECT id FROM regions WHERE id = $2
    UNION ALL SELECT r.id FROM regions r JOIN region_tree t ON r.parent_id = t.id
  ),
  listed AS (
    SELECT species_id FROM region_species WHERE region_id IN (SELECT id FROM region_tree)
    UNION SELECT species_id FROM region_species_user_added WHERE user_id = $3 AND region_id IN (SELECT id FROM region_tree)
    UNION SELECT species_id FROM sea_zone_species
      WHERE sea_zone_id = ANY(COALESCE((SELECT nearby_sea_zone_ids FROM regions WHERE id = $2), '{}'))
    UNION SELECT species_id FROM sea_zone_species_user_added
      WHERE user_id = $3 AND sea_zone_id = ANY(COALESCE((SELECT nearby_sea_zone_ids FROM regions WHERE id = $2), '{}'))
  )
  SELECT s.id, s.scientific_name AS "scientificName", s.common_name AS "commonName"
  ${speciesInGroupSql("$1")}
    AND s.id IN (SELECT species_id FROM listed)
    AND NOT EXISTS (SELECT 1 FROM species_traits t WHERE t.species_id = s.id AND t.fully_extinct)
    AND NOT EXISTS (SELECT 1 FROM user_archived_species a WHERE a.user_id = $3 AND a.species_id = s.id)
    AND ($4 OR NOT EXISTS (SELECT 1 FROM user_species us WHERE us.user_id = $3 AND us.species_id = s.id
                            AND us.state = 'collected'))
  ORDER BY s.sort_order NULLS LAST, s.scientific_name`;

const regionExists = async (regionId: string) =>
  ((await pool.query(`SELECT 1 FROM regions WHERE id = $1`, [regionId])).rowCount ?? 0) > 0;

export async function targetGroupRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // What a phrase would target. Adds nothing.
  app.get(
    "/collection/targets/by-group",
    {
      preValidation: requireAuth,
      schema: {
        querystring: Type.Object({
          q: Type.String({ minLength: 1, maxLength: 200, description: 'The group words, e.g. "raptors"' }),
          regionId: Type.Optional(Uuid({ description: "Without one, only whether the catalog has the group" })),
          includePhotographed: Type.Optional(
            Type.Enum(["0", "1"], { description: "1 to count species already photographed too" }),
          ),
        }),
        response: replies(
          Type.Object({
            group: Nullable(Type.String({ description: "The group's name; null when the catalog doesn't hold it" })),
            count: Nullable(Type.Integer({ description: "Species it would target; null without a region" })),
            examples: Type.Array(
              Type.Object({ speciesId: Uuid(), scientificName: Type.String(), commonName: Nullable(Type.String()) }),
            ),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { q, regionId, includePhotographed } = request.query;
      const group = await catalogGroup(q);
      if (!group || !regionId) return { group: group?.label ?? null, count: null, examples: [] };
      if (!(await regionExists(regionId))) return reply.code(404).send({ error: "Region not found" });
      const res = await pool.query<{ id: string; scientificName: string; commonName: string | null }>(
        GROUP_SPECIES_SQL,
        [JSON.stringify(group.predicate), regionId, request.user!.id, includePhotographed === "1"],
      );
      return {
        group: group.label,
        count: res.rows.length,
        examples: res.rows.slice(0, EXAMPLES).map(({ id, ...r }) => ({ speciesId: id, ...r })),
      };
    },
  );

  // Answers as POST /target-lists/import does, so POST /target-lists/import/undo takes it back.
  app.post(
    "/collection/targets/by-group",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            q: Type.String({ minLength: 1, maxLength: 200 }),
            regionId: Uuid(),
            listId: Type.Optional(Uuid({ description: "Add to this list instead of making a new one" })),
            name: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX_LENGTH })),
            includePhotographed: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(
          Type.Object({
            listId: Uuid(),
            createdList: Type.Boolean(),
            addedSpeciesIds: Type.Array(Uuid()),
            checklistSpeciesIds: Type.Array(Uuid({ description: "Always empty: only listed species are targeted" })),
          }),
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { q, regionId, listId: existingId, includePhotographed = false } = request.body;
      const name = request.body.name?.trim();
      if (!existingId && !name) return reply.code(400).send({ error: "Give the list a name." });
      if (
        existingId &&
        !(await pool.query(`SELECT 1 FROM target_lists WHERE id = $1 AND user_id = $2`, [existingId, userId])).rowCount
      )
        return reply.code(404).send({ error: "Target list not found" });
      if (!(await regionExists(regionId))) return reply.code(404).send({ error: "Region not found" });
      const group = await catalogGroup(q);
      if (!group) return reply.code(400).send({ error: "Lifer's catalog has no group by that name" });

      return withTransaction(async (db) => {
        const species = await db.query<{ id: string }>(GROUP_SPECIES_SQL, [
          JSON.stringify(group.predicate),
          regionId,
          userId,
          includePhotographed,
        ]);
        const listId =
          existingId ??
          (
            await db.query<{ id: string }>(
              `INSERT INTO target_lists (user_id, name, region_id) VALUES ($1, $2, $3) RETURNING id`,
              [userId, name, regionId],
            )
          ).rows[0].id;
        const addedSpeciesIds = await addToList(
          db,
          userId,
          listId,
          species.rows.map((r) => r.id),
        );
        return { listId, createdList: !existingId, addedSpeciesIds, checklistSpeciesIds: [] };
      });
    },
  );
}
