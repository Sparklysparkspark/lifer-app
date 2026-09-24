// In-memory sliding-window rate limiter for the login route (: "rate-limit
// the login route in the application, not only at the proxy"). In-memory is a stated MVP
// limit — a single-process personal deployment doesn't need a shared store, but this resets
// on restart and wouldn't coordinate across multiple API instances.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
// Full sweeps of expired keys run at most this often, so the map can't grow without bound.
const SWEEP_INTERVAL_MS = 60 * 1000;

const attempts = new Map<string, number[]>();
let lastSweep = 0;

function sweep(now: number): void {
  if (now - lastSweep < SWEEP_INTERVAL_MS) return;
  lastSweep = now;
  for (const [key, timestamps] of attempts) {
    const live = timestamps.filter((t) => now - t < WINDOW_MS);
    if (live.length === 0) attempts.delete(key);
    else attempts.set(key, live);
  }
}

export function isRateLimited(key: string, max = MAX_ATTEMPTS): boolean {
  const now = Date.now();
  sweep(now);
  const timestamps = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length === 0) attempts.delete(key);
  else attempts.set(key, timestamps);
  return timestamps.length >= max;
}

export function recordAttempt(key: string): void {
  const timestamps = attempts.get(key) ?? [];
  timestamps.push(Date.now());
  attempts.set(key, timestamps);
}

// Called after a successful login so earlier typos don't count against the next session.
export function clearAttempts(key: string): void {
  attempts.delete(key);
}

// For tests.
export function trackedKeyCount(): number {
  return attempts.size;
}
