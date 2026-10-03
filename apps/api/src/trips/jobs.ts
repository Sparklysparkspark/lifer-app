import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "../db.js";
import { isUuid } from "../lib/validate.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { scanTrip, resolveWithinTripFolder } from "./scan.js";
import { importInboxFile } from "./import.js";
import { listRawFiles } from "./rawLink.js";
import { extractExif, extractKeywords, readExifTags } from "../uploads/exif.js";
import { computeEmbedding, suggestSpecies, type SpeciesSuggestion } from "../species/embeddings.js";
import { matchSpeciesByKeywords, groupByScientificName } from "../species/matchByKeywords.js";
import { checkNotWildlife } from "../species/wildlifeCheck.js";
import { sniffPhotoFormat } from "../uploads/formats.js";
import { prepareWorkingImage } from "../uploads/workingImage.js";
import { originalSharpOptions } from "../lib/imageLimits.js";
import { isWithin } from "../lib/allowedPaths.js";
import sharp from "sharp";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { createJob, type Job, type JobContext } from "../lib/job.js";
import { idleJobStatus, type JobStatus } from "@lifer/shared";

// Each file pays an exiftool round trip plus a sharp resize, so files import in parallel.
const IMPORT_CONCURRENCY = 4;

// In-memory per-trip jobs, not persisted across a restart. Finished entries are pruned after
// JOB_TTL_MS, and polling an unknown trip id never creates one.
const JOB_TTL_MS = 60 * 60_000;

interface ScanSummary {
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  newFiles: Array<{ relativePath: string }>;
}
// The summary fields are also mirrored top-level, alongside `result`.
type ScanExtra = { tripId: string } & ScanSummary;
function emptyScanSummary(): ScanSummary {
  return { relinked: 0, markedStale: 0, collisions: 0, recovered: 0, rawsLinked: 0, newFiles: [] };
}

type ImportFileResult = { relativePath: string; captureId?: string; error?: string };
interface ImportExtra {
  tripId: string;
  // Grows live as files finish.
  results: ImportFileResult[];
}

type ScanJob = Job<ScanSummary, ScanExtra>;
type ImportJob = Job<{ imported: number; failed: number }, ImportExtra>;
const scanJobs = new Map<string, ScanJob>();
const importJobs = new Map<string, ImportJob>();

function pruneFinished<T extends Job<unknown, object>>(jobs: Map<string, T>): void {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (!job.status.running && job.status.finishedAt != null && job.status.finishedAt < cutoff) jobs.delete(id);
  }
}

function scanJobFor(tripId: string): ScanJob {
  let job = scanJobs.get(tripId);
  if (!job) {
    pruneFinished(scanJobs);
    job = createJob<ScanSummary, ScanExtra>(`trip-scan:${tripId}`, { tripId, ...emptyScanSummary() });
    scanJobs.set(tripId, job);
  }
  return job;
}

function importJobFor(tripId: string): ImportJob {
  let job = importJobs.get(tripId);
  if (!job) {
    pruneFinished(importJobs);
    job = createJob<{ imported: number; failed: number }, ImportExtra>(`trip-import:${tripId}`, { tripId, results: [] });
    importJobs.set(tripId, job);
  }
  return job;
}

function idleScanStatus(tripId: string): JobStatus<ScanSummary> & ScanExtra {
  return { ...idleJobStatus<ScanSummary>(), tripId, ...emptyScanSummary() };
}

function idleImportStatus(tripId: string): JobStatus<{ imported: number; failed: number }> & ImportExtra {
  return { ...idleJobStatus<{ imported: number; failed: number }>(), tripId, results: [] };
}

// Lets GET /trips show a loading state on a trip's card while either job runs.
export function isTripBusy(tripId: string): boolean {
  return Boolean(scanJobs.get(tripId)?.status.running || importJobs.get(tripId)?.status.running);
}

async function runScanJob(
  ctx: JobContext<ScanSummary, ScanExtra>,
  tripId: string,
  userId: string,
  sourceFolder: string,
  destinationFolder: string,
): Promise<ScanSummary> {
  const result = await scanTrip(tripId, userId, sourceFolder, destinationFolder, {
    signal: ctx.signal,
    onPhase: (phase) => ctx.update({ phase }),
  });
  const summary: ScanSummary = {
    relinked: result.relinked,
    markedStale: result.markedStale,
    collisions: result.collisions,
    recovered: result.recovered,
    rawsLinked: result.rawsLinked,
    newFiles: result.newFiles.map((f) => ({ relativePath: f.relativePath })),
  };
  ctx.update(summary);
  return summary;
}

