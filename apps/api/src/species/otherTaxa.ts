// Other Taxa: species Lifer has no dataset for (insects, plants, fungi, ...), found and added
// from iNaturalist by name. Behind the any_taxa_search_enabled opt-in, since it's a live lookup.
// The species row is shared, but putting it on a region's checklist is a checklist addition for
// the importing user only (regions/checklistAdditions.ts), never a catalog region_species row.
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { isUuid } from "../lib/validate.js";
import { IdParams, Nullable, Ok, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth } from "../auth/session.js";
import { createJob, describeError } from "../lib/job.js";
import { addToRegionChecklist, findChecklistRegion, noChecklistError } from "../regions/checklistAdditions.js";
import { scheduleCollectionStateSave } from "../lib/collectionState.js";
import { httpFetch } from "@lifer/core/lib/http.js";
import { statFile } from "../lib/cachedFile.js";
import { deleteUnreferencedFiles } from "../offlinePacks/remove.js";
import { syncInatDistribution } from "./inatDistribution.js";
import { INAT_TAXA_API, LOOKUP, resolveOrCreateOtherTaxaSpecies, titleCaseCommonName } from "./otherTaxaSpecies.js";

export async function requireAnyTaxaSearchEnabled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
  const res = await pool.query<{ any_taxa_search_enabled: boolean }>(
    `SELECT any_taxa_search_enabled FROM users WHERE id = $1`,
    [request.user!.id],
  );
  if (!res.rows[0]?.any_taxa_search_enabled) {
    reply
      .code(403)
      .send({ error: "Searching iNaturalist for other species isn't turned on (Settings > Species & Import)" });
    return false;
  }
  return true;
}

/** The species row for an iNat taxon, created and enriched on first use. Doesn't put it on any
 *  checklist; each caller decides that. */
/** Your iNaturalist-added species per region you added them to, with their photo files. */
async function addedOtherTaxa(userId: string) {
  const res = await pool.query<{
    species_id: string;
    region_id: string;
    region_name: string;
    iconic: string | null;
    photographed: boolean;
    paths: string[];
  }>(
    `SELECT a.species_id, a.region_id, r.name AS region_name, s.inat_iconic_taxon AS iconic,
            EXISTS (SELECT 1 FROM captures_all c WHERE c.user_id = $1 AND (c.species_id = s.id
                    OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = s.id)))
              AS photographed,
            array_remove(ARRAY[s.reference_display_path, s.reference_thumb_path]
              || coalesce((SELECT array_agg(p) FROM species_reference_photos srp,
                           unnest(ARRAY[srp.display_path, srp.thumb_path]) AS p WHERE srp.species_id = s.id), '{}'), NULL)
              AS paths
       FROM region_species_user_added a
       JOIN species s ON s.id = a.species_id AND s.is_other_taxa
       JOIN regions r ON r.id = a.region_id
      WHERE a.user_id = $1
      ORDER BY r.name, s.inat_iconic_taxon`,
    [userId],
  );
  // The country each place is in: the place under a continent (World > continent > country).
  const regionsRes = await pool.query<{ id: string; name: string; parent_id: string | null }>(
    `SELECT id, name, parent_id FROM regions`,
  );
  const byId = new Map(regionsRes.rows.map((r) => [r.id, r]));
  const countryOf = (id: string): string => {
    let node = byId.get(id);
    while (node) {
      const parent = node.parent_id ? byId.get(node.parent_id) : undefined;
      if (!parent || !parent.parent_id || !byId.get(parent.parent_id)?.parent_id) return node.name;
      node = parent;
    }
    return "";
  };
  return res.rows.map((r) => ({ ...r, country: countryOf(r.region_id) || r.region_name }));
}

/** Takes Other Taxa species off one user's lists, and drops each species row (and its photo
 *  files) once nobody else uses it. The caller has checked the user has no photos of them.
 *  Returns how many species rows went. */
