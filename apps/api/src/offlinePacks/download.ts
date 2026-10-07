// Downloads packs in a background job: each pack is fetched, applied in one transaction, and
// its sea-zone dependencies are queued once.
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireAuth } from "../auth/session.js";
import { withSchemas } from "../lib/schema.js";
// Cross-package import: pure id derivation with no heavy dependencies.
import { packIdFromFileName } from "@lifer/core/packs/packId.js";
import { createJob, type JobContext } from "../lib/job.js";
import {
  catalogFirstBootState,
  catalogUpdateJob,
  checkCatalogUpdate,
  startCatalogUpdateJob,
  waitForFirstBootCatalog,
} from "../species/catalogSeedUpdate.js";
import { downloadToFile } from "../lib/download.js";
import { sha256OfFile } from "@lifer/core/lib/resumableDownload.js";
import { invalidateSuggestionCache } from "@lifer/core/species/embeddings.js";
import { resolveSpeciesSplits } from "../species/speciesSplits.js";
import {
  assertTrustedPackUrl,
  basePackId,
  computePackStatuses,
  fetchPackIndex,
  invalidatePackSizes,
  SMALL_SUFFIX,
} from "./index.js";
import { downloadPhotos, fetchPhotoStoreIndex, missingPhotos, type PhotoStoreIndex } from "./photoStore.js";
import { applyPack, type PackManifest } from "./apply.js";
import { startWithheldPhotoFetch } from "../species/withheldPhotos.js";
import { log } from "@lifer/core/lib/log.js";

// `packIds` lets a remounting client show which packs are updating. Packs applied before a
// cancel stay applied (each commits on its own).
interface DownloadJobExtra {
  packIds: string[];
  currentPack: string | null;
}
const downloadJob = createJob<{ packsApplied: number }, DownloadJobExtra>("pack-download", {
  packIds: [],
  currentPack: null,
});

/** Whether a pack download is running: removing packs meanwhile could delete photos it needs. */
export const isPackDownloadRunning = (): boolean => downloadJob.status.running;

function startDownloadJob(packIds: string[], force = false): boolean {
  return downloadJob.start(
    async (ctx) => {
      try {
        return await runDownloadJob(ctx, packIds, force);
      } finally {
        // Whatever packs got applied, even when a later one failed: their checklists may have
        // species whose photo the packs couldn't include. In the background, never part of the job.
        startWithheldPhotoFetch("pack download");
      }
    },
    { packIds, total: packIds.length, processed: 0 },
  );
}

