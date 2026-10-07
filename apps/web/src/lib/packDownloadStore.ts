import type { JobStatus } from "@lifer/shared";
import { api, ApiError } from "../api/client";
import { errorMessage } from "./errorMessage";
import i18n from "../i18n";

export type PackDownloadStatus = JobStatus<{ packsApplied: number }> & {
  packIds: string[];
  currentPack: string | null;
};

export interface PackDownloadState {
  status: PackDownloadStatus | null;
  loadError: string | null;
}

const STATUS_URL = "/offline-packs/download/status";
export const RUNNING_POLL_MS = 1000;
export const IDLE_POLL_MS = 5000;

// One poller for the whole app: Settings, Offline Packs, the Collection prompts and the
// updates banner all read the same server-side job, so they share one request loop.
let state: PackDownloadState = { status: null, loadError: null };
const listeners = new Set<() => void>();
const finishListeners = new Set<(status: PackDownloadStatus) => void>();
const abandonListeners = new Set<(reason: string) => void>();
let subscribers = 0;
let authed = true;
// Set by a 404/401: waiting won't change the answer, so stop until something wakes it.
let stopped = false;
let wasRunning = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<PackDownloadStatus | null> | null = null;

function isHidden(): boolean {
  return typeof document !== "undefined" && document.hidden;
}

/** How long until the next poll, or null to stay paused until woken. */
export function nextPackPollDelay(opts: {
  subscribers: number;
  hidden: boolean;
  authed: boolean;
  stopped: boolean;
  running: boolean;
}): number | null {
  if (opts.subscribers <= 0 || opts.hidden || !opts.authed || opts.stopped) return null;
  return opts.running ? RUNNING_POLL_MS : IDLE_POLL_MS;
}

function setState(next: PackDownloadState) {
  state = next;
  listeners.forEach((l) => l());
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function schedule() {
  clearTimer();
  const delay = nextPackPollDelay({
    subscribers,
    hidden: isHidden(),
    authed,
    stopped,
    running: state.status?.running ?? wasRunning,
  });
  if (delay != null) timer = setTimeout(() => void poll(), delay);
}

async function poll(): Promise<PackDownloadStatus | null> {
  if (inflight) return inflight;
  clearTimer();
  inflight = (async () => {
    try {
      const next = await api.get<PackDownloadStatus>(STATUS_URL);
      const finished = wasRunning && !next.running;
      wasRunning = next.running;
      setState({ status: next, loadError: null });
      if (finished) finishListeners.forEach((l) => l(next));
      return next;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 401)) {
        stopped = true;
        abandonListeners.forEach((l) => l(i18n.t("offlinePacks.download.lostTrack")));
      }
      setState({ ...state, loadError: errorMessage(err, i18n.t("offlinePacks.download.unreachable")) });
      return null;
    } finally {
      inflight = null;
      schedule();
    }
  })();
  return inflight;
}

function onVisibilityChange() {
  if (isHidden()) clearTimer();
  else void poll();
}

/** Polls now (and wakes a stopped poller). Resolves with the fresh status, or null on failure. */
export function refreshPackDownload(): Promise<PackDownloadStatus | null> {
  stopped = false;
  return poll();
}

/** Called after starting a job here, so onFinish fires even if it ends before the next poll. */
export function markPackDownloadStarted(): void {
  wasRunning = true;
}

export function setPackDownloadAuthed(next: boolean): void {
  if (authed === next) return;
  authed = next;
  if (next) {
    stopped = false;
    if (subscribers > 0) void poll();
  } else {
    clearTimer();
    wasRunning = false;
    setState({ status: null, loadError: null });
    abandonListeners.forEach((l) => l(i18n.t("offlinePacks.download.signedOut")));
  }
}

export function getPackDownloadState(): PackDownloadState {
  return state;
}

/** useSyncExternalStore subscribe: the first subscriber starts polling, the last stops it. */
export function subscribePackDownload(listener: () => void): () => void {
  listeners.add(listener);
  subscribers++;
  if (subscribers === 1) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange);
    if (!isHidden() && authed) void poll();
  }
  return () => {
    listeners.delete(listener);
    subscribers--;
    if (subscribers === 0) {
      clearTimer();
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange);
    }
  };
}

/** Called when the store stops following the job (signed out, or the server stopped answering),
 *  so anything waiting for it to finish can give up. */
export function onPackDownloadAbandoned(listener: (reason: string) => void): () => void {
  abandonListeners.add(listener);
  return () => {
    abandonListeners.delete(listener);
  };
}

export function onPackDownloadFinish(listener: (status: PackDownloadStatus) => void): () => void {
  finishListeners.add(listener);
  return () => {
    finishListeners.delete(listener);
  };
}

// Test-only.
export function resetPackDownloadStore(): void {
  clearTimer();
  state = { status: null, loadError: null };
  listeners.clear();
  finishListeners.clear();
  abandonListeners.clear();
  subscribers = 0;
  authed = true;
  stopped = false;
  wasRunning = false;
  inflight = null;
}
