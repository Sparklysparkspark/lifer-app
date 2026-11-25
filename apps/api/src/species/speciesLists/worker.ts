// The one background worker for every user's lists: lists are fetched one at a time, oldest first
// (a second list waits its turn rather than being refused), then each list species' reference photo
// is downloaded and its vectors computed here, at low priority. Everything it needs to carry on is
// in the database (the list's next page, each species' photo_checked_at), so a crash, a restart or
// a lost connection resumes where it stopped.
import { pool } from "@lifer/core/db.js";
import { log } from "@lifer/core/lib/log.js";
import { downloadAndCacheImage, tryComputeReferenceEmbeddings } from "@lifer/core/species/lazyEnrich.js";
import { invalidateSuggestionCache } from "@lifer/core/species/suggest.js";
import { createJob, JobCancelledError, type JobContext } from "../../lib/job.js";
import {
  fetchSpeciesCountsPage,
  InatUnavailableError,
  PAGES_PER_BATCH,
  PER_PAGE,
  type ListQuery,
  type SpeciesCountsPage,
} from "./inat.js";
import { savePage, type SpeciesListRow } from "./store.js";

/** Between two batches of LIST_SIZE_CAP species of one big list. */
export const BATCH_GAP_MS = 10 * 60_000;
const OFFLINE_RETRY_MS = 5 * 60_000;
const THROTTLED_RETRY_MS = 60 * 60_000;
const PHOTO_BATCH = 20;
/** Between two photo downloads, on top of the shared per-host pacing. */
const PHOTO_GAP_MS = 1_000;
const PHOTO_FAILURES_BEFORE_PAUSE = 5;

export interface WorkerDeps {
  fetchPage(q: ListQuery, page: number, signal: AbortSignal): Promise<SpeciesCountsPage>;
  savePage(listId: string, page: SpeciesCountsPage, nextPage: number, last: boolean): Promise<boolean>;
  setState(listId: string, status: string, lastError: string | null, retryInMs: number | null): Promise<void>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export type ListRunEnd = "done" | "batch" | "stopped" | "offline" | "throttled" | "failed";

/** Reads a list from its saved page until done, the end of a batch, or a failure, saving the cursor
 *  after every page. Never throws for iNaturalist being away: the list waits and is retried. */
export async function runList(
  list: Pick<SpeciesListRow, "id" | "inat_taxon_id" | "inat_place_id" | "native_only" | "next_page">,
  signal: AbortSignal,
  deps: WorkerDeps,
  onPage: (added: number, total: number) => void = () => {},
): Promise<ListRunEnd> {
  const q = { taxonId: list.inat_taxon_id, placeId: list.inat_place_id, nativeOnly: list.native_only };
  let page = list.next_page;
  let seen = (page - 1) * PER_PAGE;
  try {
    for (;;) {
      if (signal.aborted) throw new JobCancelledError();
      const res = await deps.fetchPage(q, page, signal);
      seen += PER_PAGE;
      const last = res.species.length === 0 || seen >= res.total;
      if (!(await deps.savePage(list.id, res, page + 1, last))) return "stopped";
      onPage(Math.min(seen, res.total), res.total);
      if (last) return "done";
      page++;
      // Past the size cap: the next batch starts later, at a low rate.
      if ((page - 1) % PAGES_PER_BATCH === 0) {
        await deps.setState(list.id, "queued", null, BATCH_GAP_MS);
        return "batch";
      }
    }
  } catch (err) {
    if (signal.aborted || err instanceof JobCancelledError) throw err;
    if (err instanceof InatUnavailableError) {
      if (err.code === "offline") {
        await deps.setState(list.id, "offline", "offline", OFFLINE_RETRY_MS);
        return "offline";
      }
      if (err.code === "rate_limited" || err.code === "refused") {
        await deps.setState(list.id, "queued", err.code, THROTTLED_RETRY_MS);
        return "throttled";
      }
    }
    log.warn({ err, listId: list.id }, "Couldn't add a list from iNaturalist");
    await deps.setState(list.id, "failed", "failed", null);
    return "failed";
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new JobCancelledError());
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), reject(new JobCancelledError())), { once: true });
  });
}

async function setState(listId: string, status: string, lastError: string | null, retryInMs: number | null) {
  await pool.query(
    `UPDATE species_lists SET status = $2, last_error = $3,
       next_batch_at = CASE WHEN $4::double precision IS NULL THEN NULL ELSE now() + $4 * interval '1 millisecond' END
     WHERE id = $1 AND status = 'running'`,
    [listId, status, lastError, retryInMs],
  );
}

export const defaultDeps: WorkerDeps = {
  fetchPage: fetchSpeciesCountsPage,
  savePage: (listId, page, nextPage, last) => savePage(listId, page.species, nextPage, page.total, last),
  setState,
  sleep,
};

async function nextReadyList(): Promise<SpeciesListRow | null> {
  // 'running' too: a list that was running when the app quit.
  const res = await pool.query<SpeciesListRow>(
    `SELECT * FROM species_lists
      WHERE status IN ('queued', 'running', 'offline') AND (next_batch_at IS NULL OR next_batch_at <= now())
      ORDER BY created_at LIMIT 1`,
  );
  return res.rows[0] ?? null;
}

