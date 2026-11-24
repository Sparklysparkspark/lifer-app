// Downloads packs in a background job with download, set-up and photo lanes running at once
// (runDownloadJob). A pack's sea-zone dependencies are queued once.
import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { pool, withTransaction } from "@lifer/core/db.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { replies, withSchemas } from "../lib/schema.js";
import { BatchStarted, Cancelled, PackDownloadStatus, Started } from "./responses.js";
// Cross-package import: pure id derivation with no heavy dependencies.
import { packIdFromFileName } from "@lifer/core/packs/packId.js";
import { createJob, runningJobNames, type JobContext } from "../lib/job.js";
import {
  catalogFirstBootState,
  catalogLoadProgress,
  catalogUpdate,
  checkCatalogUpdate,
  startCatalogUpdateJob,
  waitForFirstBootCatalog,
} from "../species/catalogSeedUpdate.js";
import { downloadResumable } from "@lifer/core/lib/resumableDownload.js";
import { invalidateSuggestionCache } from "@lifer/core/species/embeddings.js";
import { ensureRegionRollup } from "../regions/rollup.js";
import { resolveSpeciesSplits } from "../species/speciesSplits.js";
import {
  assertTrustedPackUrl,
  basePackId,
  computePackStatuses,
  fetchPackIndex,
  invalidatePackSizes,
  SMALL_SUFFIX,
} from "./index.js";
import { isUnreachable, retrying } from "../lib/remoteFetch.js";
import { downloadPhotos, fetchPhotoStoreIndex, missingPhotos, type PhotoStoreIndex } from "./photoStore.js";
import { applyPack, applyPackHotspots, prefetchPackProvinces, type RegionHotspots } from "./apply.js";
import { startWithheldPhotoFetch } from "../species/withheldPhotos.js";
import { log } from "@lifer/core/lib/log.js";
import { idlePackLanes, TAXON_CLASS_LABEL, type PackDownloadLanes, type TaxonClass } from "@lifer/shared";

// `packIds` lets a remounting client show which packs are updating. Packs set up before a
// cancel stay set up (each commits on its own).
interface DownloadJobExtra {
  packIds: string[];
  currentPack: string | null;
  lanes: PackDownloadLanes;
}
const downloadJob = createJob<{ packsApplied: number }, DownloadJobExtra>("pack-download", {
  packIds: [],
  currentPack: null,
  lanes: idlePackLanes(),
});

/** Whether a pack download is running: removing packs meanwhile could delete photos it needs. */
export const isPackDownloadRunning = (): boolean => downloadJob.status.running;

// The running job's work list: the routes append to `queue`, the job shifts from it. Node runs
// one handler at a time, so an append can't interleave with a shift.
interface DownloadQueue {
  queue: string[];
  seen: Set<string>;
  forced: Set<string>;
  // Set by stopPackDownloads, so packs set up afterwards don't queue their sea zones.
  stopped: boolean;
  // Aborts pack file downloads only; replaced after each stop.
  downloads: AbortController;
  // Wakes idle lanes when the routes queue more or stop the downloads.
  wake: () => void;
}
let active: DownloadQueue | null = null;

/** Starts downloading packs unless a download is running. The sync routes start one for packs the linked server has. */
export function startPackDownload(packIds: string[], force = false): boolean {
  const state: DownloadQueue = {
    queue: [...packIds],
    seen: new Set(),
    forced: new Set(force ? packIds : []),
    stopped: false,
    downloads: new AbortController(),
    wake: () => {},
  };
  return downloadJob.start(
    async (ctx) => {
      active = state;
      try {
        return await runDownloadJob(ctx, state);
      } finally {
        if (active === state) active = null;
        // Whatever packs got applied, even when a later one failed: their checklists may have
        // species whose photo the packs couldn't include. In the background, never part of the job.
        startWithheldPhotoFetch("pack download");
      }
    },
    { packIds, total: packIds.length, processed: 0 },
  );
}