async function removeOtherTaxaForUser(
  userId: string,
  speciesIds: string[],
  log: { warn: (obj: object, msg: string) => void },
  /** Only these places' additions; the species stays on your other lists. */
  regionIds?: string[],
): Promise<number> {
  const filesToDelete: string[] = [];
  let deleted = 0;
  for (const speciesId of speciesIds) {
    const gone = await withTransaction(async (client) => {
      if (regionIds) {
        await client.query(
          `DELETE FROM region_species_user_added WHERE user_id = $1 AND species_id = $2 AND region_id = ANY($3)`,
          [userId, speciesId, regionIds],
        );
        const stillMine = await client.query(
          `SELECT 1 FROM region_species_user_added WHERE user_id = $1 AND species_id = $2
           UNION ALL SELECT 1 FROM sea_zone_species_user_added WHERE user_id = $1 AND species_id = $2 LIMIT 1`,
          [userId, speciesId],
        );
        // Still on another of your lists: your seen and target marks stay with it.
        if ((stillMine.rowCount ?? 0) > 0) return null;
      }
      for (const table of [
        "user_species",
        "user_archived_species",
        "region_species_user_added",
        "sea_zone_species_user_added",
        "region_species_hidden",
        "user_tier_overrides",
      ]) {
        await client.query(`DELETE FROM ${table} WHERE user_id = $1 AND species_id = $2`, [userId, speciesId]);
      }
      // Another user's additions would cascade away with the species row, so it stays while any
      // remain. Their photos and seen marks keep it too, through the foreign keys, caught below.
      const othersRes = await client.query(
        `SELECT 1 FROM region_species_user_added WHERE species_id = $1
         UNION ALL SELECT 1 FROM sea_zone_species_user_added WHERE species_id = $1
         LIMIT 1`,
        [speciesId],
      );
      if ((othersRes.rowCount ?? 0) > 0) return null;
      const files = await client.query<{ p: string }>(
        `SELECT p FROM species s, unnest(ARRAY[s.reference_display_path, s.reference_thumb_path]) AS p
          WHERE s.id = $1 AND p IS NOT NULL
         UNION ALL
         SELECT p FROM species_reference_photos srp, unnest(ARRAY[srp.display_path, srp.thumb_path]) AS p
          WHERE srp.species_id = $1 AND p IS NOT NULL`,
        [speciesId],
      );
      await client.query("SAVEPOINT drop_species");
      try {
        await client.query(`DELETE FROM species WHERE id = $1`, [speciesId]);
        return files.rows.map((r) => r.p);
      } catch (err) {
        await client.query("ROLLBACK TO SAVEPOINT drop_species");
        log.warn(
          { err, speciesId },
          "Other Taxa species still referenced elsewhere: removed from your lists, species row kept",
        );
        return null;
      }
    });
    if (gone) {
      deleted++;
      filesToDelete.push(...gone);
    }
  }
  // After the commits, and only files no row points at any more.
  await deleteUnreferencedFiles(filesToDelete);
  return deleted;
}

// Live counters are top-level; `result` repeats them once the run finishes.
interface OtherTaxaBulkExtra {
  added: number;
  alreadyPresent: number;
  notFound: string[];
}

// regionId stays a plain string in these bodies: a malformed one answers 404 "Region not found"
// like an unknown one (checked in the handler), not a 400. World and the continents have no
// checklist of their own, so they're refused like a checklist addition there (400 no_checklist).
const AddOtherTaxaBody = Type.Object(
  { inatTaxonId: Type.Integer({ minimum: 1 }), regionId: Type.String() },
  { additionalProperties: false },
);
const BulkBody = Type.Object(
  { regionId: Type.String(), entries: Type.Array(Type.String(), { minItems: 1 }) },
  { additionalProperties: false },
);

