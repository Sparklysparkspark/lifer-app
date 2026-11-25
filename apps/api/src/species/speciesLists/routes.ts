// Lists added from iNaturalist ("spiders of Canada"). Session only: no API key reaches these, so
// Preen and other integrations never receive iNaturalist-derived species data from them.
import type { FastifyInstance, FastifyReply } from "fastify";
import { Type, type Static } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { NAME_MAX_LENGTH } from "@lifer/shared";
import { removeFromList } from "../../collection/targetLists.js";
import { requireAuth } from "../../auth/session.js";
import { DateTime, IdParams, Nullable, notFoundOnInvalidId, replies, Uuid, withSchemas } from "../../lib/schema.js";
import { isUuid } from "../../lib/validate.js";
import { findChecklistRegion, noChecklistError } from "../../regions/checklistAdditions.js";
import { requireAnyTaxaSearchEnabled } from "../otherTaxa.js";
import { InatUnavailableError, LIST_SIZE_CAP, PER_PAGE, previewList, searchPlaces, searchTaxa } from "./inat.js";
import { deleteList, listForUser, listsForUser, targetSpecies, type SpeciesListRow } from "./store.js";
import { kickSpeciesLists, speciesListJob, stopListIfRunning } from "./worker.js";

const SpeciesList = Type.Object({
  id: Uuid(),
  name: Type.String(),
  taxon: Type.Object({ id: Type.Integer(), name: Type.String(), rank: Nullable(Type.String()) }),
  place: Type.Object({ id: Type.Integer(), name: Type.String() }),
  regionId: Uuid({ description: "The region whose checklist the species are added to" }),
  nativeOnly: Type.Boolean(),
  sizeEstimate: Nullable(Type.Integer({ description: "iNaturalist's species count, null before the first page" })),
  addedCount: Type.Integer(),
  status: Type.Union([
    Type.Literal("queued"),
    Type.Literal("running"),
    Type.Literal("paused"),
    Type.Literal("offline"),
    Type.Literal("done"),
    Type.Literal("failed"),
  ]),
  lastError: Nullable(Type.String({ description: "offline, rate_limited, refused or failed" })),
  nextBatchAt: Nullable(DateTime({ description: "When a waiting batch or retry starts on its own" })),
  capped: Type.Boolean({ description: `Bigger than ${LIST_SIZE_CAP} species, so added in batches` }),
  fetchingNow: Type.Boolean(),
  photosReady: Type.Integer({ description: "Members with a downloaded reference photo" }),
  hidden: Type.Boolean(),
  targetListId: Nullable(Uuid({ description: "The target list its species also go on, null when off" })),
  createdAt: DateTime(),
  updatedAt: DateTime(),
  lastRefreshedAt: Nullable(DateTime()),
});
type SpeciesListOut = Static<typeof SpeciesList>;
const OneList = Type.Object({ list: SpeciesList });

const QueryBody = {
  taxonId: Type.Integer({ minimum: 1, description: "iNaturalist taxon id" }),
  placeId: Type.Integer({ minimum: 1, description: "iNaturalist place id" }),
  nativeOnly: Type.Optional(Type.Boolean()),
};
const CreateBody = Type.Object(
  {
    ...QueryBody,
    taxonName: Type.String({ minLength: 1, maxLength: 500, description: "As the taxon chip shows it" }),
    taxonRank: Type.Optional(Type.String({ maxLength: 50 })),
    placeName: Type.String({ minLength: 1, maxLength: 500 }),
    regionId: Type.Optional(Uuid({ description: "Default: the region with this iNaturalist place" })),
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    targets: Type.Optional(
      Type.Object(
        {
          listId: Type.Optional(Uuid({ description: "Default: a new target list named after the list" })),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: NAME_MAX_LENGTH })),
          photographed: Type.Optional(Type.Boolean({ description: "Also target species already photographed" })),
        },
        { additionalProperties: false, description: "Every species the list adds also becomes a target" },
      ),
    ),
  },
  { additionalProperties: false },
);
const Preview = Type.Object({
  count: Type.Integer(),
  examples: Type.Array(
    Type.Object({ taxonId: Type.Integer(), scientificName: Type.String(), commonName: Nullable(Type.String()) }),
  ),
  batches: Type.Integer({ description: `Batches of up to ${LIST_SIZE_CAP} species` }),
  estimatedMinutes: Type.Integer({ description: "Fetching plus one photo per species" }),
});
const TaxonResults = Type.Object({
  results: Type.Array(
    Type.Object({
      taxonId: Type.Integer(),
      name: Type.String(),
      rank: Nullable(Type.String()),
      commonName: Nullable(Type.String()),
      iconicTaxon: Nullable(Type.String()),
      observationsCount: Nullable(Type.Integer()),
      thumbnailUrl: Nullable(Type.String()),
    }),
  ),
});
const PlaceResults = Type.Object({
  results: Type.Array(
    Type.Object({
      placeId: Type.Integer(),
      name: Type.String(),
      displayName: Type.String(),
      adminLevel: Nullable(Type.Integer()),
      regionId: Nullable(Uuid({ description: "The Lifer region with this place, if any" })),
    }),
  ),
  inatUnavailable: Nullable(Type.String({ description: "Set when only Lifer's own regions could be searched" })),
});
const SearchQuery = Type.Object({ q: Type.String({ minLength: 2, maxLength: 200 }) });

