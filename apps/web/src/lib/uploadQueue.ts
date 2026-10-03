import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";
import { discardUpload, uploadFile } from "./tusUpload";
import { isVideoFile } from "./photoFormats";

export interface UploadJob {
  id: string;
  fileName: string;
  speciesId: string;
  /** This file's request has settled (success or failure). */
  done: boolean;
  error?: string;
  /** User chose "skip" on a duplicate prompt: not an error, just never imported. */
  skipped?: boolean;
  /** Bytes sent so far and the file's size, while its upload is in flight. */
  sentBytes?: number;
  totalBytes?: number;
}

export interface PossibleDuplicate {
  captureId: string;
  speciesName: string;
  takenAt: string | null;
  /** false: a visually similar (edited or re-exported) copy rather than an identical file. */
  exact: boolean;
}

/** Asks /uploads/inspect whether an uploaded file is a duplicate. */
async function checkDuplicate(uploadId: string): Promise<PossibleDuplicate | null> {
  const form = new FormData();
  form.append("uploadId", uploadId);
  try {
    const res = await api.post<{ possibleDuplicate: PossibleDuplicate | null }>("/uploads/inspect", form);
    return res.possibleDuplicate;
  } catch {
    // A failed check never blocks the upload; at worst a duplicate goes unflagged.
    return null;
  }
}

/** POSTs an import request that names the file by id rather than carrying it. Tries, in order, a
 *  copy the server kept from a check (stagedId), a finished resumable upload (uploadId), then a
 *  fresh upload of the file; a 410 (that copy is gone) moves on to the next. */
export async function postUploadedFile<T>(
  endpoint: string,
  file: File,
  opts: {
    stagedId?: string | null;
    uploadId?: string | null;
    onProgress?: (sentBytes: number, totalBytes: number) => void;
    addFields: (form: FormData) => void;
  },
): Promise<T> {
  const post = (field: "stagedId" | "uploadId", id: string) => {
    const form = new FormData();
    opts.addFields(form);
    form.append(field, id);
    form.append("fileName", file.name);
    // Often empty for HEIC; the server then goes by the extension and the upload's own metadata.
    if (file.type) form.append("fileType", file.type);
    return api.post<T>(endpoint, form);
  };
  const attempts: Array<["stagedId" | "uploadId", string]> = [];
  if (opts.stagedId) attempts.push(["stagedId", opts.stagedId]);
  if (opts.uploadId) attempts.push(["uploadId", opts.uploadId]);
  for (const [field, id] of attempts) {
    try {
      return await post(field, id);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 410)) throw err;
    }
  }
  return post("uploadId", await uploadFile(file, { onProgress: opts.onProgress }));
}

/** Species suggestions for a video, read from its resumable upload so the import can use the
 *  same uploadId. `upload(true)` must send the file again (after a 410); tried once. */
export async function suggestSpeciesFromVideo<T>(upload: (fresh: boolean) => Promise<string>, regionId: string | null): Promise<T> {
  const suggest = (uploadId: string) => {
    const form = new FormData();
    form.append("uploadId", uploadId);
    if (regionId) form.append("regionId", regionId);
    return api.post<T>("/captures/suggest-species-from-video", form);
  };
  try {
    return await suggest(await upload(false));
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 410)) throw err;
    return suggest(await upload(true));
  }
}

interface QueueState {
  jobs: UploadJob[];
  /** A batch targets an external drive, so the banner warns not to unplug it. */
  targetsExternalDrive: boolean;
  justFinishedAt: number | null;
  /** Paused uploads waiting on a duplicate prompt, oldest first. A queue because several uploads
   *  can hit one at once; shown in the global banner since the enqueuing page may be gone. */
  pendingDuplicates: PendingDuplicate[];
}

export interface PendingDuplicate {
  jobId: string;
  fileName: string;
  info: PossibleDuplicate;
}

