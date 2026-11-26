// Shared lifecycle for background jobs (the polled status shape is packages/shared/src/job.ts):
// - start() claims the job synchronously, so two requests can't both start it.
// - One AbortController per run, aborted by cancel() and passed to fetch and streams.
// - running/finishedAt/cancelRequested are reset in a finally, so an error can't leave it running.
import { idleJobStatus, type JobStatus } from "@lifer/shared";
import { log } from "@lifer/core/lib/log.js";
import { friendlyFsErrorMessage } from "./friendlyFsError.js";

export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelledError";
  }
}

export const UNEXPECTED_ERROR = "Something went wrong. Try again, and restart Lifer if it keeps happening.";
// Text a person can't act on: database, OS and stack wording (ux-rules S1).
const RAW_ERROR =
  /\bE(NOENT|ACCES|PERM|NOSPC|ISDIR|NOTDIR|BUSY|MFILE|PIPE|CONN[A-Z]+|TIMEDOUT|ADDRINUSE)\b|errno|deadlock|constraint|violates|relation "|column "|syntax error|duplicate key|\bSQL|\bat \S+:\d+|\/(srv|usr|var|tmp|home|Users)\//i;

/** The one sentence a job's status or an error reply shows for `err`. Raw database, OS and stack
 *  text never reaches it; callers log `err` itself for the detail. */
export function describeError(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EPERM" || code === "EACCES" || code === "ENOENT") return friendlyFsErrorMessage(err);
  // node-postgres errors carry a severity and a five-character SQLSTATE.
  if ((err as { severity?: unknown })?.severity !== undefined) return UNEXPECTED_ERROR;
  const message = (err instanceof Error ? err.message : typeof err === "string" ? err : "").trim();
  return message && !RAW_ERROR.test(message) ? message : UNEXPECTED_ERROR;
}

export interface JobContext<TResult, TExtra extends object = object> {
  signal: AbortSignal;
  // Merge progress fields (including job-specific extras) into the public status.
  update(patch: Partial<JobStatus<TResult> & TExtra>): void;
  // Throws JobCancelledError if cancel() was called. Call between steps that can't take a signal.
  throwIfCancelled(): void;
}

export interface Job<TResult, TExtra extends object = object> {
  // The live status object. Safe to return directly from a GET .../status route.
  readonly status: JobStatus<TResult> & TExtra;
  // Starts the job in the background. Returns false (and does nothing) if it's already running.
  start(
    run: (ctx: JobContext<TResult, TExtra>) => Promise<TResult>,
    initial?: Partial<JobStatus<TResult> & TExtra>,
  ): boolean;
  // Requests cancellation of the current run. Returns false if nothing is running.
  cancel(): boolean;
  // Resolves when the current run (if any) has fully finished, including cleanup.
  settled(): Promise<void>;
}

// Names of the jobs running right now, so long background work can yield to them.
export const runningJobNames = new Set<string>();
const runningStatuses = new Map<string, JobStatus<unknown>>();

/** How many jobs are running and how far along they are together (0 to 1), for the taskbar or
 *  dock progress. Null progress when none of them can say. */
export function runningJobsProgress(): { running: number; progress: number | null } {
  const fractions: number[] = [];
  for (const s of runningStatuses.values()) {
    if (s.total) fractions.push(Math.min(1, (s.processed ?? 0) / s.total));
    else if (s.totalBytes) fractions.push(Math.min(1, (s.downloadedBytes ?? 0) / s.totalBytes));
  }
  return {
    running: runningStatuses.size,
    progress: fractions.length > 0 ? fractions.reduce((a, b) => a + b, 0) / fractions.length : null,
  };
}

/** `silent`: housekeeping the user never started, kept out of the taskbar and dock progress. */
export function createJob<TResult = unknown, TExtra extends object = object>(
  name: string,
  extraDefaults?: TExtra,
  { silent = false }: { silent?: boolean } = {},
): Job<TResult, TExtra> {
  // Cloned per run so array/object defaults (e.g. a notFound list) never carry over between runs.
  const freshExtras = (): TExtra => structuredClone(extraDefaults ?? ({} as TExtra));
  const status = { ...idleJobStatus<TResult>(), ...freshExtras() } as JobStatus<TResult> & TExtra;
  let controller: AbortController | null = null;
  let current: Promise<void> = Promise.resolve();

  function start(
    run: (ctx: JobContext<TResult, TExtra>) => Promise<TResult>,
    initial?: Partial<JobStatus<TResult> & TExtra>,
  ): boolean {
    if (status.running) return false;
    // Claimed synchronously, before any await, so a concurrent request sees running = true.
    Object.assign(status, idleJobStatus<TResult>(), freshExtras(), initial ?? {}, { running: true });
    runningJobNames.add(name);
    if (!silent) runningStatuses.set(name, status);
    const ctl = new AbortController();
    controller = ctl;
    const ctx: JobContext<TResult, TExtra> = {
      signal: ctl.signal,
      update: (patch) => {
        if (controller === ctl) Object.assign(status, patch);
      },
      throwIfCancelled: () => {
        if (ctl.signal.aborted) throw new JobCancelledError();
      },
    };
    current = (async () => {
      try {
        const result = await run(ctx);
        if (ctl.signal.aborted) {
          status.cancelled = true;
        } else {
          status.result = result;
        }
      } catch (err) {
        if (ctl.signal.aborted || err instanceof JobCancelledError) {
          status.cancelled = true;
        } else {
          status.error = describeError(err);
          log.error({ err }, `[job:${name}] failed`);
        }
      } finally {
        status.running = false;
        runningJobNames.delete(name);
        runningStatuses.delete(name);
        status.phase = null;
        status.currentItem = null;
        status.cancelRequested = false;
        status.finishedAt = Date.now();
        if (controller === ctl) controller = null;
      }
    })();
    return true;
  }

  function cancel(): boolean {
    if (!status.running || !controller) return false;
    status.cancelRequested = true;
    controller.abort();
    return true;
  }

  return { status, start, cancel, settled: () => current };
}
