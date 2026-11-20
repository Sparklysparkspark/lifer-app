// Waits out a server's rate limit (429) on uploads, and tells the upload banner while it does.
import { useSyncExternalStore } from "react";

// The server's window is a minute, so a wait never needs to be longer than that.
export const MAX_WAIT_MS = 60_000;
const DEFAULT_WAIT_MS = 5_000;
// Waits per request before giving up: enough to ride out several full windows.
export const MAX_RATE_LIMIT_WAITS = 10;

/** How long a Retry-After header (seconds or an HTTP date) asks to wait, at least a second and at
 *  most MAX_WAIT_MS. A missing or unreadable header waits a few seconds. */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number {
  const value = header?.trim();
  if (!value) return DEFAULT_WAIT_MS;
  const ms = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(1000, ms));
}

let waiting = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Resolves after the wait the header asks for (or on abort), showing the banner's waiting state
 *  meanwhile. */
export function waitForRateLimit(header: string | null | undefined, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  waiting++;
  if (waiting === 1) emit();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      waiting--;
      if (waiting === 0) emit();
      resolve();
    };
    const timer = setTimeout(done, retryAfterMs(header));
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** True while some upload is waiting out the server's rate limit. */
export function useRateLimitWaiting(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => waiting > 0,
  );
}