// Module-level store so uploads stay visible (in the banner) after the component that started
// them unmounts; the fetches themselves already outlive it.
let state: QueueState = { jobs: [], targetsExternalDrive: false, justFinishedAt: null, pendingDuplicates: [] };
const duplicateResolvers = new Map<string, (choice: "import" | "skip") => void>();

/** Answers one duplicate prompt, resuming its paused upload and leaving the others queued. */
export function resolveDuplicate(jobId: string, choice: "import" | "skip"): void {
  const resolve = duplicateResolvers.get(jobId);
  duplicateResolvers.delete(jobId);
  setState({ pendingDuplicates: state.pendingDuplicates.filter((d) => d.jobId !== jobId) });
  resolve?.(choice);
}

/** Pauses an upload until the user answers its duplicate prompt. */
function askAboutDuplicate(job: UploadJob, info: PossibleDuplicate): Promise<"import" | "skip"> {
  return new Promise((resolve) => {
    duplicateResolvers.set(job.id, resolve);
    setState({ pendingDuplicates: [...state.pendingDuplicates, { jobId: job.id, fileName: job.fileName, info }] });
  });
}
const listeners = new Set<() => void>();

function setState(next: Partial<QueueState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): QueueState {
  return state;
}

// Non-hook read of the same state, for tests and non-React callers.
export const getUploadQueueState = getSnapshot;

export function useUploadQueue(): QueueState {
  return useSyncExternalStore(subscribe, getSnapshot);
}

/** Records upload progress for a job. Only whole-percent changes re-render, since tus reports
 *  progress many times a second. */
export function reportJobProgress(jobId: string, sentBytes: number, totalBytes: number): void {
  const job = state.jobs.find((j) => j.id === jobId);
  if (!job || totalBytes <= 0) return;
  const before = job.totalBytes ? Math.floor(((job.sentBytes ?? 0) / job.totalBytes) * 100) : -1;
  job.sentBytes = sentBytes;
  job.totalBytes = totalBytes;
  if (Math.floor((sentBytes / totalBytes) * 100) !== before) setState({ jobs: [...state.jobs] });
}

const MAX_CONCURRENT = 3;
let running = 0;
const pending: Array<() => Promise<void>> = [];

function pump() {
  while (running < MAX_CONCURRENT && pending.length > 0) {
    const next = pending.shift()!;
    running++;
    next().finally(() => {
      running--;
      pump();
    });
  }
}

/** Uploads a batch for one species in the background; progress and errors show in the banner. */
export function enqueueUploads(
  speciesId: string,
  files: File[],
  opts: {
    volumeId?: string;
    targetsExternalDrive?: boolean;
    /** Files go into this trip's folder and get its trip_id. */
    tripId?: string;
    /** Fires per file (success or failure), so each photo can appear as soon as it's done. */
    onFileSettled?: () => void;
    onBatchSettled?: () => void;
  } = {},
): void {
  if (files.length === 0) return;
  const jobs: UploadJob[] = files.map((f) => ({ id: `${Date.now()}-${Math.random()}`, fileName: f.name, speciesId, done: false }));
  setState({
    jobs: [...state.jobs, ...jobs],
    targetsExternalDrive: state.targetsExternalDrive || Boolean(opts.targetsExternalDrive),
  });

  let remaining = files.length;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const job = jobs[i];
    pending.push(async () => {
      try {
        const onProgress = (sent: number, total: number) => reportJobProgress(job.id, sent, total);
        // Videos skip the mode field and the duplicate check.
        if (isVideoFile(file)) {
          await postUploadedFile("/uploads/video", file, {
            onProgress,
            addFields: (form) => {
              form.append("speciesId", speciesId);
              if (opts.volumeId) form.append("volumeId", opts.volumeId);
              if (opts.tripId) form.append("tripId", opts.tripId);
            },
          });
          return;
        }
        // Sent once: the check and the import both refer to this upload.
        const uploadId = await uploadFile(file, { onProgress });
        const dup = await checkDuplicate(uploadId);
        if (dup) {
          const choice = await askAboutDuplicate(job, dup);
          if (choice === "skip") {
            job.skipped = true;
            discardUpload(uploadId);
            return;
          }
        }
        await postUploadedFile("/uploads", file, {
          uploadId,
          onProgress,
          addFields: (form) => {
            form.append("mode", "store");
            form.append("speciesId", speciesId);
            if (opts.volumeId) form.append("volumeId", opts.volumeId);
            if (opts.tripId) form.append("tripId", opts.tripId);
          },
        });
      } catch (err) {
        job.error = err instanceof Error ? err.message : "Upload failed";
      } finally {
        job.done = true;
        settleIfDone();
        setState({ jobs: [...state.jobs] });
        opts.onFileSettled?.();
        // This batch (not the whole queue) has settled.
        remaining--;
        if (remaining === 0) opts.onBatchSettled?.();
      }
    });
  }
  pump();
}

