// Walking the whole ORIGINALS_DIR tree reads every managed file's EXIF (a real exiftool
// round-trip each) and regenerates derivatives for every recovered JPEG — for a library of
// any real size this easily takes minutes, so it's a background job polled from the client,
// same in-memory single-job pattern as Trips' scan/import jobs (trips/routes.ts) and
// settings/routes.ts's migrate-to-server job. Global, not per-trip: there's only ever one
// library to reimport, gated to desktop mode for the same reason as every other route here
// that walks the server's own filesystem (settings/routes.ts's own comment).
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/session.js";
import { requireDesktopMode } from "../settings/routes.js";
import { ORIGINALS_DIR } from "../config.js";
import { mapWithConcurrency } from "data-pipeline/src/concurrency.js";
import { listManagedFiles, recoverJpeg, recoverRaw, findMissingReferenceData } from "./reimport.js";

// Same concurrency Trips' import job uses (trips/routes.ts) — each file pays a real exiftool
// round-trip plus (for a recovered JPEG) a sharp resize, so running this sequentially over a
// library of any real size would take far longer than the per-file I/O latency alone implies.
const CONCURRENCY = 4;

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
  jpegsUnrecognized: string[];
  jpegsAmbiguous: Array<{ file: string; scientificNames: string[] }>;
  rawsRecovered: number;
  rawsAlreadyKnown: number;
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
    jpegsUnrecognized: [],
    jpegsAmbiguous: [],
    rawsRecovered: 0,
    rawsAlreadyKnown: 0,
    rawsUnmatched: 0,
    missingReferenceData: [],
  };
}

let job: ReimportJobState = freshJobState();

async function runReimportJob(userId: string): Promise<void> {
  try {
    const { jpegs, raws } = listManagedFiles(ORIGINALS_DIR);
    job.totalJpegs = jpegs.length;
    job.totalRaws = raws.length;

    const recoveredScientificNames = new Set<string>();

    // JPEGs first, in full — RAW recovery below matches against JPEG captures already
    // committed to the database, so it needs this pass finished, not interleaved with it.
    await mapWithConcurrency(jpegs, CONCURRENCY, async (absolutePath) => {
      const relativePath = path.relative(ORIGINALS_DIR, absolutePath);
      try {
        const outcome = await recoverJpeg(userId, absolutePath);
        if (outcome.status === "recovered") {
          job.jpegsRecovered++;
          recoveredScientificNames.add(outcome.scientificName);
        } else if (outcome.status === "already-known") {
          job.jpegsAlreadyKnown++;
        } else if (outcome.status === "unrecognized") {
          job.jpegsUnrecognized.push(relativePath);
        } else {
          job.jpegsAmbiguous.push({ file: relativePath, scientificNames: outcome.scientificNames });
        }
      } catch (err) {
        job.jpegsUnrecognized.push(`${relativePath} (error: ${(err as Error).message})`);
      } finally {
        job.processedJpegs++;
      }
    });

    await mapWithConcurrency(raws, CONCURRENCY, async (absolutePath) => {
      try {
        const outcome = await recoverRaw(userId, absolutePath);
        if (outcome.status === "recovered") job.rawsRecovered++;
        else if (outcome.status === "already-known") job.rawsAlreadyKnown++;
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
  app.post("/library/reimport", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    if (job.running) return reply.code(409).send({ error: "A reimport is already running" });
    const userId = request.user!.id;
    job = freshJobState();
    job.running = true;

    // Not awaited — same reasoning as Trips' own scan/import jobs: this can take a real
    // amount of time, and the client polls status instead of holding one giant request open.
    void runReimportJob(userId);

    return { started: true };
  });

  app.get("/library/reimport/status", { preHandler: requireAuth }, async (request, reply) => {
    if (!requireDesktopMode(reply)) return;
    return job;
  });
}
