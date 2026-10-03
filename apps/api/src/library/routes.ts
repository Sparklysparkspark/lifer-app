// Library reimport. Reading every file's EXIF and rebuilding derivatives takes minutes, so it's a
// single background job the client polls.
import { idleJobStatus } from "@lifer/shared";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply } from "fastify";
import sharp from "sharp";
import { originalSharpOptions } from "../lib/imageLimits.js";
import { claimedPhotoFormat, sniffPhotoFormat } from "../uploads/formats.js";
import { prepareWorkingImage, type WorkingImage } from "../uploads/workingImage.js";
import { requireAuth } from "../auth/session.js";
import { assertAllowedPath } from "../lib/allowedPaths.js";
import { isUuid } from "../lib/validate.js";
import { ORIGINALS_DIR } from "../config.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import {
  listManagedFiles,
  recoverJpeg,
  recoverRaw,
  findMissingReferenceData,
  ignoreLibraryFile,
  type VolumeContext,
} from "./reimport.js";
import { resolveChosenVolumeDestination } from "../storageVolumes/resolve.js";
import { friendlyFsErrorMessage } from "../lib/friendlyFsError.js";
import { libraryFolderStatus } from "../lib/libraryFolder.js";
import { restoreCollectionState } from "../lib/collectionState.js";
import { createJob, type JobContext } from "../lib/job.js";
import { log } from "../lib/log.js";
import { getUserFileSettings } from "../lib/userFileSettings.js";

// Each file costs an exiftool round-trip and often a resize, so files run in parallel.
const CONCURRENCY = 4;

interface UnmatchedFile {
  relativePath: string;
  contentHash: string | null;
  /** Set only when several species matched; null means no species tag was found. */
  scientificNames: string[] | null;
}

// Live counters, top-level on the status next to the shared JobStatus fields. Phases are
// "jpegs" then "raws"; processed/total track the current phase.
interface ReimportExtra {
  processedJpegs: number;
  totalJpegs: number;
  processedRaws: number;
  totalRaws: number;
  jpegsRecovered: number;
  jpegsAlreadyKnown: number;
  jpegsRelinked: number;
  jpegsIgnored: number;
  // Unrecognized and ambiguous files form one review list; both can be ignored so they stop
  // resurfacing.
  unmatched: UnmatchedFile[];
  rawsRecovered: number;
  rawsAlreadyKnown: number;
  rawsRelinked: number;
  rawsUnmatched: number;
}

// Distinct scientific names this run recovered that have no reference photo/description in
// the current catalog, the direct input to the pack-recommendation feature.
interface ReimportResult {
  missingReferenceData: string[];
}

function freshExtra(): ReimportExtra {
  return {
    processedJpegs: 0,
    totalJpegs: 0,
    processedRaws: 0,
    totalRaws: 0,
    jpegsRecovered: 0,
    jpegsAlreadyKnown: 0,
    jpegsRelinked: 0,
    jpegsIgnored: 0,
    unmatched: [],
    rawsRecovered: 0,
    rawsAlreadyKnown: 0,
    rawsRelinked: 0,
    rawsUnmatched: 0,
  };
}

const reimportJob = createJob<ReimportResult, ReimportExtra>("library-reimport", freshExtra());
// Root the current job's relative paths resolve against. Server-side only, for previews.
let jobWalkDir: string | null = null;
// Whose scan the shared job belongs to. A server can have several accounts; only the one that
// started it may see its unmatched files (and their previews), cancel it, or ignore from it.
let jobUserId: string | null = null;

function isJobOwner(userId: string): boolean {
  return jobUserId == null || jobUserId === userId;
}