// A pack can't add species this install's catalog lacks, so a newer published catalog is
// installed first. Offline, packs still apply and log what they had to leave out.
async function ensureCatalogCurrent(ctx: JobContext<{ packsApplied: number }, DownloadJobExtra>): Promise<void> {
  if (catalogFirstBootState() === "running") {
    ctx.update({ phase: "preparing" });
    await waitForFirstBootCatalog();
  }
  if (!catalogUpdateJob.running) {
    let available: boolean;
    try {
      available = (await checkCatalogUpdate(pool)).available;
    } catch (err) {
      log.warn({ err }, "[packs] couldn't check for a catalog update, applying packs against the current catalog");
      return;
    }
    if (!available) return;
    startCatalogUpdateJob(pool);
  }
  ctx.update({ phase: "updating_catalog", currentItem: null, downloadedBytes: null, totalBytes: null });
  while (catalogUpdateJob.running) {
    ctx.throwIfCancelled();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  if (catalogUpdateJob.error) {
    throw new Error(
      `Couldn't update the species catalog first, so the packs would be missing their newest species: ${catalogUpdateJob.error}`,
    );
  }
  if (catalogUpdateJob.cancelled) {
    throw new Error("The species catalog update was cancelled. Start the download again to finish it.");
  }
}

async function runDownloadJob(
  ctx: JobContext<{ packsApplied: number }, DownloadJobExtra>,
  requestedPackIds: string[],
  force = false,
): Promise<{ packsApplied: number }> {
  const job = downloadJob.status;
  let packsApplied = 0;
  const index = await fetchPackIndex({ fresh: true });
  const byId = new Map(index.packs.map((p) => [p.id, p]));
  await ensureCatalogCurrent(ctx);

  const queue = [...requestedPackIds];
  const seen = new Set<string>();
  let photoIndex: PhotoStoreIndex | null = null;
  const done = () => ctx.update({ processed: (job.processed ?? 0) + 1 });

  while (queue.length > 0) {
    ctx.throwIfCancelled();
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ctx.update({
      currentItem: id,
      currentPack: id,
      total: seen.size + queue.length,
      phase: "downloading",
      downloadedBytes: 0,
      totalBytes: null,
    });

    // A ".small" id installs the same pack without its gallery photos when the index has no
    // separate small pack.
    const requested = basePackId(id);
    const entry = byId.get(id) ?? (index.photoStore ? byId.get(requested.id) : undefined);
    const includeGallery = !requested.small;
    if (!entry) {
      // Unknown pack id (stale index or dependency): skip it rather than fail the whole job.
      done();
      continue;
    }

    // Skipped when the content is unchanged. `force` re-applies anyway, to restore provinces
    // that were offloaded individually.
    if (!force) {
      const already = await pool.query<{ content_version: string | null }>(
        `SELECT content_version FROM downloaded_packs WHERE pack_id = $1`,
        [id],
      );
      if (already.rows.length > 0 && already.rows[0].content_version === entry.contentVersion) {
        done();
        continue;
      }
    }

    assertTrustedPackUrl(entry.url);
    const tmpFile = path.join(os.tmpdir(), `${id}.pack.tar.gz`);
    try {
      // Streamed with a stall timeout rather than a total cap; the job's signal aborts the body
      // read too, so cancel is immediate.
      let bytes: number;
      try {
        // A pack is a byte range of a pack store shard (data-pipeline's pipeline/packStore.ts).
        ({ bytes } = await downloadToFile(entry.url, tmpFile, {
          signal: ctx.signal,
          range: entry.range,
          onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
        }));
        if (entry.sha256 && (await sha256OfFile(tmpFile)) !== entry.sha256) {
          throw new Error("the downloaded pack is damaged (its checksum doesn't match)");
        }
      } catch (err) {
        ctx.throwIfCancelled();
        throw new Error(`Couldn't download "${id}": ${(err as Error).message}`, { cause: err });
      }
      ctx.throwIfCancelled();
      // On a brand-new server the catalog may still be loading (seedCatalogIfEmpty), so applying
      // waits for it.
      if (catalogFirstBootState() === "running") {
        ctx.update({ phase: "preparing" });
        await waitForFirstBootCatalog();
        ctx.throwIfCancelled();
      } else if (catalogFirstBootState() === "failed") {
        await waitForFirstBootCatalog();
      }
      ctx.update({ phase: "applying" });

      // One transaction for the whole pack, so a restart mid-apply can't leave a half-written
      // checklist.
      let touchedIds: string[] = [];
      const manifest: PackManifest = await withTransaction(
        async (client) => {
          const applyResult = await applyPack(client, tmpFile);
          if (applyResult.skippedNames.length > 0) {
            const sample = applyResult.skippedNames.slice(0, 10).join(", ");
            log.warn(
              `[packs] ${id}: ${applyResult.skippedNames.length} species aren't in this install's catalog and were left out (${sample}${applyResult.skippedNames.length > 10 ? ", ..." : ""})`,
            );
          }
          const speciesCount = applyResult.speciesCount;
          const { touched, allChildRegionIds, territoryChildRegionIds } = applyResult;
          touchedIds = [...new Set(touched.map((t) => t.speciesId))];

          // Every download restores all provinces except overseas territories, which are opt-in
          // (NULL means all applied).
          const defaultAppliedProvinceIds =
            territoryChildRegionIds.length > 0
              ? JSON.stringify(allChildRegionIds.filter((rid) => !territoryChildRegionIds.includes(rid)))
              : null;
          await client.query(
            `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count, bytes, content_version, applied_province_region_ids)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (pack_id) DO UPDATE SET
             species_count = EXCLUDED.species_count, bytes = EXCLUDED.bytes, content_version = EXCLUDED.content_version,
             downloaded_at = now(), applied_province_region_ids = EXCLUDED.applied_province_region_ids`,
            [
              id,
              entry.region ?? entry.seaZone ?? null,
              entry.taxon ?? null,
              speciesCount,
              bytes,
              entry.contentVersion,
              defaultAppliedProvinceIds,
            ],
          );

          // A species can be in both the country and a province checklist, and one INSERT can't update
          // the same row twice, so dedupe first (providedEnrichment wins).
          const touchedBySpeciesId = new Map<string, boolean>();
          for (const t of touched) {
            touchedBySpeciesId.set(t.speciesId, touchedBySpeciesId.get(t.speciesId) || t.providedEnrichment);
          }
          if (touchedBySpeciesId.size > 0) {
            const speciesIds = [...touchedBySpeciesId.keys()];
            const providedFlags = speciesIds.map((sid) => touchedBySpeciesId.get(sid)!);
            await client.query(
              `INSERT INTO pack_species (pack_id, species_id, provided_enrichment)
             SELECT $1, unnest($2::uuid[]), unnest($3::boolean[])
             ON CONFLICT (pack_id, species_id) DO UPDATE SET provided_enrichment = EXCLUDED.provided_enrichment`,
              [id, speciesIds, providedFlags],
            );
          }

          // Remove the checklist rows of the territories left out above.
          if (territoryChildRegionIds.length > 0 && touchedBySpeciesId.size > 0) {
            const speciesIds = [...touchedBySpeciesId.keys()];
            for (const territoryRegionId of territoryChildRegionIds) {
              await client.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2)`, [
                territoryRegionId,
                speciesIds,
              ]);
            }
          }
          return applyResult.manifest;
        },
        { lockReferenceData: true },
      );
      invalidateSuggestionCache();

      // Then fetch missing photos from the shared photo store. A failed photo is retried on the
      // next install or update.
      if (index.photoStore) {
        photoIndex ??= await fetchPhotoStoreIndex(index.photoStore.indexUrl, { fresh: true });
        const needs = await missingPhotos(pool, photoIndex, touchedIds, includeGallery);
        if (needs.length > 0) {
          ctx.update({ phase: "photos", downloadedBytes: 0, totalBytes: null });
          const result = await downloadPhotos(pool, index.photoStore.indexUrl, photoIndex, needs, {
            signal: ctx.signal,
            assertUrl: assertTrustedPackUrl,
            onProgress: (downloadedBytes, totalBytes) => ctx.update({ downloadedBytes, totalBytes }),
          });
          if (result.failed > 0)
            log.warn(`[packs] ${id}: ${result.failed} photo(s) didn't download and will be retried next time`);
        }
      }

      packsApplied++;
      done();
      for (const dep of manifest.seaZoneDependencies ?? []) {
        // A small install's sea zones are small too.
        const depId = packIdFromFileName(dep.packFile) + (requested.small ? SMALL_SUFFIX : "");
        if (!seen.has(depId)) queue.push(depId);
      }
    } finally {
      rmSync(tmpFile, { force: true });
    }
  }
  invalidatePackSizes();
  // A pack's checklists can settle photos under a split species that the catalog alone couldn't.
  if (packsApplied > 0) await resolveSpeciesSplits();
  return { packsApplied };
}

// Pack ids come from the published index (like "united-states-aves"), not the database.
export const PackId = Type.String({ minLength: 1, maxLength: 200 });
const PackIds = Type.Array(PackId, { minItems: 1 });

export async function packDownloadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.get("/offline-packs/download/status", { preValidation: requireAuth, schema: {} }, async () => downloadJob.status);

  app.post(
    "/offline-packs/download",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            packIds: PackIds,
            force: Type.Optional(Type.Boolean({ description: "Download again even when up to date" })),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const { packIds, force } = request.body;
      // Runs in the background so a large download doesn't hold an HTTP request open.
      if (!startDownloadJob(packIds, force ?? false)) {
        return reply.code(409).send({ error: "A pack download is already in progress" });
      }
      return { started: true };
    },
  );

  // Stops the current pack's download and the rest of the queue. 200 even when nothing runs.
  // No body schema: the web app sends `{}` and nothing in it is read.
  app.post("/offline-packs/download/cancel", { preValidation: requireAuth, schema: {} }, async () => ({
    cancelled: downloadJob.cancel(),
  }));

  // Resolves the map picker's countries x taxa selection to pack ids and starts the download.
  app.post(
    "/offline-packs/download-batch",
    {
      preValidation: requireAuth,
      schema: {
        body: Type.Object(
          {
            regionNames: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
            // Taxa to download, or "all". Left out, only packs that cover every taxon match.
            taxa: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Literal("all")])),
            variant: Type.Optional(Type.Enum(["full", "small"])),
          },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      if (downloadJob.status.running) {
        return reply.code(409).send({ error: "A pack download is already in progress" });
      }
      const { regionNames, taxa } = request.body;
      const variant = request.body.variant ?? "full";
      try {
        const statuses = await computePackStatuses();
        const regionSet = new Set(regionNames);
        const taxaSet = taxa === "all" ? null : new Set(taxa ?? []);
        const packIds = statuses.packs
          .filter((p) => {
            const region = p.region ?? p.seaZone;
            if (!region || !regionSet.has(region)) return false;
            // A pack with no taxon covers every taxon; otherwise its taxon must be requested.
            if (taxaSet && p.taxon && !taxaSet.has(p.taxon)) return false;
            // Full and small variants both pass the filters above, so keep only one per region/taxon.
            if ((p.variant ?? "full") !== variant) return false;
            return !p.downloaded || p.updateAvailable;
          })
          .map((p) => p.id);

        if (packIds.length === 0) return { started: false, packIds: [] };

        if (!startDownloadJob(packIds))
          return reply.code(409).send({ error: "A pack download is already in progress" });

        return { started: true, packIds };
      } catch (err) {
        return reply.code(503).send({ error: (err as Error).message, code: "pack_index_unavailable" });
      }
    },
  );
}
