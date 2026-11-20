// Removing packs: the impact preview, deleting whole packs, and offloading single provinces.
import { rmSync } from "node:fs";
import { stat } from "node:fs/promises";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { descendantIdsSql } from "@lifer/core/regions/regionTree.js";
import type { FastifyInstance } from "fastify";
import { Type, type Static } from "typebox";
import { subdivisionLabelFor } from "@lifer/shared";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { invalidateSuggestionCache } from "@lifer/core/species/embeddings.js";
import { log } from "@lifer/core/lib/log.js";
import { Uuid, replies, withSchemas } from "../lib/schema.js";
import { createJob, type JobContext } from "../lib/job.js";
import { DeleteImpact, PackDeleted, PackProvinces, RemovalStarted, RemovalStatus } from "./responses.js";
import { invalidatePackSizes } from "./index.js";
import { isPackDownloadRunning, PackId } from "./download.js";

interface DeleteImpact {
  regionIds: string[];
  seaZoneId: string | null;
  checklistRegionsAffected: string[];
  speciesToRemove: string[];
  speciesKeptCount: number;
  bytesToFree: number;
  // bytesToFree is the archive's size rather than a per-species tally, so the UI says "about".
  isEstimate: boolean;
}

// Every reference photo file (main and gallery) of the species in $1.
const SPECIES_FILES_SQL = `
  SELECT p FROM species s, unnest(ARRAY[s.reference_display_path, s.reference_thumb_path]) AS p
  WHERE s.id = ANY($1) AND p IS NOT NULL
  UNION ALL
  SELECT p FROM species_reference_photos g, unnest(ARRAY[g.display_path, g.thumb_path]) AS p
  WHERE g.species_id = ANY($1) AND p IS NOT NULL`;