const toApi = (l: SpeciesListRow & { photos_ready: number }): SpeciesListOut => ({
  id: l.id,
  name: l.name,
  taxon: { id: l.inat_taxon_id, name: l.taxon_name, rank: l.taxon_rank },
  place: { id: l.inat_place_id, name: l.place_name },
  regionId: l.region_id,
  nativeOnly: l.native_only,
  sizeEstimate: l.size_estimate,
  addedCount: l.added_count,
  status: l.status,
  lastError: l.last_error,
  nextBatchAt: l.next_batch_at?.toISOString() ?? null,
  capped: (l.size_estimate ?? 0) > LIST_SIZE_CAP,
  fetchingNow: speciesListJob.status.running && speciesListJob.status.listId === l.id,
  photosReady: l.photos_ready,
  hidden: l.hidden,
  targetListId: l.target_list_id,
  createdAt: l.created_at.toISOString(),
  updatedAt: l.updated_at.toISOString(),
  lastRefreshedAt: l.last_refreshed_at?.toISOString() ?? null,
});

function unavailable(reply: FastifyReply, err: unknown) {
  if (!(err instanceof InatUnavailableError)) throw err;
  return reply.code(503).send({ error: "iNaturalist can't be reached right now", code: err.code });
}

// The region a list goes on when none is given: one Lifer region with that iNaturalist place.
async function regionForPlace(placeId: number): Promise<string | null> {
  const res = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE inat_place_id = $1 ORDER BY name`, [
    placeId,
  ]);
  for (const r of res.rows) if ((await findChecklistRegion(r.id))?.hasChecklist) return r.id;
  return null;
}

export async function speciesListRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);
  const byId = { preValidation: requireAuth, config: notFoundOnInvalidId("List not found") };
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: "List not found", code: "not_found" });

  app.get(
    "/species-lists",
    { preValidation: requireAuth, schema: { response: replies(Type.Object({ lists: Type.Array(SpeciesList) })) } },
    async (request) => ({ lists: (await listsForUser(request.user!.id)).map(toApi) }),
  );

  // One cached species_counts call: the count and the most observed examples. Adds nothing.
  app.post(
    "/species-lists/preview",
    {
      preValidation: requireAuth,
      schema: { body: Type.Object(QueryBody, { additionalProperties: false }), response: replies(Preview) },
    },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      const { taxonId, placeId, nativeOnly = false } = request.body;
      try {
        const page = await previewList({ taxonId, placeId, nativeOnly });
        const count = page.total;
        // About a second a page, then a photo every two seconds or so.
        const seconds = Math.ceil(count / PER_PAGE) * 1.5 + count * 2;
        return {
          count,
          examples: page.species.map((s) => ({
            taxonId: s.taxonId,
            scientificName: s.scientificName,
            commonName: s.commonName,
          })),
          batches: Math.ceil(count / LIST_SIZE_CAP),
          estimatedMinutes: Math.ceil(seconds / 60),
        };
      } catch (err) {
        return unavailable(reply, err);
      }
    },
  );

  // Creates the list and starts adding it in the background. The same taxon, place and region
  // again answers the existing list.
  app.post(
    "/species-lists",
    {
      preValidation: requireAuth,
      schema: { body: CreateBody, response: replies(Type.Object({ list: SpeciesList, created: Type.Boolean() })) },
    },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      const userId = request.user!.id;
      const b = request.body;
      const regionId = b.regionId ?? (await regionForPlace(b.placeId));
      if (!regionId) return reply.code(400).send({ error: "Pick the region to add this list to", code: "no_region" });
      const region = isUuid(regionId) ? await findChecklistRegion(regionId) : null;
      if (!region) return reply.code(404).send({ error: "Region not found" });
      if (!region.hasChecklist) return reply.code(400).send(noChecklistError(region.name));
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO species_lists (user_id, name, inat_taxon_id, taxon_name, taxon_rank, inat_place_id, place_name, region_id, native_only)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, inat_taxon_id, inat_place_id, region_id) DO NOTHING
         RETURNING id`,
        [
          userId,
          b.name?.trim() || `${b.taxonName.trim()} of ${b.placeName.trim()}`,
          b.taxonId,
          b.taxonName.trim(),
          b.taxonRank ?? null,
          b.placeId,
          b.placeName.trim(),
          regionId,
          b.nativeOnly ?? false,
        ],
      );
      const created = inserted.rows.length > 0;
      const id =
        inserted.rows[0]?.id ??
        (
          await pool.query<{ id: string }>(
            `SELECT id FROM species_lists WHERE user_id = $1 AND inat_taxon_id = $2 AND inat_place_id = $3 AND region_id = $4`,
            [userId, b.taxonId, b.placeId, regionId],
          )
        ).rows[0].id;
      if (b.targets) {
        const t = b.targets;
        const ok = await withTransaction(async (db) => {
          const list = await db.query<{ name: string }>(`SELECT name FROM species_lists WHERE id = $1 FOR UPDATE`, [
            id,
          ]);
          let targetListId = t.listId;
          if (targetListId) {
            const owned = await db.query(`SELECT 1 FROM target_lists WHERE id = $1 AND user_id = $2`, [
              targetListId,
              userId,
            ]);
            if (!owned.rowCount) return false;
          } else
            targetListId = (
              await db.query<{ id: string }>(
                `INSERT INTO target_lists (user_id, name, region_id) VALUES ($1, $2, $3) RETURNING id`,
                [userId, t.name?.trim() || list.rows[0].name, regionId],
              )
            ).rows[0].id;
          await db.query(`UPDATE species_lists SET target_list_id = $2, target_photographed = $3 WHERE id = $1`, [
            id,
            targetListId,
            t.photographed ?? false,
          ]);
          // An existing list's species so far; the worker targets each later page.
          const members = await db.query<{ species_id: string }>(
            `SELECT species_id FROM species_list_members WHERE list_id = $1`,
            [id],
          );
          await targetSpecies(
            db,
            userId,
            targetListId,
            members.rows.map((r) => r.species_id),
            t.photographed ?? false,
          );
          return true;
        });
        if (!ok) return reply.code(404).send({ error: "Target list not found" });
      }
      if (created) kickSpeciesLists();
      return { list: toApi((await listForUser(id, userId))!), created };
    },
  );

  // Rename, the native-only switch (used from the next refresh), hide.
  app.patch(
    "/species-lists/:id",
    {
      ...byId,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            name: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
            nativeOnly: Type.Optional(Type.Boolean()),
            hidden: Type.Optional(Type.Boolean()),
          },
          { additionalProperties: false },
        ),
        response: replies(OneList),
      },
    },
    async (request, reply) => {
      const { name, nativeOnly, hidden } = request.body;
      if (name !== undefined && !name.trim()) return reply.code(400).send({ error: "A list needs a name" });
      const res = await pool.query(
        `UPDATE species_lists SET name = COALESCE($3, name), native_only = COALESCE($4, native_only),
                hidden = COALESCE($5, hidden)
          WHERE id = $1 AND user_id = $2`,
        [request.params.id, request.user!.id, name?.trim() ?? null, nativeOnly ?? null, hidden ?? null],
      );
      if (!res.rowCount) return notFound(reply);
      return { list: toApi((await listForUser(request.params.id, request.user!.id))!) };
    },
  );

  // pause: stops after the page in hand. resume: carries on now, also skipping a batch's wait
  // ("Continue") or retrying after a failure. refresh: reads the whole list again.
  const actions = {
    pause: { from: ["queued", "running", "offline"], set: "status = 'paused'" },
    resume: {
      from: ["paused", "offline", "failed", "queued"],
      set: "status = 'queued', next_batch_at = NULL, last_error = NULL",
    },
    refresh: {
      from: ["done", "failed", "paused", "offline", "queued"],
      set: "status = 'queued', next_page = 1, next_batch_at = NULL, last_error = NULL",
    },
  } as const;
  for (const [action, { from, set }] of Object.entries(actions))
    app.post(
      `/species-lists/:id/${action}`,
      { ...byId, schema: { params: IdParams, response: replies(OneList) } },
      async (request, reply) => {
        const { id } = request.params;
        const userId = request.user!.id;
        const current = await listForUser(id, userId);
        if (!current) return notFound(reply);
        if (!(from as readonly string[]).includes(current.status))
          return reply.code(409).send({ error: `This list is ${current.status}`, code: "wrong_state" });
        await pool.query(`UPDATE species_lists SET ${set} WHERE id = $1 AND user_id = $2`, [id, userId]);
        if (action === "pause") await stopListIfRunning(id);
        kickSpeciesLists();
        return { list: toApi((await listForUser(id, userId))!) };
      },
    );

  // Undo of "Also add these species to my targets": its species come off the target list (and stop
  // being targets unless something else holds them), later pages add none, and a target list left
  // empty goes.
  app.post(
    "/species-lists/:id/untarget",
    { ...byId, schema: { params: IdParams, response: replies(OneList) } },
    async (request, reply) => {
      const { id } = request.params;
      const userId = request.user!.id;
      const found = await withTransaction(async (db) => {
        const list = await db.query<{ target_list_id: string | null }>(
          `SELECT target_list_id FROM species_lists WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [id, userId],
        );
        if (!list.rows[0]) return false;
        const targetListId = list.rows[0].target_list_id;
        if (!targetListId) return true;
        const members = await db.query<{ species_id: string }>(
          `SELECT species_id FROM species_list_members WHERE list_id = $1`,
          [id],
        );
        await removeFromList(
          db,
          userId,
          targetListId,
          members.rows.map((r) => r.species_id),
        );
        await db.query(`UPDATE species_lists SET target_list_id = NULL WHERE id = $1`, [id]);
        await db.query(
          `DELETE FROM target_lists l WHERE l.id = $1
             AND NOT EXISTS (SELECT 1 FROM target_list_species t WHERE t.list_id = l.id)`,
          [targetListId],
        );
        return true;
      });
      if (!found) return notFound(reply);
      return { list: toApi((await listForUser(id, userId))!) };
    },
  );

  // Removes the list. Species you photographed or marked stay on the checklist as your own
  // additions; species only this list added go, with their rows once nothing else uses them.
  app.delete(
    "/species-lists/:id",
    {
      ...byId,
      schema: {
        params: IdParams,
        response: replies(
          Type.Object({
            removedSpecies: Type.Integer({ description: "Species rows deleted with the list" }),
            kept: Type.Integer({ description: "Photographed or marked species kept on the checklist" }),
          }),
        ),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await listForUser(id, request.user!.id))) return notFound(reply);
      await stopListIfRunning(id);
      const result = await deleteList(id, request.user!.id);
      kickSpeciesLists();
      return result ?? notFound(reply);
    },
  );

  // Thin proxies of iNaturalist's autocomplete, cached a week, never retried on a refusal.
  app.get(
    "/species-lists/search/taxa",
    { preValidation: requireAuth, schema: { querystring: SearchQuery, response: replies(TaxonResults) } },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      try {
        return { results: await searchTaxa(request.query.q.trim()) };
      } catch (err) {
        return unavailable(reply, err);
      }
    },
  );

  // Lifer's own regions first (offline, and they know aliases like "BC"); iNaturalist's places only
  // when no region name or alias matches exactly.
  app.get(
    "/species-lists/search/places",
    { preValidation: requireAuth, schema: { querystring: SearchQuery, response: replies(PlaceResults) } },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      const q = request.query.q.trim();
      const own = await pool.query<{ id: string; name: string; inat_place_id: number; exact: boolean }>(
        `SELECT r.id, r.name, r.inat_place_id,
                (lower(r.name) = lower($1) OR lower($1) = ANY (SELECT lower(a) FROM unnest(r.aliases) a)) AS exact
           FROM regions r
          WHERE r.inat_place_id IS NOT NULL
            AND (left(lower(r.name), length($1)) = lower($1) OR lower($1) = ANY (SELECT lower(a) FROM unnest(r.aliases) a))
          ORDER BY 4 DESC, r.name LIMIT 5`,
        [q],
      );
      const results: Static<typeof PlaceResults>["results"] = own.rows.map((r) => ({
        placeId: r.inat_place_id,
        name: r.name,
        displayName: r.name,
        adminLevel: null,
        regionId: r.id,
      }));
      if (own.rows.some((r) => r.exact)) return { results, inatUnavailable: null };
      try {
        const hits = await searchPlaces(q);
        const regions = await pool.query<{ id: string; inat_place_id: number }>(
          `SELECT id, inat_place_id FROM regions WHERE inat_place_id = ANY($1::int[])`,
          [hits.map((h) => h.placeId)],
        );
        const regionOf = new Map(regions.rows.map((r) => [r.inat_place_id, r.id]));
        const seen = new Set(results.map((r) => r.placeId));
        for (const h of hits)
          if (!seen.has(h.placeId)) results.push({ ...h, regionId: regionOf.get(h.placeId) ?? null });
        return { results, inatUnavailable: null };
      } catch (err) {
        if (!(err instanceof InatUnavailableError)) throw err;
        return { results, inatUnavailable: err.code };
      }
    },
  );
}
