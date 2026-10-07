// Shared lifecycle for background jobs (the polled status shape is packages/shared/src/job.ts):
// - start() claims the job synchronously, so two requests can't both start it.
// - One AbortController per run, aborted by cancel() and passed to fetch and streams.
// - running/finishedAt/cancelRequested are reset in a finally, so an error can't leave it running.
import { idleJobStatus, type JobStatus } from "@lifer/shared";
import { log } from "@lifer/core/lib/log.js";

export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelledError";
  }
}

// Appends node-postgres's `detail` (which row, which values) to the message shown in Settings.
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const detail = (err as { detail?: unknown })?.detail;
  return typeof detail === "string" && detail.length > 0 ? `${message} (${detail})` : message;
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
  start(run: (ctx: JobContext<TResult, TExtra>) => Promise<TResult>, initial?: Partial<JobStatus<TResult> & TExtra>): boolean;
  // Requests cancellation of the current run. Returns false if nothing is running.
  cancel(): boolean;
  // Resolves when the current run (if any) has fully finished, including cleanup.
  settled(): Promise<void>;
}

export function createJob<TResult = unknown, TExtra extends object = object>(
  name: string,
  extraDefaults?: TExtra,
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