// Shared by the preview and the real delete. A country pack owns its provinces' checklist rows.
// A pack with no pack_species rows only loses its downloaded_packs row.
async function computeDeleteImpact(packId: string): Promise<DeleteImpact | null> {
  const packRes = await pool.query<{
    region: string | null;
    bytes: number;
    applied_province_region_ids: string[] | null;
  }>(`SELECT region, bytes, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`, [packId]);
  const packRegionName = packRes.rows[0]?.region;
  if (packRes.rows.length === 0) return null;
  const packBytes = Number(packRes.rows[0].bytes ?? 0);
  const appliedProvinceIds = packRes.rows[0].applied_province_region_ids;

  const regionIds: string[] = [];
  let seaZoneId: string | null = null;
  const checklistRegionsAffected: string[] = [];
  if (packRegionName) {
    const regionRes = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM regions WHERE name = $1`, [
      packRegionName,
    ]);
    if (regionRes.rows.length > 0) {
      const { id, name } = regionRes.rows[0];
      regionIds.push(id);
      checklistRegionsAffected.push(name);
      // Its groups and provinces; a group's provinces go with the group. A province shown under
      // its continent (Galapagos) ships in its own pack, so it stays.
      const childrenRes = await pool.query<{ id: string; name: string; unit_id: string }>(
        `SELECT r.id, r.name, CASE WHEN r.parent_id = $1 THEN r.id ELSE r.parent_id END AS unit_id
         FROM regions r WHERE r.id IN (${descendantIdsSql("$1")}) AND r.home_country_id IS NULL`,
        [id],
      );
      for (const child of childrenRes.rows) {
        // Skip provinces already offloaded individually, so they aren't counted twice.
        if (appliedProvinceIds && !appliedProvinceIds.includes(child.unit_id)) continue;
        regionIds.push(child.id);
        checklistRegionsAffected.push(child.name);
      }
    } else {
      const zoneRes = await pool.query<{ id: string }>(`SELECT id FROM sea_zones WHERE name = $1`, [packRegionName]);
      if (zoneRes.rows.length > 0) {
        seaZoneId = zoneRes.rows[0].id;
        checklistRegionsAffected.push(packRegionName);
      }
    }
  }

  // Removed unless another pack or the user's collection still needs it.
  const speciesRes = await pool.query<{ species_id: string; kept: boolean }>(
    `SELECT ps.species_id,
            EXISTS (SELECT 1 FROM pack_species o WHERE o.species_id = ps.species_id AND o.pack_id != $1)
            OR EXISTS (SELECT 1 FROM user_species u WHERE u.species_id = ps.species_id) AS kept
     FROM pack_species ps WHERE ps.pack_id = $1`,
    [packId],
  );
  const speciesToRemove = speciesRes.rows.filter((r) => !r.kept).map((r) => r.species_id);
  const speciesKeptCount = speciesRes.rows.length - speciesToRemove.length;
  // Gallery photos go too: packs install them from the photo store along with the main one.
  const files =
    speciesToRemove.length > 0 ? (await pool.query<{ p: string }>(SPECIES_FILES_SQL, [speciesToRemove])).rows : [];
  const sizes = await mapWithConcurrency(files, 16, ({ p }) =>
    stat(p).then(
      (st) => st.size,
      () => 0,
    ),
  );
  const bytesToFree = sizes.reduce((sum, n) => sum + n, 0);

  // No pack_species rows: report the archive's size rather than a misleading 0.
  if (speciesRes.rows.length === 0 && packBytes > 0) {
    return {
      regionIds,
      seaZoneId,
      checklistRegionsAffected,
      speciesToRemove,
      speciesKeptCount,
      bytesToFree: packBytes,
      isEstimate: true,
    };
  }

  return {
    regionIds,
    seaZoneId,
    checklistRegionsAffected,
    speciesToRemove,
    speciesKeptCount,
    bytesToFree,
    isEstimate: false,
  };
}

async function deletePack(
  packId: string,
): Promise<{ deletedSpeciesFiles: number; keptSpeciesCount: number; regions: string[] }> {
  const impact = await computeDeleteImpact(packId);
  if (!impact) throw Object.assign(new Error(`No downloaded region found with id "${packId}"`), { statusCode: 404 });

  // Files are only collected inside the transaction and deleted after it commits: deleting them
  // first would leave a rolled-back removal's rows pointing at files that are gone.
  const filesToDelete = new Set<string>();
  await withTransaction(
    async (client) => {
      if (impact.regionIds.length > 0) {
        const speciesRes = await client.query<{ species_id: string }>(
          `SELECT species_id FROM pack_species WHERE pack_id = $1`,
          [packId],
        );
        const allSpeciesIds = speciesRes.rows.map((r) => r.species_id);
        if (allSpeciesIds.length > 0) {
          await client.query(`DELETE FROM region_species WHERE region_id = ANY($1) AND species_id = ANY($2)`, [
            impact.regionIds,
            allSpeciesIds,
          ]);
        }
      } else if (impact.seaZoneId) {
        const speciesRes = await client.query<{ species_id: string }>(
          `SELECT species_id FROM pack_species WHERE pack_id = $1`,
          [packId],
        );
        const allSpeciesIds = speciesRes.rows.map((r) => r.species_id);
        if (allSpeciesIds.length > 0) {
          await client.query(`DELETE FROM sea_zone_species WHERE sea_zone_id = $1 AND species_id = ANY($2)`, [
            impact.seaZoneId,
            allSpeciesIds,
          ]);
        }
      }

      const removed = impact.speciesToRemove;
      if (removed.length > 0) {
        const fileRes = await client.query<{ p: string }>(SPECIES_FILES_SQL, [removed]);
        for (const { p } of fileRes.rows) filesToDelete.add(p);
        // The gallery's rows stay (they come from the catalog), without paths.
        await client.query(
          `UPDATE species_reference_photos SET display_path = NULL, thumb_path = NULL WHERE species_id = ANY($1)`,
          [removed],
        );
        // reference_photo goes with credit/license (reference_photo_requires_credit). A photo
        // withheld from packs is fetched again as soon as a pack lists the species again
        // (species/withheldPhotos.ts), not RETRY_AFTER_DAYS after this fetch.
        await client.query(
          `UPDATE species SET
           reference_display_path = NULL, reference_thumb_path = NULL, habitat_description = NULL,
           reference_credit = NULL, reference_license = NULL, reference_photo = NULL, enriched_at = NULL,
           photo_checked_at = NULL
         WHERE id = ANY($1)`,
          [removed],
        );
      }

      // pack_species cascades from this delete (ON DELETE CASCADE, migration 054).
      await client.query(`DELETE FROM downloaded_packs WHERE pack_id = $1`, [packId]);
    },
    { lockReferenceData: true },
  );
  invalidateSuggestionCache();
  invalidatePackSizes();
  await deleteUnreferencedFiles([...filesToDelete]);

  return {
    deletedSpeciesFiles: impact.speciesToRemove.length,
    keptSpeciesCount: impact.speciesKeptCount,
    regions: impact.checklistRegionsAffected,
  };
}

/** Deletes the reference photo files a committed removal let go of, best effort. A file some row
 *  points at again (another species sharing it, or a pack installed since the commit) is kept. A
 *  delete that fails only leaves an unreferenced file behind, which is logged. */
export async function deleteUnreferencedFiles(paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  let stillUsed: Set<string>;
  try {
    const res = await pool.query<{ p: string }>(
      `SELECT p FROM unnest($1::text[]) AS p
       WHERE EXISTS (SELECT 1 FROM species WHERE reference_display_path = p OR reference_thumb_path = p)
          OR EXISTS (SELECT 1 FROM species_reference_photos WHERE display_path = p OR thumb_path = p)`,
      [paths],
    );
    stillUsed = new Set(res.rows.map((r) => r.p));
  } catch (err) {
    // Can't tell what's still used: keeping every file is the safe side.
    log.warn({ err }, "[packs] couldn't check which removed reference photos are still used; leaving them on disk");
    return;
  }
  for (const p of paths) {
    if (stillUsed.has(p)) continue;
    try {
      rmSync(p, { force: true });
    } catch (err) {
      log.warn({ err, path: p }, "[packs] couldn't delete a removed pack's reference photo");
    }
  }
}

const PackParams = Type.Object({ packId: PackId });
const PackIdsBody = Type.Object({ packIds: Type.Array(PackId, { minItems: 1 }) }, { additionalProperties: false });

export async function packRemoveRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // Dry run of DELETE, so the UI can say what will be removed and kept before confirming.
  app.get(
    "/offline-packs/:packId/delete-preview",
    { preValidation: requireAuth, schema: { params: PackParams, response: replies(DeleteImpact) } },
    async (request, reply) => {
      const impact = await computeDeleteImpact(request.params.packId);
      if (!impact) return reply.code(404).send({ error: "No downloaded region found with that id" });
      return {
        checklistRegionsAffectedCount: impact.checklistRegionsAffected.length,
        speciesToRemoveCount: impact.speciesToRemove.length,
        speciesKeptCount: impact.speciesKeptCount,
        bytesToFree: impact.bytesToFree,
        isEstimate: impact.isEstimate,
      };
    },
  );

  app.delete(
    "/offline-packs/:packId",
    { preValidation: requireAuth, schema: { params: PackParams, response: replies(PackDeleted) } },
    async (request, reply) => {
      if (isPackDownloadRunning())
        return reply.code(409).send({ error: "Wait for the region download to finish, then try again" });

      try {
        return await deletePack(request.params.packId);
      } catch (err) {
        // Only a missing pack is a 404; anything else is a real failure.
        if ((err as { statusCode?: number }).statusCode !== 404) throw err;
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  // Which provinces of a country pack stay applied (a regional group stands for its provinces).
  // The whole archive is always downloaded; applied_province_region_ids NULL means every
  // province is applied.
  app.get(
    "/offline-packs/:packId/provinces",
    { preValidation: requireAuth, schema: { params: PackParams, response: replies(PackProvinces) } },
    async (request, reply) => {
      const packRes = await pool.query<{ region: string | null; applied_province_region_ids: string[] | null }>(
        `SELECT region, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
        [request.params.packId],
      );
      if (packRes.rows.length === 0) return reply.code(404).send({ error: "No downloaded region found with that id" });
      const { region, applied_province_region_ids: appliedIds } = packRes.rows[0];
      if (!region) return { provinces: [], subdivisionLabel: "Provinces" };
      const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [region]);
      const regionId = regionRes.rows[0]?.id;
      if (!regionId) return { provinces: [], subdivisionLabel: "Provinces" };
      const childrenRes = await pool.query<{ id: string; name: string; subdivision_type: string | null }>(
        `SELECT id, name, subdivision_type FROM regions WHERE parent_id = $1 ORDER BY name`,
        [regionId],
      );
      return {
        provinces: childrenRes.rows.map((c) => ({
          id: c.id,
          name: c.name,
          applied: !appliedIds || appliedIds.includes(c.id),
        })),
        subdivisionLabel: subdivisionLabelFor(childrenRes.rows.map((c) => c.subdivision_type)),
      };
    },
  );

  // Offloads these provinces' checklist rows for this pack's species (reference photos stay at
  // the country level). Re-downloading the pack brings every province back.
  app.post(
    "/offline-packs/:packId/provinces/offload",
    {
      preValidation: requireAuth,
      schema: {
        params: PackParams,
        body: Type.Object({ regionIds: Type.Array(Uuid(), { minItems: 1 }) }, { additionalProperties: false }),
        response: replies(Type.Object({ ok: Type.Boolean(), remainingApplied: Type.Integer() })),
      },
    },
    async (request, reply) => {
      if (isPackDownloadRunning()) {
        return reply.code(409).send({ error: "Wait for the region download to finish, then try again" });
      }

      const { packId } = request.params;
      const packRes = await pool.query<{ region: string | null; applied_province_region_ids: string[] | null }>(
        `SELECT region, applied_province_region_ids FROM downloaded_packs WHERE pack_id = $1`,
        [packId],
      );
      if (packRes.rows.length === 0) return reply.code(404).send({ error: "No downloaded region found with that id" });
      const { region, applied_province_region_ids: appliedIds } = packRes.rows[0];
      if (!region) return reply.code(400).send({ error: "This downloaded region has no provinces" });
      const regionRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE name = $1`, [region]);
      const regionId = regionRes.rows[0]?.id;
      if (!regionId) return reply.code(400).send({ error: "This download's region no longer exists" });

      const allChildrenRes = await pool.query<{ id: string }>(`SELECT id FROM regions WHERE parent_id = $1`, [
        regionId,
      ]);
      const allChildIds = allChildrenRes.rows.map((r) => r.id);
      // Only this pack's own provinces, so no other region's checklist can be cleared through it.
      const toOffload = request.body.regionIds.filter((id) => allChildIds.includes(id));
      if (toOffload.length === 0)
        return reply.code(400).send({ error: "None of those provinces belong to this region" });
      const currentlyApplied = appliedIds ?? allChildIds;

      const remaining = currentlyApplied.filter((id) => !toOffload.includes(id));
      await withTransaction(
        async (client) => {
          const speciesRes = await client.query<{ species_id: string }>(
            `SELECT species_id FROM pack_species WHERE pack_id = $1`,
            [packId],
          );
          const speciesIds = speciesRes.rows.map((r) => r.species_id);
          if (speciesIds.length > 0) {
            // A regional group's provinces go with it.
            await client.query(
              `DELETE FROM region_species
               WHERE (region_id = ANY($1::uuid[]) OR region_id IN (SELECT id FROM regions WHERE parent_id = ANY($1::uuid[])))
                 AND species_id = ANY($2::uuid[])`,
              [toOffload, speciesIds],
            );
          }
          await client.query(`UPDATE downloaded_packs SET applied_province_region_ids = $1 WHERE pack_id = $2`, [
            JSON.stringify(remaining),
            packId,
          ]);
        },
        { lockReferenceData: true },
      );

      return { ok: true, remainingApplied: remaining.length };
    },
  );

  // Summed dry run across several packs for the offload screen's multi-select.
  app.post(
    "/offline-packs/offload-preview",
    { preValidation: requireAuth, schema: { body: PackIdsBody, response: replies(DeleteImpact) } },
    async (request) => {
      const { packIds } = request.body;
      let checklistRegionsAffectedCount = 0;
      let speciesToRemoveCount = 0;
      let speciesKeptCount = 0;
      let bytesToFree = 0;
      let isEstimate = false;
      for (const packId of packIds) {
        const impact = await computeDeleteImpact(packId);
        if (!impact) continue;
        checklistRegionsAffectedCount += impact.checklistRegionsAffected.length;
        speciesToRemoveCount += impact.speciesToRemove.length;
        speciesKeptCount += impact.speciesKeptCount;
        bytesToFree += impact.bytesToFree;
        isEstimate = isEstimate || impact.isEstimate;
      }
      return { checklistRegionsAffectedCount, speciesToRemoveCount, speciesKeptCount, bytesToFree, isEstimate };
    },
  );

  // Starts (or joins) the removal job and answers at once; each pack is removed whole in its own
  // transaction, so a failure leaves that pack and every queued one intact. GET .../removal-status
  // lists the packs still pending so the UI can show "Removing...".
  app.post(
    "/offline-packs/offload-batch",
    { preValidation: requireAuth, schema: { body: PackIdsBody, response: replies(RemovalStarted) } },
    async (request, reply) => {
      if (isPackDownloadRunning())
        return reply.code(409).send({ error: "Wait for the region download to finish, then try again" });
      for (const id of request.body.packIds) if (!removalQueue.includes(id)) removalQueue.push(id);
      removalJob.status.packIds = [...removalQueue];
      removalJob.start(runRemoval, { packIds: [...removalQueue] });
      return { started: true, packIds: [...removalQueue] };
    },
  );

  app.get(
    "/offline-packs/removal-status",
    { preValidation: requireAuth, schema: { response: replies(RemovalStatus) } },
    async () => removalJob.status,
  );
}

type PackDeletedResult = Static<typeof PackDeleted>;
const removalQueue: string[] = [];
const removalJob = createJob<PackDeletedResult, { packIds: string[] }>("pack-removal", { packIds: [] });

async function runRemoval(ctx: JobContext<PackDeletedResult, { packIds: string[] }>): Promise<PackDeletedResult> {
  const total = { deletedSpeciesFiles: 0, keptSpeciesCount: 0, regions: [] as string[] };
  let done = 0;
  try {
    for (let id = removalQueue[0]; id; id = removalQueue[0]) {
      ctx.update({ phase: "removing", processed: done, total: done + removalQueue.length, packIds: [...removalQueue] });
      const result = await deletePack(id);
      removalQueue.shift();
      done++;
      total.deletedSpeciesFiles += result.deletedSpeciesFiles;
      total.keptSpeciesCount += result.keptSpeciesCount;
      total.regions.push(...result.regions);
    }
  } finally {
    // A failed pack and the ones behind it are untouched: drop them so the job can run again.
    removalQueue.length = 0;
    ctx.update({ packIds: [] });
  }
  return total;
}
