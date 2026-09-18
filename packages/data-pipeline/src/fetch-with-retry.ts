// Wikimedia's REST/Commons APIs burst-rate-limit anonymous traffic (confirmed by hand —
// requests that succeed in isolation started 429ing once several fetch scripts had already
// hit related Wikimedia infra earlier in the same pipeline run). A fixed delay between calls
// isn't enough on its own; retrying a 429 with backoff is what actually recovers.
import { pool } from "./db.js";

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
// No per-request timeout used to exist at all — a single GBIF request that never resolves
// (confirmed live: a malformed gadmGid for an edge-case territory like "Ashmore and Cartier
// Is." left fetch() pending indefinitely, silently freezing an entire multi-day 249-country
// reconcile run on country #14) hung forever instead of ever reaching the retry logic below.
// This bounds every individual attempt so a stuck request becomes a retryable failure instead.
// 30s, then 60s, both proved too short for a different, genuine problem: GBIF's own
// species/search backend gets slower the deeper an offset-based page reaches into a big
// order (confirmed by hand with a raw curl against offset=10200 of Neogastropoda's ~26k
// species, PAGE_SIZE=300 in fetch-gbif-backbone.ts -- GBIF itself took over 90s to generate
// that one page, not a network hang or a proxy issue). Since this is a real, disclosed cost
// of GBIF's deep pagination (likely to recur, and possibly worse at even deeper offsets, not
// a one-off), 180s gives real headroom rather than chasing the exact number GBIF needs.
const REQUEST_TIMEOUT_MS = 180_000;

// Persistent raw-response cache (migration 040) — every GET call through this function (GBIF
// occurrence/species-count/seasonality/year-facet queries, the bulk of build-region-species.ts)
// is cached by exact URL. Re-running a region's computation after fixing a filtering/threshold
// bug re-derives the answer from the SAME cached raw data instead of re-fetching it from GBIF —
// the raw occurrence facts for past years don't change meaningfully within a development
// session, so there's no accuracy cost, only a huge reduction in redundant network calls and
// rate-limit exposure every time a downstream bug gets fixed and a region needs recomputing.
async function getCached(url: string): Promise<string | null> {
  try {
    const res = await pool.query<{ response: string }>(`SELECT response FROM gbif_response_cache WHERE url = $1`, [url]);
    return res.rows[0]?.response ?? null;
  } catch {
    // Cache is a pure optimization — a DB hiccup here should fall through to a live fetch,
    // never block the real request.
    return null;
  }
}

async function setCached(url: string, response: string): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO gbif_response_cache (url, response) VALUES ($1, $2)
       ON CONFLICT (url) DO UPDATE SET response = EXCLUDED.response, fetched_at = now()`,
      [url, response],
    );
  } catch {
    // Best-effort — failing to cache shouldn't fail the caller's real request.
  }
}

// AbortSignal.timeout() proved not to be a reliable backstop on its own. Confirmed live: a
// request against GBIF stalled (an established TCP connection that simply stopped sending
// data, never closing either) for nearly two hours without the 180s timeout ever firing,
// while a plain `curl` against the identical URL completed normally in under two minutes. Not
// a timer-pausing issue either (caffeinate's own uptime confirmed the machine never slept).
// Racing the fetch against an independent timeout promise, instead of trusting fetch() to
// actually honor an abort signal, means this code moves on and retries even in whatever edge
// case left that abort signal not doing anything. The orphaned fetch (and its still-open
// socket) is leaked rather than cleaned up, but a leaked in-flight request is a far smaller
// problem than the entire multi-hour pipeline silently never coming back at all.
class FetchTimeoutError extends Error {}
async function fetchWithHardTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchTimeoutError(`fetch timed out after ${timeoutMs}ms: ${url}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

export async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const cacheable = !init.method || init.method === "GET";
  if (cacheable) {
    const cached = await getCached(url);
    if (cached !== null) return new Response(cached, { status: 200 });
  }

  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let res: Response;
    try {
      res = await fetchWithHardTimeout(url, init, REQUEST_TIMEOUT_MS);
    } catch (err) {
      // A dropped connection (e.g. "SocketError: other side closed") throws instead of
      // resolving to a Response at all — GBIF's own infra does this often enough on large
      // paginated backbone pulls that treating it as a hard failure (the old behavior) meant
      // re-running the whole build by hand for what's really just a retryable network blip.
      lastError = err;
      const delayMs = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (res.status !== 429) {
      // Only ever cache a genuine success — caching a transient 4xx/5xx would freeze a real
      // failure in place forever instead of letting the next call retry it fresh.
      if (cacheable && res.ok) {
        const text = await res.clone().text();
        await setCached(url, text);
      }
      return res;
    }
    lastResponse = res;
    const retryAfterHeader = Number(res.headers.get("retry-after"));
    const delayMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? retryAfterHeader * 1000
      : Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!lastResponse) throw lastError;
  return lastResponse;
}