async function runImportJob(
  ctx: JobContext<{ imported: number; failed: number }, ImportExtra>,
  job: ImportJob,
  tripId: string,
  userId: string,
  sourceFolder: string,
  destinationFolder: string,
  files: Array<{ relativePath: string; speciesId: string }>,
  regionId: string | null,
): Promise<{ imported: number; failed: number }> {
  let imported = 0;
  let failed = 0;
  // Read once for the whole batch: each photo's RAW is looked up in it (importInboxFile).
  const sourceRaws = (await listRawFiles(sourceFolder)).filter((r) => !isWithin(path.resolve(destinationFolder), path.resolve(r.absolutePath)));
  // Cancel stops new files from starting.
  await mapWithConcurrency(files, IMPORT_CONCURRENCY, async (file) => {
    if (ctx.signal.aborted) return;
    ctx.update({ currentItem: file.relativePath });
    const absolutePath = resolveWithinTripFolder(sourceFolder, file.relativePath);
    let result: ImportFileResult;
    if (!absolutePath) {
      result = { relativePath: file.relativePath, error: "File not found" };
    } else {
      try {
        const { captureId } = await importInboxFile(tripId, userId, file.speciesId, absolutePath, destinationFolder, regionId, sourceRaws);
        result = { relativePath: file.relativePath, captureId };
      } catch (err) {
        result = { relativePath: file.relativePath, error: (err as Error).message };
      }
    }
    if (result.error) failed++;
    else imported++;
    job.status.results.push(result);
    ctx.update({ processed: (job.status.processed ?? 0) + 1 });
    return result;
  });
  ctx.throwIfCancelled();
  return { imported, failed };
}

// Scan/import jobs are keyed by trip id alone; a server has several accounts, so their cancel
// and status routes must check the trip is the caller's before touching the job.
async function ownsTrip(tripId: string, userId: string): Promise<boolean> {
  const res = await pool.query(`SELECT 1 FROM trips WHERE id = $1 AND user_id = $2`, [tripId, userId]);
  return (res.rowCount ?? 0) > 0;
}

// Scan preview serves files straight off the user's disk, so only the media types the app
// imports get through, each with an explicit Content-Type.
const TRIP_PREVIEW_CONTENT_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  // Browsers can't show these, so they're sent as a JPEG made on the fly (see scan-preview).
  ".tif": "image/jpeg",
  ".tiff": "image/jpeg",
  ".heic": "image/jpeg",
  ".heif": "image/jpeg",
};
const TRANSCODED_PREVIEW_EXTENSIONS = new Set([".tif", ".tiff", ".heic", ".heif"]);