/** Appends packs not already done or queued to the running download. Null when none is running. */
export function enqueuePackDownload(packIds: string[], force = false): number | null {
  const state = active;
  if (!state || !downloadJob.status.running || downloadJob.status.cancelRequested) return null;
  const fresh = [...new Set(packIds)].filter((id) => !state.seen.has(id) && !state.queue.includes(id));
  state.queue.push(...fresh);
  if (force) fresh.forEach((id) => state.forced.add(id));
  state.stopped = false;
  const job = downloadJob.status;
  job.packIds = [...job.packIds, ...fresh];
  job.total = state.seen.size + state.queue.length;
  state.wake();
  return fresh.length;
}

/** Stops downloading packs; the ones already on disk still finish setting up. False when none is running. */
export function stopPackDownloads(): boolean {
  const state = active;
  if (!state || !downloadJob.status.running) return false;
  state.queue.length = 0;
  state.stopped = true;
  state.downloads.abort();
  state.downloads = new AbortController();
  state.wake();
  return true;
}

/** Queues onto the running download, or starts one. */
function queueOrStart(packIds: string[], force = false): { started: boolean; queued?: number } | null {
  const queued = enqueuePackDownload(packIds, force);
  if (queued !== null) return { started: false, queued };
  return startPackDownload(packIds, force) ? { started: true } : null;
}

/** Applies again the packs whose hotspots never landed (the app quit or the job was cancelled
 *  between a pack's two steps). The pack file is usually still on disk, so this rarely downloads. */
export async function resumePendingPackHotspots(): Promise<void> {
  const res = await pool.query<{ pack_id: string }>(
    `SELECT pack_id FROM downloaded_packs WHERE hotspots_applied_version IS DISTINCT FROM content_version`,
  );
  if (res.rows.length > 0) queueOrStart(res.rows.map((r) => r.pack_id));
}