// Species from lists that aren't paused, with a licensed photo URL and no local copy yet. A failed
// attempt is tried again a day later.
async function nextPhotoSpecies(limit: number): Promise<{ id: string; reference_photo: string }[]> {
  const res = await pool.query<{ id: string; reference_photo: string }>(
    `SELECT s.id, s.reference_photo FROM species s
      WHERE s.is_other_taxa AND s.reference_photo IS NOT NULL AND s.reference_display_path IS NULL
        AND (s.photo_checked_at IS NULL OR s.photo_checked_at < now() - interval '1 day')
        AND EXISTS (SELECT 1 FROM species_list_members m JOIN species_lists l ON l.id = m.list_id
                     WHERE m.species_id = s.id AND l.status <> 'paused')
      ORDER BY s.photo_checked_at NULLS FIRST, s.id
      LIMIT $1`,
    [limit],
  );
  return res.rows;
}

/** Downloads one main photo into the species image store and computes its vectors. */
async function fetchPhoto(species: { id: string; reference_photo: string }): Promise<boolean> {
  await pool.query(`UPDATE species SET photo_checked_at = now() WHERE id = $1`, [species.id]);
  const cached = await downloadAndCacheImage(species.reference_photo, species.id);
  if (!cached) return false;
  const res = await pool.query(
    `UPDATE species SET reference_display_path = $2, reference_thumb_path = $3
      WHERE id = $1 AND reference_display_path IS NULL`,
    [species.id, cached.displayPath, cached.thumbPath],
  );
  // Vectors for each downloaded model; the embedding backfill catches a model downloaded later.
  if (res.rowCount) await tryComputeReferenceEmbeddings(species.id);
  return true;
}

type Ctx = JobContext<null, { listId: string | null }>;
let photosRetryAt = 0;

async function runQueue(ctx: Ctx, deps: WorkerDeps): Promise<null> {
  for (;;) {
    ctx.throwIfCancelled();
    const list = await nextReadyList();
    if (list) {
      await pool.query(`UPDATE species_lists SET status = 'running' WHERE id = $1`, [list.id]);
      ctx.update({ listId: list.id, phase: "fetching", processed: list.added_count, total: list.size_estimate ?? 0 });
      const end = await runList(list, ctx.signal, deps, (seen, total) => ctx.update({ processed: seen, total }));
      ctx.update({ listId: null });
      // New species and checklist additions: suggestion candidates load again.
      if (end !== "offline" && end !== "throttled" && end !== "failed") invalidateSuggestionCache();
      // iNaturalist is away for everyone; the other lists wait too.
      if (end === "offline" || end === "throttled") return null;
      continue;
    }
    if (Date.now() < photosRetryAt) return null;
    const batch = await nextPhotoSpecies(PHOTO_BATCH);
    if (batch.length === 0) return null;
    ctx.update({ phase: "photos" });
    let failures = 0;
    for (const species of batch) {
      ctx.throwIfCancelled();
      failures = (await fetchPhoto(species).catch(() => false)) ? 0 : failures + 1;
      if (failures >= PHOTO_FAILURES_BEFORE_PAUSE) {
        photosRetryAt = Date.now() + THROTTLED_RETRY_MS;
        return null;
      }
      await deps.sleep(PHOTO_GAP_MS, ctx.signal);
    }
  }
}

export const speciesListJob = createJob<null, { listId: string | null }>("species-lists", { listId: null });
let rerun = false;
let wakeTimer: NodeJS.Timeout | null = null;

/** Starts the worker unless it runs; a call while it runs makes it look again once it ends. */
export function kickSpeciesLists(deps: WorkerDeps = defaultDeps): void {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  if (!speciesListJob.start((ctx) => runQueue(ctx, deps), { phase: "fetching" })) {
    rerun = true;
    return;
  }
  void speciesListJob.settled().then(async () => {
    if (rerun) {
      rerun = false;
      kickSpeciesLists(deps);
      return;
    }
    await scheduleWake(deps).catch((err) => log.warn({ err }, "Couldn't schedule the next list batch"));
  });
}

// Wakes for the next batch or retry that's due, or the photo pass after a pause.
async function scheduleWake(deps: WorkerDeps): Promise<void> {
  const res = await pool.query<{ at: Date | null }>(
    `SELECT min(next_batch_at) AS at FROM species_lists WHERE status IN ('queued', 'running', 'offline')`,
  );
  const times = [res.rows[0]?.at?.getTime(), photosRetryAt > Date.now() ? photosRetryAt : undefined].filter(
    (t): t is number => t != null,
  );
  if (times.length === 0) return;
  const delay = Math.max(1_000, Math.min(...times) - Date.now());
  wakeTimer = setTimeout(() => kickSpeciesLists(deps), delay);
  wakeTimer.unref();
}

/** Stops the worker and its wake-up, for shutdown and tests. */
export async function stopSpeciesLists(): Promise<void> {
  if (wakeTimer) clearTimeout(wakeTimer);
  wakeTimer = null;
  rerun = false;
  speciesListJob.cancel();
  await speciesListJob.settled();
}

/** Stops the list being fetched right now when it's `listId`, so a pause or removal takes effect. */
export async function stopListIfRunning(listId: string): Promise<void> {
  if (speciesListJob.status.running && speciesListJob.status.listId === listId) {
    speciesListJob.cancel();
    await speciesListJob.settled();
  }
}