export async function otherTaxaRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  const inatSearchOptions = {
    preValidation: requireAuth,
    schema: { querystring: Type.Object({ q: Type.Optional(Type.String()) }) },
  };
  app.get("/species/inat-search", inatSearchOptions, async (request, reply) => {
    if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
    const q = (request.query.q ?? "").trim();
    if (q.length < 2) return { results: [] };
    const res = await httpFetch(
      `${INAT_TAXA_API}?q=${encodeURIComponent(q)}&rank=species&is_active=true&per_page=15`,
      LOOKUP,
    ).catch(() => null);
    if (!res) return reply.code(502).send({ error: "iNaturalist search failed" });
    if (!res.ok) return reply.code(502).send({ error: "iNaturalist search failed" });
    const data = (await res.json()) as {
      results: Array<{
        id: number;
        name: string;
        preferred_common_name?: string;
        iconic_taxon_name?: string;
        default_photo?: { square_url?: string } | null;
      }>;
    };
    return {
      results: data.results.map((t) => ({
        inatTaxonId: t.id,
        scientificName: t.name,
        commonName: t.preferred_common_name ? titleCaseCommonName(t.preferred_common_name) : null,
        iconicTaxon: t.iconic_taxon_name ?? null,
        thumbnailUrl: t.default_photo?.square_url ?? null,
      })),
    };
  });

  app.post(
    "/species/other-taxa",
    { preValidation: requireAuth, schema: { body: AddOtherTaxaBody } },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      const { inatTaxonId, regionId } = request.body;

      const region = isUuid(regionId) ? await findChecklistRegion(regionId) : null;
      if (!region) return reply.code(404).send({ error: "Region not found" });
      if (!region.hasChecklist) return reply.code(400).send(noChecklistError(region.name));

      let speciesId: string;
      try {
        ({ speciesId } = await resolveOrCreateOtherTaxaSpecies(inatTaxonId, { enrichLater: true }));
      } catch (err) {
        request.log.warn({ err }, "Couldn't add the taxon");
        return reply.code(502).send({ error: describeError(err) });
      }

      await addToRegionChecklist(pool, request.user!.id, regionId, speciesId);
      // Its chart and tags for the country, fetched now so the species page works offline.
      void syncInatDistribution(speciesId, regionId);
      return { speciesId };
    },
  );

  // Species you added from iNaturalist, by place and iNaturalist group, with the space their
  // photos take: Downloaded regions offers to remove them like a downloaded region.
  app.get(
    "/species/other-taxa/added",
    {
      preValidation: requireAuth,
      schema: {
        response: replies(
          Type.Object({
            groups: Type.Array(
              Type.Object({
                country: Type.String({ description: "The country it was added in, or the place itself" }),
                iconicTaxon: Nullable(Type.String({ description: "iNaturalist group, e.g. Insecta" })),
                speciesCount: Type.Integer(),
                photographedCount: Type.Integer({ description: "Kept on removal: you have photos of them" }),
                bytes: Type.Integer({ description: "Space their reference photos take" }),
              }),
            ),
          }),
        ),
      },
    },
    async (request) => {
      const rows = await addedOtherTaxa(request.user!.id);
      const groups = new Map<string, (typeof rows)[number][]>();
      for (const r of rows) {
        const key = `${r.country}|${r.iconic ?? ""}`;
        groups.set(key, [...(groups.get(key) ?? []), r]);
      }
      return {
        groups: await Promise.all(
          [...groups.values()].map(async (list) => ({
            country: list[0].country,
            iconicTaxon: list[0].iconic,
            speciesCount: list.length,
            photographedCount: list.filter((r) => r.photographed).length,
            bytes: (
              await Promise.all(list.flatMap((r) => r.paths).map((p) => statFile(p).then((st) => st?.size ?? 0)))
            ).reduce((a, b) => a + b, 0),
          })),
        ),
      };
    },
  );

  app.post(
    "/species/other-taxa/added/remove",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          { country: Type.String({ minLength: 1 }), iconicTaxon: Nullable(Type.String()) },
          { additionalProperties: false },
        ),
        response: replies(Type.Object({ removed: Type.Integer(), kept: Type.Integer() })),
      },
    },
    async (request) => {
      const userId = request.user!.id;
      const { country, iconicTaxon } = request.body;
      const group = (await addedOtherTaxa(userId)).filter(
        (r) => r.country === country && (r.iconic ?? null) === iconicTaxon,
      );
      // Your photos keep their species.
      const removable = group.filter((r) => !r.photographed);
      const speciesIds = [...new Set(removable.map((r) => r.species_id))];
      const regionIds = [...new Set(removable.map((r) => r.region_id))];
      if (speciesIds.length > 0) await removeOtherTaxaForUser(userId, speciesIds, request.log, regionIds);
      return { removed: speciesIds.length, kept: new Set(group.map((r) => r.species_id)).size - speciesIds.length };
    },
  );

  // Takes an Other Taxa species off your lists: your checklist additions of it (every region and
  // sea zone), your seen, target and archive marks. Refused while you have photos of it (they'd be
  // orphaned). Other people's additions of it are left alone, and the species row itself goes only
  // once nobody uses it any more, so on a shared server it's gone for you, not for everyone.
  const removeOptions = {
    preValidation: requireAuth,
    config: notFoundOnInvalidId("Species not found"),
    schema: { params: IdParams, response: replies(Ok) },
  };
  app.delete("/species/:id/other-taxa", removeOptions, async (request, reply) => {
    const { id: speciesId } = request.params;
    const userId = request.user!.id;

    const speciesRes = await pool.query<{ is_other_taxa: boolean }>(`SELECT is_other_taxa FROM species WHERE id = $1`, [
      speciesId,
    ]);
    if (speciesRes.rows.length === 0) return reply.code(404).send({ error: "Species not found" });
    if (!speciesRes.rows[0].is_other_taxa) {
      return reply.code(400).send({ error: "Only a species from Other species can be removed this way" });
    }

    const captureCountRes = await pool.query<{ count: string }>(
      `SELECT count(*) FROM captures_all c
       WHERE c.user_id = $1 AND (c.species_id = $2 OR EXISTS (SELECT 1 FROM capture_species cs WHERE cs.capture_id = c.id AND cs.species_id = $2))`,
      [userId, speciesId],
    );
    if (Number(captureCountRes.rows[0].count) > 0) {
      return reply
        .code(409)
        .send({ error: "You have photos of this species. Delete or reassign them first, then remove it." });
    }

    const speciesDeleted = (await removeOtherTaxaForUser(userId, [speciesId], request.log)) > 0;
    request.log.info({ speciesId, speciesDeleted }, "Removed an Other Taxa species");
    return { ok: true };
  });

  // Bulk import of a pasted list (scientific names, common names or iNat taxon ids, one per
  // line) into a region's Other Taxa, as a background job.
  const otherTaxaBulkJob = createJob<OtherTaxaBulkExtra, OtherTaxaBulkExtra>("other-taxa-bulk", {
    added: 0,
    alreadyPresent: 0,
    notFound: [],
  });

  app.get(
    "/species/other-taxa/bulk/status",
    { preValidation: requireAuth, schema: {} },
    async () => otherTaxaBulkJob.status,
  );

  app.post("/species/other-taxa/bulk/cancel", { preValidation: requireAuth, schema: {} }, async () => ({
    cancelled: otherTaxaBulkJob.cancel(),
  }));

  app.post(
    "/species/other-taxa/bulk",
    { preValidation: requireAuth, schema: { body: BulkBody } },
    async (request, reply) => {
      if (!(await requireAnyTaxaSearchEnabled(request, reply))) return;
      if (otherTaxaBulkJob.status.running) return reply.code(409).send({ error: "A bulk import is already running" });
      const { regionId, entries } = request.body;
      const userId = request.user!.id;
      const region = isUuid(regionId) ? await findChecklistRegion(regionId) : null;
      if (!region) return reply.code(404).send({ error: "Region not found" });
      if (!region.hasChecklist) return reply.code(400).send(noChecklistError(region.name));

      // Deduped and blanks dropped before the total is reported.
      const lines = [...new Set(entries.map((e) => e.trim()).filter((e) => e.length > 0))];
      if (lines.length === 0) return reply.code(400).send({ error: "No usable entries found" });

      // Background job; the frontend polls /species/other-taxa/bulk/status.
      const started = otherTaxaBulkJob.start(
        async (ctx) => {
          const job = otherTaxaBulkJob.status;
          let processed = 0;
          for (const line of lines) {
            ctx.throwIfCancelled();
            ctx.update({ currentItem: line });
            try {
              let taxonId: number | null = null;
              if (/^\d+$/.test(line)) {
                taxonId = Number(line);
              } else {
                const searchRes = await httpFetch(
                  `${INAT_TAXA_API}?q=${encodeURIComponent(line)}&rank=species&is_active=true&per_page=1`,
                  { ...LOOKUP, signal: ctx.signal },
                );
                if (searchRes.ok) {
                  const searchData = (await searchRes.json()) as { results: Array<{ id: number }> };
                  taxonId = searchData.results[0]?.id ?? null;
                }
              }
              if (taxonId == null) {
                job.notFound.push(line);
              } else {
                const { speciesId } = await resolveOrCreateOtherTaxaSpecies(taxonId);
                if (await addToRegionChecklist(pool, userId, regionId, speciesId)) job.added++;
                else job.alreadyPresent++;
                void syncInatDistribution(speciesId, regionId);
              }
            } catch {
              ctx.throwIfCancelled();
              job.notFound.push(line);
            }
            // Each line makes several iNaturalist calls, all paced by the shared HTTP client.
            ctx.update({ processed: ++processed });
          }
          // The library's record is saved after each change by the route that made it
          // (lib/collectionState.ts), but this job's additions land after its response went out.
          scheduleCollectionStateSave(userId);
          return { added: job.added, alreadyPresent: job.alreadyPresent, notFound: [...job.notFound] };
        },
        { phase: "importing", processed: 0, total: lines.length },
      );
      if (!started) return reply.code(409).send({ error: "A bulk import is already running" });

      return { started: true, total: lines.length };
    },
  );
}