// A pack can't add species this install's catalog lacks, so a newer published catalog is
// installed first. Offline, packs still apply and log what they had to leave out.
async function ensureCatalogCurrent(ctx: JobContext<{ packsApplied: number }, DownloadJobExtra>): Promise<void> {
  if (catalogFirstBootState() === "running") {
    ctx.update({ phase: "preparing" });
    await waitForFirstBootCatalog();
  }
  const catalog = catalogUpdate.status;
  if (!catalog.running) {
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
  // Cancelling the pack download stops waiting; the catalog update carries on by itself.
  const cancelled = new Promise<void>((resolve) => {
    if (ctx.signal.aborted) resolve();
    else ctx.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([catalogUpdate.settled(), cancelled]);
  ctx.throwIfCancelled();
  if (catalog.error) {
    throw new Error(
      `Couldn't update the species catalog first, so the packs would be missing their newest species: ${catalog.error}`,
    );
  }
  if (catalog.cancelled) {
    throw new Error("The species catalog update was cancelled. Start the download again to finish it.");
  }
}

// At most this many downloaded packs wait on disk for the set-up lane.
const MAX_PACKS_ON_DISK = 2;

// Three lanes run at once. Download fetches pack files. Set-up applies each pack's checklist in
// one transaction, then its hotspots in a second one (checklists first, so species are usable
// sooner). Photos fetches photos for packs already set up. The first error stops every lane.
async function runDownloadJob(
  ctx: JobContext<{ packsApplied: number }, DownloadJobExtra>,
  state: DownloadQueue,
): Promise<{ packsApplied: number }> {
  const { queue, seen, forced } = state;
  const job = downloadJob.status;
  const lanes = job.lanes;
  let packsApplied = 0;
  const index = await fetchPackIndex({ fresh: true });
  const byId = new Map(index.packs.map((p) => [p.id, p]));
  // What the progress rows name: "Belize reptiles", not the pack id.
  const packLabel = (id: string): string => {
    const pack = byId.get(basePackId(id).id);
    const place = pack?.region ?? pack?.seaZone;
    if (!pack || !place) return id;
    const group = pack.taxon ? (TAXON_CLASS_LABEL[pack.taxon as TaxonClass] ?? pack.taxon) : null;
    return `${place}${group ? ` ${group.toLowerCase()}` : ""}`;
  };
  await ensureCatalogCurrent(ctx);

  type Entry = (typeof index.packs)[number];
  interface OnDisk {
    id: string;
    label: string;
    file: string;
    bytes: number;
    entry: Entry;
    small: boolean;
  }
  const onDisk: OnDisk[] = [];
  const hotspotWork: Array<{ id: string; label: string; file: string; version: string; hotspots: RegionHotspots[] }> =
    [];
  const photoWork: Array<{ id: string; label: string; touchedIds: string[]; includeGallery: boolean }> = [];
  const busy = { download: null as string | null, setup: null as string | null, photos: null as string | null };
  const failed = new AbortController();
  let failure: unknown = null;
  let closing = false;
  let waiters: Array<() => void> = [];
  const wake = () => {
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  };
  state.wake = wake;
  ctx.signal.addEventListener("abort", wake, { once: true });
  let photoIndex: PhotoStoreIndex | null = null;

  // Lane totals, and the old single-phase fields for sync callers, follow the lanes.
  const refresh = () => {
    const total = seen.size + queue.length;
    for (const lane of Object.values(lanes)) lane.total = total;
    const lead = busy.setup ? lanes.setup : busy.download ? lanes.download : busy.photos ? lanes.photos : null;
    const phase = busy.setup ? "applying" : busy.download ? "downloading" : busy.photos ? "photos" : job.phase;
    ctx.update({
      lanes,
      total,
      processed: lanes.photos.processed,
      phase,
      currentPack: busy.setup ?? busy.download ?? busy.photos,
      currentItem: lead?.currentItem ?? null,
      downloadedBytes: lead?.downloadedBytes ?? null,
      totalBytes: lead?.totalBytes ?? null,
    });
  };
  const skip = () => {
    for (const lane of Object.values(lanes)) lane.processed++;
  };
  const idle = () =>
    !busy.download &&
    !busy.setup &&
    !busy.photos &&
    queue.length === 0 &&
    onDisk.length === 0 &&
    hotspotWork.length === 0 &&
    photoWork.length === 0;

  async function lane(
    name: keyof typeof busy,
    next: () => { id: string; label: string; run: () => Promise<void> } | null,
  ): Promise<void> {
    for (;;) {
      if (failure || ctx.signal.aborted) return;
      const work = next();
      if (work) {
        busy[name] = work.id;
        lanes[name].currentItem = work.label;
        refresh();
        try {
          await work.run();
        } catch (err) {
          failure ??= err;
          failed.abort();
        } finally {
          busy[name] = null;
          Object.assign(lanes[name], { currentItem: null, downloadedBytes: null, totalBytes: null });
          refresh();
          wake();
        }
        continue;
      }
      // Nothing left anywhere: every lane stops, and the routes' later packs start a new round.
      if (closing || idle()) {
        closing = true;
        wake();
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }

  async function download(id: string): Promise<void> {
    // A ".small" id installs the same pack without its gallery photos when the index has no
    // separate small pack.
    const requested = basePackId(id);
    const entry = byId.get(id) ?? (index.photoStore ? byId.get(requested.id) : undefined);
    // Unknown pack id (stale index or dependency): skip it rather than fail the whole job.
    if (!entry) return skip();
    // Skipped when the content and its hotspots are in. `force` applies anyway, to restore
    // provinces that were offloaded individually.
    if (!forced.has(id)) {
      const already = await pool.query<{ current: boolean }>(
        `SELECT content_version IS NOT DISTINCT FROM $2 AND hotspots_applied_version IS NOT DISTINCT FROM content_version AS current
         FROM downloaded_packs WHERE pack_id = $1`,
        [id, entry.contentVersion],
      );
      if (already.rows[0]?.current) return skip();
    }

    assertTrustedPackUrl(entry.url);
    const file = path.join(os.tmpdir(), `${id}.pack.tar.gz`);
    const downloads = state.downloads;
    let bytes: number;
    try {
      // Streamed with a stall timeout rather than a total cap; the signal aborts the body read
      // too, so cancel is immediate. A pack is a byte range of a pack store shard
      // (data-pipeline's pipeline/packStore.ts).
      // Retried with backoff: a weak signal that stalls once still gets the pack.
      const signal = AbortSignal.any([ctx.signal, downloads.signal, failed.signal]);
      ({ bytes } = await retrying(
        () =>
          downloadResumable(entry.url, file, {
            signal,
            range: entry.range,
            expectedSha256: entry.sha256,
            label: `"${id}"`,
            onProgress: (downloadedBytes, totalBytes) => {
              Object.assign(lanes.download, { downloadedBytes, totalBytes });
              refresh();
            },
          }),
        { signal },
      ));
    } catch (err) {
      rmSync(file, { force: true });
      ctx.throwIfCancelled();
      // Stopped by the user: a later request may queue it again.
      if (downloads.signal.aborted) {
        seen.delete(id);
        return;
      }
      const message = (err as Error).message;
      // The downloader's own errors already name the pack.
      throw new Error(message.startsWith("Couldn't download") ? message : `Couldn't download "${id}": ${message}`, {
        cause: err,
      });
    }
    lanes.download.processed++;
    onDisk.push({ id, label: packLabel(id), file, bytes, entry, small: requested.small });
  }

  async function setUp({ id, file, bytes, entry, small, label }: OnDisk): Promise<void> {
    let keepFile = false;
    try {
      lanes.setup.step = "checklist";
      // On a brand-new server the catalog may still be loading (seedCatalogIfEmpty).
      if (catalogFirstBootState() === "running" || catalogFirstBootState() === "failed") {
        await waitForFirstBootCatalog();
      }
      ctx.throwIfCancelled();
      // Network first: the transaction below must not hold a connection while a download waits.
      const provinces = await prefetchPackProvinces(pool, file);
      ctx.throwIfCancelled();

      // One transaction for the checklist, so a restart mid-apply can't leave half of one.
      const applied = await withTransaction(
        async (client) => {
          const applyResult = await applyPack(client, file, { provinces });
          if (applyResult.skippedNames.length > 0) {
            const sample = applyResult.skippedNames.slice(0, 10).join(", ");
            log.warn(
              `[packs] ${id}: ${applyResult.skippedNames.length} species aren't in this install's catalog and were left out (${sample}${applyResult.skippedNames.length > 10 ? ", ..." : ""})`,
            );
          }
          const { touched, allChildRegionIds, territoryChildRegionIds, hotspots } = applyResult;

          // Every download restores all provinces except overseas territories, which are opt-in
          // (NULL means all applied).
          const defaultAppliedProvinceIds =
            territoryChildRegionIds.length > 0
              ? JSON.stringify(allChildRegionIds.filter((rid) => !territoryChildRegionIds.includes(rid)))
              : null;
          // Hotspots still to come leave hotspots_applied_version behind until they land.
          await client.query(
            `INSERT INTO downloaded_packs (pack_id, region, taxon, species_count, bytes, content_version, applied_province_region_ids, hotspots_applied_version)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (pack_id) DO UPDATE SET
               species_count = EXCLUDED.species_count, bytes = EXCLUDED.bytes, content_version = EXCLUDED.content_version,
               downloaded_at = now(), applied_province_region_ids = EXCLUDED.applied_province_region_ids,
               hotspots_applied_version = EXCLUDED.hotspots_applied_version`,
            [
              id,
              entry.region ?? entry.seaZone ?? null,
              entry.taxon ?? null,
              applyResult.speciesCount,
              bytes,
              entry.contentVersion,
              defaultAppliedProvinceIds,
              hotspots.length > 0 ? null : entry.contentVersion,
            ],
          );

          // A species can be in both the country and a province checklist, and one INSERT can't update
          // the same row twice, so dedupe first (providedEnrichment wins).
          const touchedBySpeciesId = new Map<string, boolean>();
          for (const t of touched) {
            touchedBySpeciesId.set(t.speciesId, touchedBySpeciesId.get(t.speciesId) || t.providedEnrichment);
          }
          const speciesIds = [...touchedBySpeciesId.keys()];
          if (speciesIds.length > 0) {
            await client.query(
              `INSERT INTO pack_species (pack_id, species_id, provided_enrichment)
               SELECT $1, unnest($2::uuid[]), unnest($3::boolean[])
               ON CONFLICT (pack_id, species_id) DO UPDATE SET provided_enrichment = EXCLUDED.provided_enrichment`,
              [id, speciesIds, speciesIds.map((sid) => touchedBySpeciesId.get(sid)!)],
            );
            // Remove the checklist rows of the territories left out above.
            for (const territoryRegionId of territoryChildRegionIds) {
              await client.query(`DELETE FROM region_species WHERE region_id = $1 AND species_id = ANY($2)`, [
                territoryRegionId,
                speciesIds,
              ]);
            }
          }
          return { manifest: applyResult.manifest, touchedIds: speciesIds, hotspots };
        },
        { lockReferenceData: true },
      );
      invalidateSuggestionCache();
      void ensureRegionRollup();
      packsApplied++;
      lanes.setup.processed++;

      // A failed photo is retried on the next install or update.
      photoWork.push({ id, label, touchedIds: applied.touchedIds, includeGallery: !small });
      if (applied.hotspots.length > 0) {
        // The file stays until the hotspots land, so a resume after a quit needn't download it.
        hotspotWork.push({ id, label, file, version: entry.contentVersion, hotspots: applied.hotspots });
        keepFile = true;
      }
      if (!state.stopped) {
        for (const dep of applied.manifest.seaZoneDependencies ?? []) {
          // A small install's sea zones are small too.
          const depId = packIdFromFileName(dep.packFile) + (small ? SMALL_SUFFIX : "");
          if (!seen.has(depId) && !queue.includes(depId)) {
            queue.push(depId);
            if (forced.has(id)) forced.add(depId);
          }
        }
      }
    } finally {
      lanes.setup.step = null;
      if (!keepFile) rmSync(file, { force: true });
    }
  }

  async function setUpHotspots(work: (typeof hotspotWork)[number]): Promise<void> {
    lanes.setup.step = "hotspots";
    try {
      ctx.throwIfCancelled();
      await withTransaction(
        async (client) => {
          await applyPackHotspots(client, work.hotspots);
          await client.query(`UPDATE downloaded_packs SET hotspots_applied_version = $2 WHERE pack_id = $1`, [
            work.id,
            work.version,
          ]);
        },
        { lockReferenceData: true },
      );
      rmSync(work.file, { force: true });
    } finally {
      lanes.setup.step = null;
    }
  }

  async function fetchPhotos({ id, touchedIds, includeGallery }: (typeof photoWork)[number]): Promise<void> {
    if (index.photoStore) {
      photoIndex ??= await fetchPhotoStoreIndex(index.photoStore.indexUrl, { fresh: true });
      const needs = await missingPhotos(pool, photoIndex, touchedIds, includeGallery);
      if (needs.length > 0) {
        const result = await downloadPhotos(pool, index.photoStore.indexUrl, photoIndex, needs, {
          signal: AbortSignal.any([ctx.signal, failed.signal]),
          assertUrl: assertTrustedPackUrl,
          onProgress: (downloadedBytes, totalBytes) => {
            Object.assign(lanes.photos, { downloadedBytes, totalBytes });
            refresh();
          },
        });
        if (result.failed > 0)
          log.warn(`[packs] ${id}: ${result.failed} photo(s) didn't download and will be retried next time`);
      }
    }
    lanes.photos.processed++;
  }

  const nextDownload = () => {
    while (queue.length > 0 && seen.has(queue[0])) queue.shift();
    if (queue.length === 0 || onDisk.length >= MAX_PACKS_ON_DISK) return null;
    const id = queue.shift()!;
    seen.add(id);
    return { id, label: packLabel(id), run: () => download(id) };
  };
  const nextSetup = () => {
    // Checklists first; at most two packs' hotspots wait in memory meanwhile.
    if (onDisk.length > 0 && hotspotWork.length < 2) {
      const pack = onDisk.shift()!;
      wake();
      return { id: pack.id, label: pack.label, run: () => setUp(pack) };
    }
    const work = hotspotWork.shift();
    return work ? { id: work.id, label: work.label, run: () => setUpHotspots(work) } : null;
  };
  const nextPhotos = () => {
    const work = photoWork.shift();
    return work ? { id: work.id, label: work.label, run: () => fetchPhotos(work) } : null;
  };

  // Once every lane is idle, the wrap-up steps run; packs queued meanwhile go round again.
  const drained = async (): Promise<boolean> => {
    invalidatePackSizes();
    // A pack's checklists can settle photos under a split species that the catalog alone couldn't.
    if (packsApplied > 0) await resolveSpeciesSplits();
    if (queue.length > 0) return false;
    // In the same step as the empty check, so a later request starts a new job instead.
    if (active?.queue === queue) active = null;
    return true;
  };
  try {
    for (;;) {
      closing = false;
      await Promise.all([lane("download", nextDownload), lane("setup", nextSetup), lane("photos", nextPhotos)]);
      if (failure) throw failure;
      ctx.throwIfCancelled();
      if (await drained()) break;
    }
  } finally {
    // Downloaded but not set up. Files whose hotspots are pending stay for the startup resume.
    for (const pack of onDisk) rmSync(pack.file, { force: true });
  }
  return { packsApplied };
}

// Pack ids come from the published index (like "united-states-aves"), not the database.
export const PackId = Type.String({ minLength: 1, maxLength: 200 });
const PackIds = Type.Array(PackId, { minItems: 1 });

export async function packDownloadRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  // The linked desktop app's key (scope "sync") may list, start and watch downloads: that's how
  // the packs it has reach the server (sync/packs.ts).
  app.get(
    "/offline-packs/download/status",
    { preValidation: requireScope("sync"), schema: { response: replies(PackDownloadStatus) } },
    // The catalog load is shared, so packs waiting on it show its progress too.
    async () => ({ ...downloadJob.status, catalogProgress: catalogLoadProgress() }),
  );

  app.post(
    "/offline-packs/download",
    {
      preValidation: requireScope("sync"),
      schema: {
        body: Type.Object(
          {
            packIds: PackIds,
            force: Type.Optional(Type.Boolean({ description: "Download again even when up to date" })),
          },
          { additionalProperties: false },
        ),
        response: replies(Started),
      },
    },
    async (request, reply) => {
      if (runningJobNames.has("pack-removal"))
        return reply.code(409).send({ error: "Wait for the region removal to finish, then try again" });
      const { packIds, force } = request.body;
      // Runs in the background so a large download doesn't hold an HTTP request open.
      const result = queueOrStart(packIds, force ?? false);
      // Only in the moment a cancelled or finishing job winds down.
      if (!result) return reply.code(409).send({ error: "A region download is already in progress" });
      return result;
    },
  );

  // Stops everything: downloads, set-up and photos. With `{ downloadsOnly: true }` only the
  // downloads stop and packs already on disk finish setting up. 200 even when nothing runs.
  // No body schema, since callers may send no body at all.
  app.post(
    "/offline-packs/download/cancel",
    { preValidation: requireAuth, schema: { response: replies(Cancelled) } },
    async (request) => ({
      cancelled:
        (request.body as { downloadsOnly?: unknown } | undefined)?.downloadsOnly === true
          ? stopPackDownloads()
          : downloadJob.cancel(),
    }),
  );

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
        response: replies(BatchStarted),
      },
    },
    async (request, reply) => {
      if (runningJobNames.has("pack-removal"))
        return reply.code(409).send({ error: "Wait for the region removal to finish, then try again" });
      const { regionNames, taxa } = request.body;
      const variant = request.body.variant ?? "full";
      try {
        let statuses = await computePackStatuses();
        // No copy of the index yet: wait for one (patiently, with retries) rather than refuse.
        if (statuses.indexUnavailable) {
          await fetchPackIndex({ fresh: true });
          statuses = await computePackStatuses();
        }
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
          // The first chosen country first, then groups in the order picked (Birds first when
          // every group is wanted), so the user can start once the first pack is set up.
          .map((p) => ({
            id: p.id,
            rank: [
              regionNames.indexOf(p.region ?? p.seaZone ?? ""),
              Array.isArray(taxa) ? taxa.indexOf(p.taxon ?? "") : p.taxon === "aves" ? 0 : 1,
            ],
          }))
          .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1])
          .map((p) => p.id);

        if (packIds.length === 0) return { started: false, packIds: [] };

        const result = queueOrStart(packIds);
        if (!result) return reply.code(409).send({ error: "A region download is already in progress" });
        return { ...result, packIds };
      } catch (err) {
        // Only after patient retries; "offline" only when the host couldn't be reached at all.
        const error = isUnreachable(err)
          ? "Can't reach the region downloads. Check the connection and try again."
          : "The connection is too slow to get the list of downloads right now. Try again in a moment.";
        return reply.code(503).send({ error, code: "pack_index_unavailable" });
      }
    },
  );
}
