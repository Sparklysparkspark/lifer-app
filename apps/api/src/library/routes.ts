// Walking the whole ORIGINALS_DIR tree reads every managed file's EXIF (a real exiftool
// round-trip each) and regenerates derivatives for every recovered JPEG — for a library of
// any real size this easily takes minutes, so it's a background job polled from the client,
// same in-memory single-job pattern as Trips' scan/import jobs (trips/routes.ts) and
// settings/routes.ts's migrate-to-server job. Global, not per-trip: there's only ever one
// library to reimport, gated to desktop mode for the same reason as every other route here
// that walks the server's own filesystem (settings/routes.ts's own comment).
import { idleJobStatus } from "@lifer/shared";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { requireAuth } from "../auth/session.js";
import { assertAllowedPath } from "../lib/allowedPaths.js";
import { ORIGINALS_DIR } from "../config.js";
import { pool } from "../db.js";
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

// Same concurrency Trips' import job uses (trips/routes.ts) — each file pays a real exiftool
// round-trip plus (for a recovered JPEG) a sharp resize, so running this sequentially over a
// library of any real size would take far longer than the per-file I/O latency alone implies.
const CONCURRENCY = 4;

interface UnmatchedFile {
  relativePath: string;
  contentHash: string | null;
  /** Set only for the "matched more than one species" case — null means no species tag was
   *  found on the file at all (e.g. a folder of insect photos this app doesn't track). */
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
  // Unrecognized (no species tag matched) and ambiguous (matched more than one) merged into
  // one reviewable list — from the user's perspective both are just "not in my library yet,"
  // and both are equally worth an Ignore action so a folder of e.g. insect photos stops
  // resurfacing on every future scan.
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
// The folder the currently-displayed job's results are relative to — kept alongside (not
// inside) the polled job state since the client never needs to see it, only used server-side
// to resolve an unmatched entry's relativePath back to a real file for the preview endpoint.
let jobWalkDir: string | null = null;
// Whose scan the shared job belongs to. A server can have several accounts; only the one that
// started it may see its unmatched files (and their previews), cancel it, or ignore from it.
let jobUserId: string | null = null;

function isJobOwner(userId: string): boolean {
  return jobUserId == null || jobUserId === userId;
}

// Cancel is checked between files rather than aborting in-flight work, a file already
// mid-exiftool-call or mid-hash-stream finishes normally, but no NEW file starts.
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
    const { jpegs, raws } = listManagedFiles(walkDir);
    ctx.update({ totalJpegs: jpegs.length, totalRaws: raws.length, phase: "jpegs", processed: 0, total: jpegs.length });

    const recoveredScientificNames = new Set<string>();

    // JPEGs first, in full — RAW recovery below matches against JPEG captures already
    // committed to the database, so it needs this pass finished, not interleaved with it.
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
    await restoreCollectionState(userId).catch((err) => console.warn("[collection-state] couldn't restore:", (err as Error).message));
    return { missingReferenceData: await findMissingReferenceData([...recoveredScientificNames]) };
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    throw new Error(friendlyFsErrorMessage(err));
  }
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  // Polled by the app's banner: is the photo library folder still there? A folder moved or
  // deleted while Lifer runs makes every save fail until it's back (see lib/libraryFolder.ts).
  app.get("/library/folder-status", { preHandler: requireAuth }, async () => libraryFolderStatus());

  app.post<{ Body: { volumeId?: string; path?: string; organize?: boolean } }>(
    "/library/reimport",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (reimportJob.status.running) return reply.code(409).send({ error: "A reimport is already running" });
      const userId = request.user!.id;

      // Pointing this at a registered external drive instead of the primary library walks that
      // drive's own "Lifer Originals" folder (same base a store-mode upload would have used —
      // see storageVolumes/resolve.ts's resolveChosenVolumeDestination) and repairs any already-
      // known file whose ref/volume_id has drifted (drive removed-then-re-registered under a
      // different mount name, moved between drives by hand, etc.) instead of just skipping it.
      //
      // `path` is the third, different option: an arbitrary folder outside Lifer's own tree
      // entirely — a library organized by a different app/convention (see the Settings "Import
      // a library organized differently" section). `organize` only makes sense alongside it:
      // matched files get physically relocated into Lifer's own species-folder layout, since a
      // foreign folder's files were never "already exactly where a normal upload would have put
      // them" the way volumeId/default-library files are.
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
        const resolved = await resolveChosenVolumeDestination(userId, request.body.volumeId);
        if (!resolved) return reply.code(400).send({ error: "That drive isn't connected right now" });
        walkDir = resolved.baseDir;
        volumeContext = resolved;
      }

      const organize = Boolean(request.body?.organize);
      let organizeByYear = false;
      if (organize) {
        const userRes = await pool.query<{ organize_originals_by_year: boolean }>(
          `SELECT organize_originals_by_year FROM users WHERE id = $1`,
          [userId],
        );
        organizeByYear = userRes.rows[0]?.organize_originals_by_year ?? false;
      }

      // Background job, polled via /status: this can take a real amount of time.
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

  // Stops the run between files rather than mid-file — whatever's already in flight (up to
  // CONCURRENCY files) finishes normally, everything queued behind it is left completely
  // untouched on disk, same as it would be if the scan simply hadn't reached it yet.
  app.post("/library/reimport/cancel", { preHandler: requireAuth }, async (request, reply) => {
    if (!isJobOwner(request.user!.id)) return reply.code(409).send({ error: "No reimport is running" });
    if (!reimportJob.cancel()) return reply.code(409).send({ error: "No reimport is running" });
    return { ok: true };
  });

  // Marks one unmatched file so it stops resurfacing on future scans (migration 063) — e.g. a
  // folder of insect photos this app doesn't track. Also strips it from the CURRENT job's
  // in-memory unmatched list so the review UI updates immediately, without needing a rescan.
  app.post<{ Body: { contentHash?: string } }>("/library/ignore", { preHandler: requireAuth }, async (request, reply) => {
    const contentHash = request.body?.contentHash;
    if (!contentHash) return reply.code(400).send({ error: "contentHash is required" });
    await ignoreLibraryFile(request.user!.id, contentHash);
    if (isJobOwner(request.user!.id)) {
      reimportJob.status.unmatched = reimportJob.status.unmatched.filter((f) => f.contentHash !== contentHash);
    }
    return { ok: true };
  });

  // A lightweight on-the-fly thumbnail for one unmatched file, so the review UI can show what
  // it actually is instead of just a filename — index-only (never a client-supplied path) so
  // this can only ever serve a file THIS server's own last scan already walked and reported,
  // never an arbitrary path off the filesystem.
  app.get<{ Params: { index: string } }>(
    "/library/reimport/unmatched-preview/:index",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!isJobOwner(request.user!.id)) return reply.code(404).send({ error: "Not found" });
      const index = Number(request.params.index);
      const entry = Number.isInteger(index) ? reimportJob.status.unmatched[index] : undefined;
      if (!entry || !jobWalkDir) return reply.code(404).send({ error: "Not found" });
      const absolutePath = path.join(jobWalkDir, entry.relativePath);
      if (!existsSync(absolutePath)) return reply.code(404).send({ error: "Not found" });
      try {
        const buffer = await sharp(absolutePath).rotate().resize({ width: 300, withoutEnlargement: true }).webp({ quality: 75 }).toBuffer();
        reply.header("Content-Type", "image/webp");
        return reply.send(buffer);
      } catch {
        return reply.code(404).send({ error: "Couldn't read this file" });
      }
    },
  );
}
