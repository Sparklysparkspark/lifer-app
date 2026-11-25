// Named target lists (migration 195): import one from a CSV (preview, then save), undo the last
// import, and list, rename or delete them. A list only ever sets user_species.is_target; removing
// species from a list clears it for those on no other list that weren't targets beforehand.
// shortcut: a species unflagged and flagged again by hand while a list holds it isn't marked
// direct, so deleting the list clears it; set target_list_species.direct in the card and bulk
// target routes if that comes up.
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { Type } from "typebox";
import { pool } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { IdParams, Nullable, Ok, Uuid, replies, withSchemas } from "../lib/schema.js";
import { addToRegionChecklist, findChecklistRegion } from "../regions/checklistAdditions.js";
import { NAME_MAX_LENGTH } from "@lifer/shared";
import { MAX_NAMES, pickMatches, readTargetNames, type NameHit } from "./targetListCsv.js";

const MAX_SPECIES = 50_000;
const ListName = Type.String({ minLength: 1, maxLength: NAME_MAX_LENGTH });

const TargetList = Type.Object({
  id: Uuid(),
  name: Type.String(),
  regionId: Nullable(Uuid()),
  regionName: Nullable(Type.String()),
  speciesIds: Type.Array(Uuid()),
});

const PreviewOption = Type.Object({
  speciesId: Uuid(),
  scientificName: Type.String(),
  commonName: Nullable(Type.String()),
  state: Nullable(Type.Union([Type.Literal("collected"), Type.Literal("seen")])),
  onChecklist: Type.Boolean({ description: "On the chosen region's checklist; true with no region" }),
});
const Preview = Type.Object({
  rows: Type.Array(
    Type.Object({
      name: Type.String(),
      status: Type.Union([Type.Literal("matched"), Type.Literal("ambiguous"), Type.Literal("unmatched")]),
      options: Type.Array(PreviewOption),
    }),
  ),
  canAddToChecklist: Type.Boolean({ description: "The region has a checklist of its own to add species to" }),
});

const ImportResult = Type.Object({
  listId: Uuid(),
  createdList: Type.Boolean(),
  addedSpeciesIds: Type.Array(Uuid()),
  checklistSpeciesIds: Type.Array(Uuid()),
  leftAlone: Type.Integer({ description: "Species already seen or photographed, left as they were" }),
});

/** Puts species on a list and makes them targets; answers the ones the list didn't hold yet. */
export async function addToList(db: PoolClient, userId: string, listId: string, speciesIds: string[]) {
  // `direct` carries over from another list that holds the species, else is whether the user had
  // flagged it already.
  const added = await db.query<{ species_id: string }>(
    `INSERT INTO target_list_species (list_id, species_id, direct)
     SELECT $1, s.id, COALESCE(
       (SELECT bool_or(t.direct) FROM target_list_species t JOIN target_lists l ON l.id = t.list_id
        WHERE l.user_id = $3 AND t.species_id = s.id),
       (SELECT us.is_target FROM user_species us WHERE us.user_id = $3 AND us.species_id = s.id),
       false)
     FROM unnest($2::uuid[]) s(id)
     ON CONFLICT DO NOTHING RETURNING species_id`,
    [listId, speciesIds, userId],
  );
  const ids = added.rows.map((r) => r.species_id);
  await db.query(
    `INSERT INTO user_species (user_id, species_id, is_target) SELECT $1, UNNEST($2::uuid[]), true
     ON CONFLICT (user_id, species_id) DO UPDATE SET is_target = true WHERE NOT user_species.is_target`,
    [userId, ids],
  );
  return ids;
}

/** Takes species off a list and clears the target flag where nothing else holds it. */
export async function removeFromList(db: PoolClient, userId: string, listId: string, speciesIds: string[] | null) {
  // The CTE's delete isn't visible to the NOT EXISTS, hence the explicit list_id check.
  const released = await db.query<{ species_id: string }>(
    `WITH gone AS (
       DELETE FROM target_list_species WHERE list_id = $2 AND ($3::uuid[] IS NULL OR species_id = ANY($3))
       RETURNING species_id, direct
     )
     UPDATE user_species us SET is_target = false FROM gone
     WHERE us.user_id = $1 AND us.species_id = gone.species_id AND us.is_target AND NOT gone.direct
       AND NOT EXISTS (SELECT 1 FROM target_list_species t JOIN target_lists l ON l.id = t.list_id
                       WHERE l.user_id = $1 AND t.species_id = us.species_id AND t.list_id <> $2)
     RETURNING us.species_id`,
    [userId, listId, speciesIds],
  );
  // A row with no state and no target is gone, as in collection/bulk.ts.
  await db.query(
    `DELETE FROM user_species WHERE user_id = $1 AND species_id = ANY($2) AND state IS NULL AND NOT is_target
       AND cover_photo_id IS NULL`,
    [userId, released.rows.map((r) => r.species_id)],
  );
}