// Scan and import run as per-trip background jobs the client polls.
export async function tripJobRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { id: string } }>("/trips/:id/scan", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    const userId = request.user!.id;
    const tripId = request.params.id;
    if (scanJobs.get(tripId)?.status.running) return reply.code(409).send({ error: "A scan is already running for this trip" });

    const tripRes = await pool.query<{ source_folder: string; destination_folder: string }>(
      `SELECT source_folder, destination_folder FROM trips WHERE id = $1 AND user_id = $2`,
      [tripId, userId],
    );
    if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });

    const job = scanJobFor(tripId);
    const { source_folder: sourceFolder, destination_folder: destinationFolder } = tripRes.rows[0];
    const started = job.start((ctx) => runScanJob(ctx, tripId, userId, sourceFolder, destinationFolder), {
      tripId,
      ...emptyScanSummary(),
      phase: "checking",
    });
    if (!started) return reply.code(409).send({ error: "A scan is already running for this trip" });
    return { started: true };
  });

  app.post<{ Params: { id: string } }>("/trips/:id/scan/cancel", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    if (!(await ownsTrip(request.params.id, request.user!.id))) return reply.code(404).send({ error: "Trip not found" });
    return { cancelled: scanJobs.get(request.params.id)?.cancel() ?? false };
  });

  app.get<{ Params: { id: string } }>("/trips/:id/scan/status", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    if (!(await ownsTrip(request.params.id, request.user!.id))) return reply.code(404).send({ error: "Trip not found" });
    return scanJobs.get(request.params.id)?.status ?? idleScanStatus(request.params.id);
  });

  app.get<{ Params: { id: string }; Querystring: { file?: string } }>(
    "/trips/:id/scan-preview",
    { preHandler: requireScope("trips.read") },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
      const userId = request.user!.id;
      const tripRes = await pool.query<{ source_folder: string }>(
        `SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const relativePath = request.query.file;
      if (!relativePath) return reply.code(400).send({ error: "file query param is required" });
      const contentType = TRIP_PREVIEW_CONTENT_TYPES[path.extname(relativePath).toLowerCase()];
      if (!contentType) return reply.code(400).send({ error: "Only image and video files can be previewed" });
      const absolutePath = resolveWithinTripFolder(tripRes.rows[0].source_folder, relativePath);
      if (!absolutePath) return reply.code(404).send({ error: "File not found" });
      // The extension is re-checked on the real path, since a symlink could rename it.
      if (TRIP_PREVIEW_CONTENT_TYPES[path.extname(absolutePath).toLowerCase()] !== contentType) {
        return reply.code(400).send({ error: "Only image and video files can be previewed" });
      }
      reply.header("Content-Type", contentType);
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Cache-Control", "private, max-age=60");
      if (TRANSCODED_PREVIEW_EXTENSIONS.has(path.extname(absolutePath).toLowerCase())) {
        const format = await sniffPhotoFormat(absolutePath).catch(() => null);
        if (!format) return reply.code(400).send({ error: "That file isn't a photo Lifer can read" });
        const working = await prepareWorkingImage(absolutePath, format);
        try {
          const jpeg = await sharp(working.decodePath, originalSharpOptions())
            .rotate()
            .resize(2048, 2048, { fit: "inside", withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          return reply.send(jpeg);
        } finally {
          await working.release();
        }
      }
      return reply.send(createReadStream(absolutePath));
    },
  );

  app.post<{ Params: { id: string }; Body: { files?: Array<{ relativePath: string; speciesId: string }>; regionId?: string } }>(
    "/trips/:id/import",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
      const userId = request.user!.id;
      const tripId = request.params.id;
      if (importJobs.get(tripId)?.status.running) return reply.code(409).send({ error: "An import is already running for this trip" });

      const tripRes = await pool.query<{ source_folder: string; destination_folder: string }>(
        `SELECT source_folder, destination_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [tripId, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const files = request.body?.files;
      if (!files || files.length === 0) return reply.code(400).send({ error: "files is required" });
      if (!Array.isArray(files) || !files.every((f) => isUuid(f?.speciesId))) return reply.code(400).send({ error: "Unknown species" });
      const regionId = request.body?.regionId ?? null;
      if (regionId !== null && !isUuid(regionId)) return reply.code(400).send({ error: "regionId must be a region id" });

      // Background job, polled via /import/status.
      const job = importJobFor(tripId);
      const { source_folder: sourceFolder, destination_folder: destinationFolder } = tripRes.rows[0];
      const started = job.start((ctx) => runImportJob(ctx, job, tripId, userId, sourceFolder, destinationFolder, files, regionId), {
        tripId,
        results: [],
        phase: "importing",
        processed: 0,
        total: files.length,
      });
      if (!started) return reply.code(409).send({ error: "An import is already running for this trip" });
      return { started: true };
    },
  );

  // One scanned photo's checks for trip review, as /uploads/inspect: region suggestions, an exact
  // keyword match from its tags (put first), and a wildlife check. Writes nothing.
  app.post<{ Params: { id: string }; Body: { relativePath?: string; regionId?: string | null } }>(
    "/trips/:id/inspect",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
      const userId = request.user!.id;
      const tripRes = await pool.query<{ source_folder: string }>(`SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`, [
        request.params.id,
        userId,
      ]);
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const relativePath = request.body?.relativePath;
      if (!relativePath) return reply.code(400).send({ error: "relativePath is required" });
      const absolutePath = resolveWithinTripFolder(tripRes.rows[0].source_folder, relativePath);
      if (!absolutePath) return reply.code(404).send({ error: "File not found" });
      const regionId = request.body?.regionId ?? null;
      if (regionId !== null && !isUuid(regionId)) return reply.code(400).send({ error: "regionId must be a region id" });

      // HEIC can't be decoded by the matching models directly: prepareWorkingImage makes an
      // upright JPEG copy for them (a no-op for other formats).
      const format = await sniffPhotoFormat(absolutePath).catch(() => null);
      if (!format) return reply.code(400).send({ error: "That file isn't a photo Lifer can read" });
      const working = await prepareWorkingImage(absolutePath, format);
      const buffer = await readFile(working.inferencePath).finally(() => working.release());
      const tags = await readExifTags(absolutePath);
      const [exif, keywords] = [await extractExif(absolutePath, tags), await extractKeywords(absolutePath, tags)];

      let suggestions: SpeciesSuggestion[] = regionId
        ? await suggestSpecies(pool, userId, buffer, regionId, 5, exif.takenAt).catch(() => [])
        : [];
      let keywordMatched = false;
      if (keywords.length > 0) {
        const byName = groupByScientificName(await matchSpeciesByKeywords(pool, keywords).catch(() => []));
        if (byName.size === 1) {
          const species = [...byName.values()][0][0];
          keywordMatched = true;
          suggestions = [
            { id: species.id, scientific_name: species.scientific_name, common_name: species.common_name, score: 1, source: "keyword_tag" },
            ...suggestions.filter((s) => s.id !== species.id),
          ];
        }
      }
      const notWildlife = keywordMatched ? null : await checkNotWildlife(buffer, await computeEmbedding(buffer).catch(() => null));
      return { suggestions, notWildlife, takenAt: exif.takenAt };
    },
  );

  app.post<{ Params: { id: string } }>("/trips/:id/import/cancel", { preHandler: requireAuth }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    if (!(await ownsTrip(request.params.id, request.user!.id))) return reply.code(404).send({ error: "Trip not found" });
    return { cancelled: importJobs.get(request.params.id)?.cancel() ?? false };
  });

  app.get<{ Params: { id: string } }>("/trips/:id/import/status", { preHandler: requireScope("trips.read") }, async (request, reply) => {
    if (!isUuid(request.params.id)) return reply.code(404).send({ error: "Trip not found" });
    if (!(await ownsTrip(request.params.id, request.user!.id))) return reply.code(404).send({ error: "Trip not found" });
    return importJobs.get(request.params.id)?.status ?? idleImportStatus(request.params.id);
  });
}
