import type { FastifyInstance } from "fastify";
import { Type } from "typebox";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pool } from "@lifer/core/db.js";
import { IdParams, Nullable, Uuid, notFoundOnInvalidId, replies, withSchemas } from "../lib/schema.js";
import { requireAuth, requireScope } from "../auth/session.js";
import { scanTrip, resolveWithinTripFolder } from "./scan.js";
import { importInboxFile } from "./import.js";
import { listRawFiles } from "./rawLink.js";
import { extractExif, extractKeywords, readExifTags } from "../uploads/exif.js";
import { computeEmbedding, suggestSpecies, type SpeciesSuggestion } from "@lifer/core/species/embeddings.js";
import { matchSpeciesByKeywords, groupByScientificName } from "../species/matchByKeywords.js";
import { checkNotWildlife } from "../species/wildlifeCheck.js";
import { sniffPhotoFormat } from "@lifer/core/uploads/formats.js";
import { prepareWorkingImage } from "../uploads/workingImage.js";
import { originalSharpOptions } from "@lifer/core/lib/imageLimits.js";
import { canonicalPath, isWithin } from "@lifer/core/lib/pathContainment.js";
import sharp from "sharp";
import { mapWithConcurrency } from "@lifer/core/lib/concurrency.js";
import { createJob, type Job, type JobContext } from "../lib/job.js";
import { CULL_MARKS_OPTIONS, idleJobStatus, type CullMarks, type CullMarksOption, type JobStatus } from "@lifer/shared";

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
  /** Each new photo with the marks a culling app left on it (or its sidecar or RAW twin). */
  newFiles: Array<{ relativePath: string; cull: CullMarks }>;
  /** How many of newFiles a culling app rejected, and how many it picked. */
  cullRejected: number;
  cullPicked: number;
}
// The summary fields are also mirrored top-level, alongside `result`.
type ScanExtra = { tripId: string } & ScanSummary;
function emptyScanSummary(): ScanSummary {
  return { relinked: 0, markedStale: 0, collisions: 0, recovered: 0, rawsLinked: 0, newFiles: [], cullRejected: 0, cullPicked: 0 };
}

// `skipped` when a culling app rejected the photo and the import skips those; `hidden` when it
// was imported hidden.
type ImportFileResult = { relativePath: string; captureId?: string; error?: string; skipped?: "rejected"; hidden?: boolean };
type ImportSummary = { imported: number; failed: number; skipped: number; hidden: number };
interface ImportExtra {
  tripId: string;
  // Grows live as files finish.
  results: ImportFileResult[];
}

type ScanJob = Job<ScanSummary, ScanExtra>;
type ImportJob = Job<ImportSummary, ImportExtra>;
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
    job = createJob<ImportSummary, ImportExtra>(`trip-import:${tripId}`, {
      tripId,
      results: [],
    });
    importJobs.set(tripId, job);
  }
  return job;
}

function idleScanStatus(tripId: string): JobStatus<ScanSummary> & ScanExtra {
  return { ...idleJobStatus<ScanSummary>(), tripId, ...emptyScanSummary() };
}

function idleImportStatus(tripId: string): JobStatus<ImportSummary> & ImportExtra {
  return { ...idleJobStatus<ImportSummary>(), tripId, results: [] };
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
    newFiles: result.newFiles.map((f) => ({ relativePath: f.relativePath, cull: f.cull })),
    cullRejected: result.newFiles.filter((f) => f.cull.verdict === "reject").length,
    cullPicked: result.newFiles.filter((f) => f.cull.verdict === "pick").length,
  };
  ctx.update(summary);
  return summary;
}

async function runImportJob(
  ctx: JobContext<ImportSummary, ImportExtra>,
  job: ImportJob,
  tripId: string,
  userId: string,
  sourceFolder: string,
  destinationFolder: string,
  files: Array<{ relativePath: string; speciesId: string }>,
  regionId: string | null,
  cullOption: CullMarksOption,
): Promise<ImportSummary> {
  let imported = 0;
  let failed = 0;
  let skipped = 0;
  let hidden = 0;
  // Read once for the whole batch: each photo's RAW is looked up in it (importInboxFile).
  // Resolved on both sides: older trips stored the folders as typed, newer ones as realpaths.
  const destination = canonicalPath(destinationFolder);
  const sourceRaws = (await listRawFiles(sourceFolder)).filter(
    (r) => !isWithin(destination, canonicalPath(r.absolutePath)),
  );
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
        const outcome = await importInboxFile(
          tripId,
          userId,
          file.speciesId,
          absolutePath,
          destinationFolder,
          regionId,
          sourceRaws,
          cullOption,
        );
        result =
          "skipped" in outcome
            ? { relativePath: file.relativePath, skipped: outcome.skipped }
            : { relativePath: file.relativePath, captureId: outcome.captureId, ...(outcome.hidden ? { hidden: true } : {}) };
      } catch (err) {
        result = { relativePath: file.relativePath, error: (err as Error).message };
      }
    }
    if (result.error) failed++;
    else if (result.skipped) skipped++;
    else {
      imported++;
      if (result.hidden) hidden++;
    }
    job.status.results.push(result);
    ctx.update({ processed: (job.status.processed ?? 0) + 1 });
    return result;
  });
  ctx.throwIfCancelled();
  return { imported, failed, skipped, hidden };
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
const tripNotFound = notFoundOnInvalidId("Trip not found");
const Started = replies(Type.Object({ started: Type.Boolean() }));
const Cancelled = replies(Type.Object({ cancelled: Type.Boolean() }));