/** enqueueUploads for RAW files: each is uploaded, then matched against imported JPEGs with its
 *  own /uploads/raw request, with onResult per file. */
export function enqueueRawUploads<T extends { filename?: string }>(
  speciesId: string,
  files: File[],
  requestPart: (file: File, form: FormData) => void,
  parseResult: (body: { results: T[] }) => T,
  opts: { onResult?: (file: File, result: T | null, error: string | null) => void; onBatchSettled?: () => void; targetsExternalDrive?: boolean } = {},
): void {
  if (files.length === 0) return;
  const jobs: UploadJob[] = files.map((f) => ({ id: `${Date.now()}-${Math.random()}`, fileName: f.name, speciesId, done: false }));
  setState({
    jobs: [...state.jobs, ...jobs],
    targetsExternalDrive: state.targetsExternalDrive || Boolean(opts.targetsExternalDrive),
  });

  let remaining = files.length;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const job = jobs[i];
    pending.push(async () => {
      let result: T | null = null;
      let error: string | null = null;
      try {
        const uploadId = await uploadFile(file, { onProgress: (sent, total) => reportJobProgress(job.id, sent, total) });
        const form = new FormData();
        requestPart(file, form);
        form.append("uploadIds", uploadId);
        const body = await api.post<{ results: T[] }>("/uploads/raw", form);
        // A result for an upload the server couldn't use comes back without a filename.
        result = parseResult({ results: body.results.map((r) => (r.filename ? r : { ...r, filename: file.name })) });
      } catch (err) {
        error = err instanceof Error ? err.message : "Upload failed";
        job.error = error;
      } finally {
        job.done = true;
        settleIfDone();
        setState({ jobs: [...state.jobs] });
        opts.onResult?.(file, result, error);
        remaining--;
        if (remaining === 0) opts.onBatchSettled?.();
      }
    });
  }
  pump();
}

/** Adds a job that the caller uploads itself (PhotoImportRows) to the shared list, so it shows in
 *  the banner. Report the outcome with settleExternalJob. */
export function registerExternalJob(speciesId: string, fileName: string): string {
  const job: UploadJob = { id: `${Date.now()}-${Math.random()}`, fileName, speciesId, done: false };
  setState({ jobs: [...state.jobs, job] });
  return job.id;
}

export function settleExternalJob(jobId: string, error?: string): void {
  const job = state.jobs.find((j) => j.id === jobId);
  if (job) {
    job.done = true;
    if (error) job.error = error;
  }
  settleIfDone();
  setState({ jobs: [...state.jobs] });
}

function settleIfDone() {
  if (state.jobs.every((j) => j.done)) {
    // Cleared after a grace period so the banner can show "Uploaded N photos" first.
    setTimeout(() => {
      if (state.jobs.every((j) => j.done)) {
        const finishedAt = Date.now();
        setState({ jobs: [], targetsExternalDrive: false, justFinishedAt: finishedAt });
        // Nothing else re-renders the banner once the queue is empty, so this emit clears it.
        setTimeout(() => {
          if (state.justFinishedAt === finishedAt) setState({ justFinishedAt: null });
        }, 6000);
      }
    }, 50);
  }
}
