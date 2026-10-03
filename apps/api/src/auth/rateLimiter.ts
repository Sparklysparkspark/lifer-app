// In-memory sliding-window rate limiter for login and share passwords. A single-process personal
// deployment doesn't need a shared store; this resets on restart and wouldn't coordinate across
// multiple API instances.

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

// Groups an IPv6 client by its /64, since one host usually controls a whole /64 and could
// otherwise rotate addresses to reset its limit. IPv4 (and IPv4-mapped IPv6) is kept as is.
export function ipRateLimitKey(ip: string): string {
  const addr = ip.trim().toLowerCase();
  if (!addr.includes(":")) return addr;
  if (addr.startsWith("::ffff:") && addr.includes(".")) return addr.slice(7);
  const [head, tail = ""] = addr.split("%")[0].split("::");
  const headParts = head ? head.split(":") : [];
  const tailParts = addr.includes("::") && tail ? tail.split(":") : [];
  const missing = 8 - headParts.length - tailParts.length;
  const full = addr.includes("::") ? [...headParts, ...Array(Math.max(missing, 0)).fill("0"), ...tailParts] : headParts;
  return `${full.slice(0, 4).map((p) => p.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

// For tests.
export function trackedKeyCount(): number {
  return attempts.size;
}
