// "Send keywords to Apple Photos": finds each chosen photo in the Photos library by its original
// file name and capture time, then adds Lifer's species names and tags as keywords. Only adds:
// keywords already there stay, and a photo not in Photos is skipped, never imported.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pool } from "@lifer/core/db.js";
import { createJob, type JobContext } from "../../lib/job.js";
import { readPreservedFileName } from "../../uploads/exif.js";
import {
  ADD_KEYWORDS_SCRIPT,
  ApplePhotosError,
  LOOKUP_SCRIPT,
  parseLookup,
  pickMatch,
  runOsascript,
  scriptErrorNumber,
  type PhotosCandidate,
  type PhotosProblem,
} from "./scripts.js";

export interface SendExtra {
  mode: "check" | "send" | null;
  photos: number;
  found: number;
  notFound: number;
  added: number;
  unchanged: number;
  failed: number;
  /** Why Photos couldn't be used, for a plain message with what to do. */
  problem: PhotosProblem | null;
}

export const SEND_IDLE: SendExtra = {
  mode: null,
  photos: 0,
  found: 0,
  notFound: 0,
  added: 0,
  unchanged: 0,
  failed: 0,
  problem: null,
};

export const applePhotosJob = createJob<null, SendExtra>("apple-photos", SEND_IDLE);

// Photos fails on long runs of events with no pause (error -10000); small batches with a breath.
const LOOKUP_BATCH = 20;
const PAUSE_MS = 150;

export interface Runner {
  run: (script: string, args: string[], signal?: AbortSignal) => Promise<string>;
  pause: (ms: number) => Promise<unknown>;
}
const realRunner: Runner = { run: runOsascript, pause: (ms) => sleep(ms) };

interface PhotoToSend {
  captureId: string;
  takenAt: Date | null;
  names: string[];
  keywords: string[];
}

/** The chosen photos with the file names Photos may know them by and the keywords to add. */
export async function photosToSend(userId: string, captureIds: string[]): Promise<PhotoToSend[]> {
  const res = await pool.query<{ id: string; taken_at: Date | null; refs: string[] | null; keywords: string[] }>(
    `SELECT c.id, c.taken_at,
            (SELECT array_agg(o.ref) FROM originals o WHERE o.capture_id = c.id) AS refs,
            ARRAY(SELECT DISTINCT k FROM unnest(
              ARRAY[s.common_name, s.scientific_name]
              || ARRAY(SELECT unnest(ARRAY[s2.common_name, s2.scientific_name])
                         FROM capture_species cs JOIN species s2 ON s2.id = cs.species_id WHERE cs.capture_id = c.id)
              || COALESCE(c.tags, '{}')) AS k WHERE k IS NOT NULL AND k <> '') AS keywords
       FROM captures c JOIN species s ON s.id = c.species_id
      WHERE c.user_id = $1 AND c.id = ANY($2::uuid[])`,
    [userId, captureIds],
  );
  return Promise.all(
    res.rows.map(async (r) => {
      const refs = r.refs ?? [];
      // The camera's name too: Lifer may have renamed its copy, Photos keeps the imported name.
      const preserved = await Promise.all(refs.map((ref) => readPreservedFileName(ref).catch(() => null)));
      const names = [...new Set([...refs.map((ref) => path.basename(ref)), ...preserved.filter(Boolean)])];
      return { captureId: r.id, takenAt: r.taken_at, names: names as string[], keywords: r.keywords };
    }),
  );
}

async function lookUp(names: string[], runner: Runner, ctx: JobContext<null, SendExtra>): Promise<PhotosCandidate[]> {
  const found: PhotosCandidate[] = [];
  for (let i = 0; i < names.length; i += LOOKUP_BATCH) {
    ctx.throwIfCancelled();
    found.push(...parseLookup(await runner.run(LOOKUP_SCRIPT, names.slice(i, i + LOOKUP_BATCH), ctx.signal)));
    await runner.pause(PAUSE_MS);
  }
  return found;
}

// The last check's matches, so sending right after it doesn't search Photos again.
let lastCheck: { key: string; matches: Map<string, string> } | null = null;
const selectionKey = (userId: string, ids: string[]) => `${userId}:${[...ids].sort().join(",")}`;

/** Checks (mode "check") or sends (mode "send") keywords for these photos. */
export async function runApplePhotos(
  ctx: JobContext<null, SendExtra>,
  userId: string,
  captureIds: string[],
  mode: "check" | "send",
  runner: Runner = realRunner,
): Promise<null> {
  const status = applePhotosJob.status;
  try {
    const photos = await photosToSend(userId, captureIds);
    ctx.update({ phase: "finding", photos: photos.length, total: photos.length, processed: 0 });
    const key = selectionKey(userId, captureIds);
    let matches = mode === "send" && lastCheck?.key === key ? lastCheck.matches : null;
    if (!matches) {
      const candidates = await lookUp([...new Set(photos.flatMap((p) => p.names))], runner, ctx);
      const byName = new Map<string, PhotosCandidate[]>();
      for (const c of candidates) byName.set(c.name.toLowerCase(), [...(byName.get(c.name.toLowerCase()) ?? []), c]);
      matches = new Map();
      for (const p of photos) {
        const id = pickMatch(
          p.names.flatMap((n) => byName.get(n.toLowerCase()) ?? []),
          p.takenAt,
        );
        if (id) matches.set(p.captureId, id);
      }
      lastCheck = { key, matches };
    }
    ctx.update({ found: matches.size, notFound: photos.length - matches.size });
    if (mode === "check") return null;

    ctx.update({ phase: "sending", processed: 0, total: matches.size });
    let processed = 0;
    for (const p of photos) {
      const id = matches.get(p.captureId);
      if (!id) continue;
      ctx.throwIfCancelled();
      try {
        const added = Number(await runner.run(ADD_KEYWORDS_SCRIPT, [id, ...p.keywords], ctx.signal));
        if (added > 0) status.added++;
        else status.unchanged++;
      } catch (err) {
        if (err instanceof ApplePhotosError && err.problem) throw err;
        // -1728: removed from Photos since the check.
        if (err instanceof ApplePhotosError && scriptErrorNumber(err.message) === -1728) status.notFound++;
        else status.failed++;
      }
      ctx.update({ processed: ++processed });
      await runner.pause(PAUSE_MS);
    }
    lastCheck = null;
    return null;
  } catch (err) {
    if (err instanceof ApplePhotosError && err.problem) {
      ctx.update({ problem: err.problem });
      return null;
    }
    throw err;
  }
}
