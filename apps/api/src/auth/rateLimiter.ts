// In-memory sliding-window rate limiter for the login route (lifer-spec.md §8: "rate-limit
// the login route in the application, not only at the proxy"). In-memory is a stated MVP
// limit — a single-process personal deployment doesn't need a shared store, but this resets
// on restart and wouldn't coordinate across multiple API instances.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;

const attempts = new Map<string, number[]>();

export function isRateLimited(key: string): boolean {
  const now = Date.now();
  const timestamps = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  attempts.set(key, timestamps);
  return timestamps.length >= MAX_ATTEMPTS;
}

export function recordAttempt(key: string): void {
  const timestamps = attempts.get(key) ?? [];
  timestamps.push(Date.now());
  attempts.set(key, timestamps);
}
