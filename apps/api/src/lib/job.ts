// Shared lifecycle for every long-running background job (see packages/shared/src/job.ts for the
// status shape the web app polls). Owns the three things each hand-rolled job used to get
// slightly wrong on its own:
// - The claim: start() checks `running` and sets it in the same synchronous tick, so two
//   requests arriving together can never both start the job (the old check, then await, then
//   set pattern let both through).
// - Cancellation: one AbortController per run, aborted by cancel(), handed to the run function
//   so it can pass the signal to fetch() and stream pipelines.
// - Cleanup: running/finishedAt/cancelRequested are always reset in a finally, so a thrown
//   error can never leave the job stuck "running" forever.
import { idleJobStatus, type JobStatus } from "@lifer/shared";

export class JobCancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "JobCancelledError";
  }
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
          status.error = err instanceof Error ? err.message : String(err);
          console.error(`[job:${name}]`, err);
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