// Cancel is checked between files: in-flight files finish, no new one starts.
async function runReimportJob(
  ctx: JobContext<ReimportResult, ReimportExtra>,
  userId: string,
  walkDir: string,
  volumeContext: VolumeContext | null,
  organize: boolean,
  organizeByYear: boolean,
  foreign: boolean,
): Promise<ReimportResult> {
  const job = reimportJob.status;
  try {
    const { jpegs, raws } = await listManagedFiles(walkDir);
    ctx.update({ totalJpegs: jpegs.length, totalRaws: raws.length, phase: "jpegs", processed: 0, total: jpegs.length });

    const recoveredScientificNames = new Set<string>();

    // JPEGs first, in full: RAW recovery matches against already committed JPEG captures.
    await mapWithConcurrency(jpegs, CONCURRENCY, async (absolutePath) => {
      if (ctx.signal.aborted) return;
      const relativePath = path.relative(walkDir, absolutePath);
      ctx.update({ currentItem: relativePath });
      try {
        const outcome = await recoverJpeg(userId, absolutePath, volumeContext, organize, organizeByYear, foreign);
        if (outcome.status === "recovered") {
          job.jpegsRecovered++;
          recoveredScientificNames.add(outcome.scientificName);
        } else if (outcome.status === "already-known") {
          job.jpegsAlreadyKnown++;
        } else if (outcome.status === "relinked") {
          job.jpegsRelinked++;
        } else if (outcome.status === "ignored") {
          job.jpegsIgnored++;
        } else if (outcome.status === "unrecognized") {
          job.unmatched.push({ relativePath, contentHash: outcome.contentHash, scientificNames: null });
        } else {
          job.unmatched.push({ relativePath, contentHash: outcome.contentHash, scientificNames: outcome.scientificNames });
        }
      } catch (err) {
        job.unmatched.push({
          relativePath: `${relativePath} (error: ${(err as Error).message})`,
          contentHash: null,
          scientificNames: null,
        });
      } finally {
        job.processedJpegs++;
        ctx.update({ processed: job.processedJpegs });
      }
    });
    ctx.throwIfCancelled();

    ctx.update({ phase: "raws", processed: 0, total: raws.length });
    await mapWithConcurrency(raws, CONCURRENCY, async (absolutePath) => {
      if (ctx.signal.aborted) return;
      ctx.update({ currentItem: path.relative(walkDir, absolutePath) });
      try {
        const outcome = await recoverRaw(userId, absolutePath, volumeContext, organize, organizeByYear, foreign);
        if (outcome.status === "recovered") job.rawsRecovered++;
        else if (outcome.status === "already-known") job.rawsAlreadyKnown++;
        else if (outcome.status === "relinked") job.rawsRelinked++;
        else job.rawsUnmatched++;
      } catch {
        job.rawsUnmatched++;
      } finally {
        job.processedRaws++;
        ctx.update({ processed: job.processedRaws });
      }
    });
    ctx.throwIfCancelled();

    // Pointing a fresh install at an old library: also bring back archived, hidden, seen and
    // target species from the library's own record (only if this install has none of its own).
    await restoreCollectionState(userId).catch((err) => log.warn(`[collection-state] couldn't restore: ${(err as Error).message}`));
    return { missingReferenceData: await findMissingReferenceData([...recoveredScientificNames]) };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(friendlyFsErrorMessage(err));
  }
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // Polled by the app's banner: is the photo library folder still there?
  app.get("/library/folder-status", { preHandler: requireAuth }, async () => libraryFolderStatus());

  app.post<{ Body: { volumeId?: string; path?: string; organize?: boolean } }>(
    "/library/reimport",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (reimportJob.status.running) return reply.code(409).send({ error: "A reimport is already running" });
      const userId = request.user!.id;

      // volumeId walks that drive's "Lifer Originals" folder (as a store-mode upload would use) and
      // repairs known files whose ref or volume drifted.
      // `path` is a folder from another app's layout; `organize` (only with it) moves matched files into
      // Lifer's species folders.
      let walkDir = ORIGINALS_DIR;
      let volumeContext: VolumeContext | null = null;
      if (request.body?.path) {
        if (!path.isAbsolute(request.body.path)) return reply.code(400).send({ error: "path must be an absolute folder path" });
        const candidate = assertAllowedPath(request.body.path);
        if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
          return reply.code(400).send({ error: "That folder doesn't exist" });
        }
        walkDir = candidate;
      } else if (request.body?.volumeId) {
        const resolved = isUuid(request.body.volumeId) ? await resolveChosenVolumeDestination(userId, request.body.volumeId) : null;
        if (!resolved) return reply.code(400).send({ error: "That drive isn't connected right now" });
        walkDir = resolved.baseDir;
        volumeContext = resolved;
      }

      const organize = Boolean(request.body?.organize);
      let organizeByYear = false;
      if (organize) {
        ({ organizeByYear } = await getUserFileSettings(userId));
      }

      // Background job, polled via /status.
      const started = reimportJob.start(
        (ctx) => runReimportJob(ctx, userId, walkDir, volumeContext, organize, organizeByYear, Boolean(request.body?.path)),
        freshExtra(),
      );
      if (!started) return reply.code(409).send({ error: "A reimport is already running" });
      jobWalkDir = walkDir;
      jobUserId = userId;

      return { started: true };
    },
  );

  app.get("/library/reimport/status", { preHandler: requireAuth }, async (request) => {
    if (isJobOwner(request.user!.id)) return reimportJob.status;
    // Someone else's scan: report only that one is running, none of its results.
    return { ...idleJobStatus<ReimportResult>(), ...freshExtra(), running: reimportJob.status.running };
  });

  // Stops between files; in-flight files finish and queued ones are left untouched.
  app.post("/library/reimport/cancel", { preHandler: requireAuth }, async (request, reply) => {
    if (!isJobOwner(request.user!.id)) return reply.code(409).send({ error: "No reimport is running" });
    if (!reimportJob.cancel()) return reply.code(409).send({ error: "No reimport is running" });
    return { ok: true };
  });

  // Marks an unmatched file so it stops resurfacing, and drops it from the current job's list.
  app.post<{ Body: { contentHash?: string } }>("/library/ignore", { preHandler: requireAuth }, async (request, reply) => {
    const contentHash = request.body?.contentHash;
    if (!contentHash) return reply.code(400).send({ error: "contentHash is required" });
    await ignoreLibraryFile(request.user!.id, contentHash);
    if (isJobOwner(request.user!.id)) {
      reimportJob.status.unmatched = reimportJob.status.unmatched.filter((f) => f.contentHash !== contentHash);
    }
    return { ok: true };
  });

  // A small thumbnail of one unmatched file for the review UI. The file is picked from the last
  // scan's own list (by position or content hash), never from a client-supplied path.
  async function sendUnmatchedPreview(entry: { relativePath: string } | undefined, reply: FastifyReply) {
    if (!entry || !jobWalkDir) return reply.code(404).send({ error: "Not found" });
    const absolutePath = path.join(jobWalkDir, entry.relativePath);
    if (!existsSync(absolutePath)) return reply.code(404).send({ error: "Not found" });
    let working: WorkingImage | null = null;
    try {
      // A HEIC is read through its working JPEG, since sharp can't decode it.
      const format = (await sniffPhotoFormat(absolutePath)) ?? claimedPhotoFormat(null, absolutePath);
      if (format === "heic") working = await prepareWorkingImage(absolutePath, format);
      const source = working?.decodePath ?? absolutePath;
      const buffer = await sharp(source, originalSharpOptions()).rotate().resize({ width: 300, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
      reply.header("Content-Type", "image/webp");
      return reply.send(buffer);
    } catch {
      return reply.code(404).send({ error: "Couldn't read this file" });
    } finally {
      await working?.release();
    }
  }

  app.get<{ Params: { index: string } }>(
    "/library/reimport/unmatched-preview/:index",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id)) return reply.code(404).send({ error: "Not found" });
      const index = Number(request.params.index);
      return sendUnmatchedPreview(Number.isInteger(index) ? reimportJob.status.unmatched[index] : undefined, reply);
    },
  );

  // Keyed by content hash, so a preview stays right when the list changes (a file ignored or
  // assigned shifts every index after it).
  app.get<{ Params: { hash: string } }>(
    "/library/reimport/unmatched-preview-by-hash/:hash",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id)) return reply.code(404).send({ error: "Not found" });
      return sendUnmatchedPreview(reimportJob.status.unmatched.find((f) => f.contentHash === request.params.hash), reply);
    },
  );
}
