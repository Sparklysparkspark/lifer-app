import { useSyncExternalStore } from "react";
import { api, ApiError } from "../api/client";

export interface UploadJob {
  id: string;
  fileName: string;
  speciesId: string;
  /** True once this specific file's request has settled (success or failure) — lets the
   *  banner distinguish "still going" from "just about to be cleared". */
  done: boolean;
  error?: string;
  /** User chose "skip" on a duplicate-detection prompt — not an error, just never uploaded. */
  skipped?: boolean;
}

export interface PossibleDuplicate {
  captureId: string;
  speciesName: string;
  takenAt: string | null;
  /** false means this was caught by visual similarity (an edited/re-exported copy of a photo
   *  you already have), not a byte-for-byte identical file — see uploads/routes.ts's
   *  /uploads/inspect, which falls back to embedding similarity when the file hash alone finds
   *  nothing. */
  exact: boolean;
}

/** POSTs the file to /uploads/inspect (already computes EXIF/keywords for auto-matching) and
 *  reads back its possibleDuplicate field — a real network round trip per file, which is why
 *  this is only ever called when a caller opts in via onDuplicateDetected, never unconditionally
 *  for every upload. */
async function checkDuplicate(file: File): Promise<PossibleDuplicate | null> {
  const form = new FormData();
  form.append("file", file);
  try {
    const res = await api.post<{ possibleDuplicate: PossibleDuplicate | null }>("/uploads/inspect", form);
    return res.possibleDuplicate;
  } catch {
    // Inspection failing (a transient network blip, say) shouldn't block the real upload —
    // worst case, a genuine duplicate goes unflagged this one time.
    return null;
  }
}

interface QueueState {
  jobs: UploadJob[];
  /** Set whenever an enqueued batch targets a registered external drive — the banner uses
   *  this to show the "don't unplug" warning, since that's the only case where unplugging
   *  mid-write could actually corrupt a file. */
  targetsExternalDrive: boolean;
  justFinishedAt: number | null;
  /** A duplicate was found for a file whose upload is paused waiting on the user's choice —
   *  surfaced through the SAME global banner every other upload state goes through
   *  (UploadQueueBanner.tsx), not a dialog local to whichever page enqueued the file: that page
   *  (e.g. UploadDropzone's parent) may have already closed/unmounted by the time this async
   *  check comes back, same reason progress/errors are already global instead of per-caller. */
  pendingDuplicate: { jobId: string; fileName: string; info: PossibleDuplicate } | null;
}

// A module-level store (not a React context) is deliberate: uploads are fired from whichever
// component happens to be open (UploadDropzone inside a species page's modal) and must keep
// running — and stay visible via the banner in App.tsx — even after that component unmounts
// (the user closed the dialog, or navigated to a different page entirely). Plain fetch calls
// already survive a component unmount (see api/client.ts — no AbortController tied to
// anything); this store just gives every other component a way to see progress they didn't
// personally kick off.
let state: QueueState = { jobs: [], targetsExternalDrive: false, justFinishedAt: null, pendingDuplicate: null };
const duplicateResolvers = new Map<string, (choice: "import" | "skip") => void>();

/** Called by UploadQueueBanner's confirm UI — resolves the paused upload task waiting on this
 *  jobId, and clears the prompt from global state. */
export function resolveDuplicate(jobId: string, choice: "import" | "skip"): void {
  duplicateResolvers.get(jobId)?.(choice);
  duplicateResolvers.delete(jobId);
  setState({ pendingDuplicate: null });
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

export function useUploadQueue(): QueueState {
  return useSyncExternalStore(subscribe, getSnapshot);
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

/** Queues a batch of files for one species, uploading in the background — the caller (e.g.
 *  UploadDropzone) can close its dialog immediately after calling this; progress and errors
 *  surface via the global banner (useUploadQueue), not the caller's own state. */
export function enqueueUploads(
  speciesId: string,
  files: File[],
  opts: {
    volumeId?: string;
    targetsExternalDrive?: boolean;
    /** "Build a Trip" destination override — see uploads/routes.ts's own tripId handling.
     *  Files land under that trip's own folder and get tagged with trip_id instead of the
     *  default ORIGINALS_DIR/no-trip behavior. */
    tripId?: string;
    /** Fires after EACH file's own upload settles (success or failure), not just once the
     *  whole batch finishes — lets the species page refresh and show that photo immediately
     *  instead of every uploaded photo popping in at once only after the slowest one in the
     *  batch finally settles. */
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
        const dup = await checkDuplicate(file);
        if (dup) {
          setState({ pendingDuplicate: { jobId: job.id, fileName: job.fileName, info: dup } });
          const choice = await new Promise<"import" | "skip">((resolve) => duplicateResolvers.set(job.id, resolve));
          if (choice === "skip") {
            job.skipped = true;
            return;
          }
        }
        const form = new FormData();
        form.append("mode", "store");
        form.append("speciesId", speciesId);
        form.append("file", file);
        if (opts.volumeId) form.append("volumeId", opts.volumeId);
        if (opts.tripId) form.append("tripId", opts.tripId);
        await api.post("/uploads", form);
      } catch (err) {
        job.error = err instanceof ApiError ? err.message : "Upload failed";
      } finally {
        job.done = true;
        settleIfDone();
        setState({ jobs: [...state.jobs] });
        opts.onFileSettled?.();
        // Fires once this specific batch (not the whole global queue) has fully settled —
        // lets whichever page enqueued these refresh its own data if it's still mounted,
        // without needing a live subscription that outlives the component itself.
        remaining--;
        if (remaining === 0) opts.onBatchSettled?.();
      }
    });
  }
  pump();
}

/** Same background-queue treatment as enqueueUploads, for RAW files — each is its own
 *  /uploads/raw request (matched independently against already-uploaded JPEGs), so results
 *  come back per file rather than as a single batch outcome. onResult fires per file (used by
 *  RawUpload.tsx to show which species a RAW matched, if it's still mounted to care) in
 *  addition to feeding the shared jobs list the global banner reads from. */
export function enqueueRawUploads<T>(
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
        const form = new FormData();
        requestPart(file, form);
        form.append("file", file);
        const body = await api.post<{ results: T[] }>("/uploads/raw", form);
        result = parseResult(body);
      } catch (err) {
        error = err instanceof ApiError ? err.message : "Upload failed";
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

function settleIfDone() {
  if (state.jobs.every((j) => j.done)) {
    // Cleared after a short grace period so the banner can show "Uploaded N photos" instead
    // of just vanishing the instant the last file settles (same pattern as
    // MigrationStatusIndicator's justFinished window).
    setTimeout(() => {
      if (state.jobs.every((j) => j.done)) {
        const finishedAt = Date.now();
        setState({ jobs: [], targetsExternalDrive: false, justFinishedAt: finishedAt });
        // UploadQueueBanner's "justFinished" window is only ever re-evaluated on a render —
        // with no more jobs left, nothing else triggers one, so without this the banner never
        // re-renders to notice the window has elapsed and just sticks on "Upload finished"
        // forever. This is the render that actually clears it.
        setTimeout(() => {
          if (state.justFinishedAt === finishedAt) setState({ justFinishedAt: null });
        }, 6000);
      }
    }, 50);
  }
}