async function inTransaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

const ownsList = async (userId: string, listId: string) =>
  ((await pool.query(`SELECT 1 FROM target_lists WHERE id = $1 AND user_id = $2`, [listId, userId])).rowCount ?? 0) > 0;

/** The species of `ids` on the region's checklist: the catalog's or the user's own additions,
 *  in the region or any region inside it. */
async function onRegionChecklist(userId: string, regionId: string, ids: string[]): Promise<Set<string>> {
  const res = await pool.query<{ species_id: string }>(
    `WITH RECURSIVE region_tree AS (
       SELECT id FROM regions WHERE id = $1
       UNION ALL SELECT r.id FROM regions r JOIN region_tree t ON r.parent_id = t.id
     )
     SELECT species_id FROM region_species WHERE species_id = ANY($2) AND region_id IN (SELECT id FROM region_tree)
     UNION
     SELECT species_id FROM region_species_user_added
     WHERE user_id = $3 AND species_id = ANY($2) AND region_id IN (SELECT id FROM region_tree)`,
    [regionId, ids, userId],
  );
  return new Set(res.rows.map((r) => r.species_id));
}

export async function targetListRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get(
    "/target-lists",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ lists: Type.Array(TargetList) })) } },
    async (request) => {
      const res = await pool.query(
        `SELECT l.id, l.name, l.region_id AS "regionId", r.name AS "regionName",
                COALESCE(array_agg(t.species_id) FILTER (WHERE t.species_id IS NOT NULL), '{}') AS "speciesIds"
         FROM target_lists l LEFT JOIN regions r ON r.id = l.region_id
         LEFT JOIN target_list_species t ON t.list_id = l.id
         WHERE l.user_id = $1 GROUP BY l.id, r.name ORDER BY lower(l.name), l.created_at`,
        [request.user!.id],
      );
      return { lists: res.rows };
    },
  );

  app.patch(
    "/target-lists/:id",
    {
      preValidation: requireAuth,
      schema: {
        params: IdParams,
        body: Type.Object({ name: ListName }, { additionalProperties: false }),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const name = request.body.name.trim();
      if (!name) return reply.code(400).send({ error: "Give the list a name." });
      const res = await pool.query(`UPDATE target_lists SET name = $3 WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        request.user!.id,
        name,
      ]);
      if (!res.rowCount) return reply.code(404).send({ error: "Target list not found" });
      return { ok: true };
    },
  );

  app.delete(
    "/target-lists/:id",
    { preValidation: requireAuth, schema: { params: IdParams, response: replies(Ok) } },
    async (request, reply) => {
      const userId = request.user!.id;
      const listId = request.params.id;
      if (!(await ownsList(userId, listId))) return reply.code(404).send({ error: "Target list not found" });
      await inTransaction(async (db) => {
        await removeFromList(db, userId, listId, null);
        await db.query(`DELETE FROM target_lists WHERE id = $1`, [listId]);
      });
      return { ok: true };
    },
  );

  // Multipart, like the eBird import: the handler reads and checks the file itself.
  app.post(
    "/target-lists/preview",
    {
      preValidation: requireAuth,
      schema: { querystring: Type.Object({ regionId: Type.Optional(Uuid()) }), response: replies(Preview) },
    },
    async (request, reply) => {
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: "Choose a CSV file." });
      let names: string[];
      try {
        names = readTargetNames((await file.toBuffer()).toString("utf-8"));
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      const userId = request.user!.id;
      const { regionId } = request.query;
      const region = regionId ? await findChecklistRegion(regionId) : null;
      if (regionId && !region) return reply.code(404).send({ error: "Region not found" });

      // species_search_names holds every name normalized and indexed (migration 111).
      const hits = await pool.query<NameHit>(
        `SELECT i.name, n.species_id AS "speciesId", n.kind
         FROM unnest($1::text[]) i(name)
         JOIN species_search_names n ON n.name_norm = lifer_search_norm(i.name)
         WHERE n.kind IN ('scientific', 'synonym', 'common', 'alias')`,
        [names.slice(0, MAX_NAMES)],
      );
      const matches = pickMatches(names, hits.rows);
      const ids = [...new Set(matches.flatMap((m) => m.speciesIds))];
      const info = await pool.query<{
        id: string;
        scientific_name: string;
        common_name: string | null;
        state: "collected" | "seen" | null;
      }>(
        `SELECT s.id, s.scientific_name, s.common_name, us.state FROM species s
         LEFT JOIN user_species us ON us.species_id = s.id AND us.user_id = $2
         WHERE s.id = ANY($1)`,
        [ids, userId],
      );
      const byId = new Map(info.rows.map((r) => [r.id, r]));
      const listed = regionId ? await onRegionChecklist(userId, regionId, ids) : null;
      return {
        rows: matches.map((m) => ({
          name: m.name,
          status: m.status,
          options: m.speciesIds.map((id) => {
            const s = byId.get(id)!;
            return {
              speciesId: id,
              scientificName: s.scientific_name,
              commonName: s.common_name,
              state: s.state,
              onChecklist: listed ? listed.has(id) : true,
            };
          }),
        })),
        canAddToChecklist: !!region?.hasChecklist,
      };
    },
  );

  app.post(
    "/target-lists/import",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            listId: Type.Optional(Uuid({ description: "Add to this list instead of making a new one" })),
            name: Type.Optional(ListName),
            regionId: Type.Optional(Nullable(Uuid())),
            speciesIds: Type.Array(Uuid(), { maxItems: MAX_SPECIES }),
            addToChecklist: Type.Optional(
              Type.Boolean({ description: "Put species missing from the region's checklist on it" }),
            ),
          },
          { additionalProperties: false },
        ),
        response: replies(ImportResult),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { listId: existingId, speciesIds, addToChecklist } = request.body;
      const name = request.body.name?.trim();
      let regionId = request.body.regionId ?? null;
      if (existingId) {
        const res = await pool.query<{ region_id: string | null }>(
          `SELECT region_id FROM target_lists WHERE id = $1 AND user_id = $2`,
          [existingId, userId],
        );
        if (!res.rowCount) return reply.code(404).send({ error: "Target list not found" });
        regionId = res.rows[0].region_id;
      } else if (!name) return reply.code(400).send({ error: "Give the list a name." });
      const region = regionId ? await findChecklistRegion(regionId) : null;
      if (regionId && !region) return reply.code(404).send({ error: "Region not found" });

      return inTransaction(async (db) => {
        const listId =
          existingId ??
          (
            await db.query<{ id: string }>(
              `INSERT INTO target_lists (user_id, name, region_id) VALUES ($1, $2, $3) RETURNING id`,
              [userId, name, regionId],
            )
          ).rows[0].id;
        // Seen or photographed species keep their state and stay off the list.
        const open = await db.query<{ id: string }>(
          `SELECT s.id FROM species s LEFT JOIN user_species us ON us.species_id = s.id AND us.user_id = $2
           WHERE s.id = ANY($1) AND us.state IS NULL`,
          [speciesIds, userId],
        );
        const ids = open.rows.map((r) => r.id);
        const checklistSpeciesIds: string[] = [];
        if (regionId && addToChecklist && region?.hasChecklist) {
          const listed = await onRegionChecklist(userId, regionId, ids);
          for (const id of ids.filter((i) => !listed.has(i))) {
            if (await addToRegionChecklist(db, userId, regionId, id)) checklistSpeciesIds.push(id);
          }
        }
        const addedSpeciesIds = await addToList(db, userId, listId, ids);
        return {
          listId,
          createdList: !existingId,
          addedSpeciesIds,
          checklistSpeciesIds,
          leftAlone: new Set(speciesIds).size - ids.length,
        };
      });
    },
  );

  // Takes back what one import did: its species on the list, its checklist additions, and the
  // list itself when the import made it.
  app.post(
    "/target-lists/import/undo",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            listId: Uuid(),
            createdList: Type.Boolean(),
            addedSpeciesIds: Type.Array(Uuid(), { maxItems: MAX_SPECIES }),
            checklistSpeciesIds: Type.Array(Uuid(), { maxItems: MAX_SPECIES }),
          },
          { additionalProperties: false },
        ),
        response: replies(Ok),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const { listId, createdList, addedSpeciesIds, checklistSpeciesIds } = request.body;
      const list = await pool.query<{ region_id: string | null }>(
        `SELECT region_id FROM target_lists WHERE id = $1 AND user_id = $2`,
        [listId, userId],
      );
      if (!list.rowCount) return reply.code(404).send({ error: "Target list not found" });
      await inTransaction(async (db) => {
        await removeFromList(db, userId, listId, createdList ? null : addedSpeciesIds);
        if (createdList) await db.query(`DELETE FROM target_lists WHERE id = $1`, [listId]);
        if (list.rows[0].region_id && checklistSpeciesIds.length > 0)
          await db.query(
            `DELETE FROM region_species_user_added WHERE user_id = $1 AND region_id = $2 AND species_id = ANY($3)`,
            [userId, list.rows[0].region_id, checklistSpeciesIds],
          );
      });
      return { ok: true };
    },
  );
}
