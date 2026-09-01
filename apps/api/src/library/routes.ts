// Walking the whole ORIGINALS_DIR tree reads every managed file's EXIF (a real exiftool
// round-trip each) and regenerates derivatives for every recovered JPEG — for a library of
// any real size this easily takes minutes, so it's a background job polled from the client,
// same in-memory single-job pattern as Trips' scan/import jobs (trips/routes.ts) and
// settings/routes.ts's migrate-to-server job. Global, not per-trip: there's only ever one
// library to reimport, gated to desktop mode for the same reason as every other route here
// that walks the server's own filesystem (settings/routes.ts's own comment).
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import { requireAuth } from "../auth/session.js";
import { requireDesktopMode } from "../settings/routes.js";
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

interface ReimportJobState {
  running: boolean;
  processedJpegs: number;
  totalJpegs: number;
  processedRaws: number;
  totalRaws: number;
  error: string | null;
  finishedAt: number | null;
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
  // Distinct scientific names this run recovered that have no reference photo/description in
  // the current catalog — the direct input to the pack-recommendation feature.
  missingReferenceData: string[];
}

function freshJobState(): ReimportJobState {
  return {
    running: false,
    processedJpegs: 0,
    totalJpegs: 0,
    processedRaws: 0,
    totalRaws: 0,
    error: null,
    finishedAt: null,
    jpegsRecovered: 0,
    jpegsAlreadyKnown: 0,
    jpegsRelinked: 0,
    jpegsIgnored: 0,
    unmatched: [],
    rawsRecovered: 0,
    rawsAlreadyKnown: 0,
    rawsRelinked: 0,
    rawsUnmatched: 0,
    missingReferenceData: [],
  };
}

let job: ReimportJobState = freshJobState();
// The folder the currently-displayed job's results are relative to — kept alongside (not
// inside) the polled job state since the client never needs to see it, only used server-side
// to resolve an unmatched entry's relativePath back to a real file for the preview endpoint.
let jobWalkDir: string | null = null;

async function runReimportJob(
  userId: string,
  walkDir: string,
  volumeContext: VolumeContext | null,
  organize: boolean,
  organizeByYear: boolean,
): Promise<void> {
  try {
    const { jpegs, raws } = listManagedFiles(walkDir);
    job.totalJpegs = jpegs.length;
    job.totalRaws = raws.length;

    const recoveredScientificNames = new Set<string>();

    // JPEGs first, in full — RAW recovery below matches against JPEG captures already
    // committed to the database, so it needs this pass finished, not interleaved with it.
    await mapWithConcurrency(jpegs, CONCURRENCY, async (absolutePath) => {
      const relativePath = path.relative(walkDir, absolutePath);
      try {
        const outcome = await recoverJpeg(userId, absolutePath, volumeContext, organize, organizeByYear);
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
      }
    });

    await mapWithConcurrency(raws, CONCURRENCY, async (absolutePath) => {
      try {
        const outcome = await recoverRaw(userId, absolutePath, volumeContext, organize, organizeByYear);
        if (outcome.status === "recovered") job.rawsRecovered++;
        else if (outcome.status === "already-known") job.rawsAlreadyKnown++;
        else if (outcome.status === "relinked") job.rawsRelinked++;
        else job.rawsUnmatched++;
      } catch {
        job.rawsUnmatched++;
      } finally {
        job.processedRaws++;
      }
    });

    job.missingReferenceData = await findMissingReferenceData([...recoveredScientificNames]);
  } catch (err) {
    job.error = (err as Error).message;
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
  }
}

export async function libraryRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { volumeId?: string; path?: string; organize?: boolean } }>(
    "/library/reimport",
    { preHandler: requireAuth },
    async (request, reply) => {
      if (!requireDesktopMode(reply)) return;
      if (job.running) return reply.code(409).send({ error: "A reimport is already running" });
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
        const candidate = path.resolve(request.body.path);
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

      job = freshJobState();
      job.running = true;
      jobWalkDir = walkDir;

      // Not awaited — same reasoning as Trips' own scan/import jobs: this can take a real
      // amount of time, and the client polls status instead of holding one giant request open.
      void runReimportJob(userId, walkDir, volumeContext, organize, organizeByYear);

      return { started: true };
    },
  );

  app.get("/library/reimport/status", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return job;
  });

  // Marks one unmatched file so it stops resurfacing on future scans (migration 063) — e.g. a
  // folder of insect photos this app doesn't track. Also strips it from the CURRENT job's
  // in-memory unmatched list so the review UI updates immediately, without needing a rescan.
  app.post<{ Body: { contentHash?: string } }>("/library/ignore", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    const contentHash = request.body?.contentHash;
    if (!contentHash) return reply.code(400).send({ error: "contentHash is required" });
    await ignoreLibraryFile(request.user!.id, contentHash);
    job.unmatched = job.unmatched.filter((f) => f.contentHash !== contentHash);
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
      if (!requireDesktopMode(reply)) return;
      const index = Number(request.params.index);
      const entry = Number.isInteger(index) ? job.unmatched[index] : undefined;
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