export async function tripJobRoutes(fastify: FastifyInstance): Promise<void> {
  const app = withSchemas(fastify);

  app.post(
    "/trips/:id/scan",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, response: Started },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripId = request.params.id;
      if (scanJobs.get(tripId)?.status.running)
        return reply.code(409).send({ error: "A scan is already running for this trip" });

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
    },
  );

  app.post(
    "/trips/:id/scan/cancel",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, response: Cancelled },
    },
    async (request, reply) => {
      if (!(await ownsTrip(request.params.id, request.user!.id)))
        return reply.code(404).send({ error: "Trip not found" });
      return { cancelled: scanJobs.get(request.params.id)?.cancel() ?? false };
    },
  );

  app.get(
    "/trips/:id/scan/status",
    { preValidation: requireScope("trips.read"), config: tripNotFound, schema: { params: IdParams } },
    async (request, reply) => {
      if (!(await ownsTrip(request.params.id, request.user!.id)))
        return reply.code(404).send({ error: "Trip not found" });
      return scanJobs.get(request.params.id)?.status ?? idleScanStatus(request.params.id);
    },
  );

  app.get(
    "/trips/:id/scan-preview",
    {
      preValidation: requireScope("trips.read"),
      config: tripNotFound,
      schema: {
        params: IdParams,
        // Resolved inside the trip's source folder by resolveWithinTripFolder.
        querystring: Type.Object({ file: Type.String({ description: "Path of the file inside the trip folder" }) }),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripRes = await pool.query<{ source_folder: string }>(
        `SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const relativePath = request.query.file;
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

  app.post(
    "/trips/:id/import",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          {
            files: Type.Array(
              Type.Object(
                { relativePath: Type.String({ minLength: 1 }), speciesId: Uuid() },
                { additionalProperties: false },
              ),
              { minItems: 1 },
            ),
            regionId: Type.Optional(Nullable(Uuid())),
            cullMarks: Type.Optional(
              Type.Enum([...CULL_MARKS_OPTIONS], {
                description:
                  "Photos a culling app rejected: skip (the default) leaves them out, hide imports them hidden, ignore imports them as usual",
              }),
            ),
          },
          { additionalProperties: false },
        ),
        response: Started,
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripId = request.params.id;
      if (importJobs.get(tripId)?.status.running)
        return reply.code(409).send({ error: "An import is already running for this trip" });

      const tripRes = await pool.query<{ source_folder: string; destination_folder: string }>(
        `SELECT source_folder, destination_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [tripId, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const { files } = request.body;
      const regionId = request.body.regionId ?? null;
      const cullOption = request.body.cullMarks ?? "skip";

      // Background job, polled via /import/status.
      const job = importJobFor(tripId);
      const { source_folder: sourceFolder, destination_folder: destinationFolder } = tripRes.rows[0];
      const started = job.start(
        (ctx) => runImportJob(ctx, job, tripId, userId, sourceFolder, destinationFolder, files, regionId, cullOption),
        {
          tripId,
          results: [],
          phase: "importing",
          processed: 0,
          total: files.length,
        },
      );
      if (!started) return reply.code(409).send({ error: "An import is already running for this trip" });
      return { started: true };
    },
  );

  // One scanned photo's checks for trip review, as /uploads/inspect: region suggestions, an exact
  // keyword match from its tags (put first), and a wildlife check. Writes nothing.
  app.post(
    "/trips/:id/inspect",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: {
        params: IdParams,
        body: Type.Object(
          { relativePath: Type.String({ minLength: 1 }), regionId: Type.Optional(Nullable(Uuid())) },
          { additionalProperties: false },
        ),
      },
    },
    async (request, reply) => {
      const userId = request.user!.id;
      const tripRes = await pool.query<{ source_folder: string }>(
        `SELECT source_folder FROM trips WHERE id = $1 AND user_id = $2`,
        [request.params.id, userId],
      );
      if (tripRes.rows.length === 0) return reply.code(404).send({ error: "Trip not found" });
      const { relativePath } = request.body;
      const absolutePath = resolveWithinTripFolder(tripRes.rows[0].source_folder, relativePath);
      if (!absolutePath) return reply.code(404).send({ error: "File not found" });
      const regionId = request.body.regionId ?? null;

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
            {
              id: species.id,
              scientific_name: species.scientific_name,
              common_name: species.common_name,
              score: 1,
              source: "keyword_tag",
            },
            ...suggestions.filter((s) => s.id !== species.id),
          ];
        }
      }
      const notWildlife = keywordMatched
        ? null
        : await checkNotWildlife(buffer, await computeEmbedding(buffer).catch(() => null));
      return { suggestions, notWildlife, takenAt: exif.takenAt };
    },
  );

  app.post(
    "/trips/:id/import/cancel",
    {
      preValidation: requireAuth,
      config: tripNotFound,
      schema: { params: IdParams, response: Cancelled },
    },
    async (request, reply) => {
      if (!(await ownsTrip(request.params.id, request.user!.id)))
        return reply.code(404).send({ error: "Trip not found" });
      return { cancelled: importJobs.get(request.params.id)?.cancel() ?? false };
    },
  );

  app.get(
    "/trips/:id/import/status",
    { preValidation: requireScope("trips.read"), config: tripNotFound, schema: { params: IdParams } },
    async (request, reply) => {
      if (!(await ownsTrip(request.params.id, request.user!.id)))
        return reply.code(404).send({ error: "Trip not found" });
      return importJobs.get(request.params.id)?.status ?? idleImportStatus(request.params.id);
    },
  );
}
