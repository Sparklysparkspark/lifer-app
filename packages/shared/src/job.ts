// One status shape for every long-running background job (catalog update, offline map, CLIP
// model, pack downloads, server migration, reimport, trip scan/import, Other Taxa bulk). Every
// job exposes GET <prefix>/status returning this and POST <prefix>/cancel, so the web app can
// render all of them through one JobProgress component.
export type JobPhase = string;

export interface JobStatus<TResult = unknown> {
  running: boolean;
  // Short machine label for the current step, e.g. "downloading" | "applying". null when idle.
  phase: JobPhase | null;
  // Byte-level progress for download phases. totalBytes is null when the server didn't send a
  // Content-Length.
  downloadedBytes: number | null;
  totalBytes: number | null;
  // Item-level progress (tables applied, packs done, photos migrated). null when not applicable.
  processed: number | null;
  total: number | null;
  // Human-readable name of what's being worked on right now (a table name, a pack name).
  currentItem: string | null;
  error: string | null;
  // Epoch ms of the last completion (success, error or cancel). null while running or never run.
  finishedAt: number | null;
  cancelRequested: boolean;
  cancelled: boolean;
  // Job-specific outcome of the last successful run (e.g. rows merged per table).
  result: TResult | null;
}

export function idleJobStatus<TResult = unknown>(): JobStatus<TResult> {
  return {
    running: false,
    phase: null,
    downloadedBytes: null,
    totalBytes: null,
    processed: null,
    total: null,
    currentItem: null,
    error: null,
    finishedAt: null,
    cancelRequested: false,
    cancelled: false,
    result: null,
  };
}
