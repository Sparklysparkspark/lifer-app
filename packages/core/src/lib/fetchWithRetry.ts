// Wikimedia and GBIF burst-rate-limit anonymous traffic, and a fixed delay between calls isn't
// enough on its own; retrying a 429 with backoff is what recovers.
import { pool } from "../db.js";

const MAX_RETRIES = 6;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 60_000;
// Per-attempt timeout, so a request that never resolves becomes a retryable failure instead of
// hanging the whole run. Generous because GBIF's species/search gets very slow at deep
// pagination offsets (over 90s for a single page).
const REQUEST_TIMEOUT_MS = 180_000;

// Persistent raw-response cache (migration 040): every GET through here is cached by exact URL,
// so recomputing a region after a threshold fix reuses the same raw data instead of refetching.
async function getCached(url: string): Promise<string | null> {
  try {
    const res = await pool.query<{ response: string }>(`SELECT response FROM gbif_response_cache WHERE url = $1`, [
      url,
    ]);
    return res.rows[0]?.response ?? null;
  } catch {
    // The cache is only an optimization: a DB error falls through to a live fetch.
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
    // Best-effort: failing to cache shouldn't fail the request.
  }
}

// AbortSignal.timeout() alone isn't a reliable backstop: a stalled connection that neither sends
// nor closes can outlive it. Racing the fetch against an independent timeout guarantees a retry.
// The orphaned fetch and its socket are leaked, which beats a pipeline that never returns.
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
      // A dropped connection ("SocketError: other side closed") throws instead of returning a
      // Response. GBIF does this often on large paginated pulls, so it's retried like any blip.
      lastError = err;
      const delayMs = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      continue;
    }
    if (res.status !== 429) {
      // Only cache a genuine success, so a transient error isn't frozen in place.
      if (cacheable && res.ok) {
        const text = await res.clone().text();
        await setCached(url, text);
      }
      return res;
    }
    lastResponse = res;
    const retryAfterHeader = Number(res.headers.get("retry-after"));
    const delayMs =
      Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
        ? retryAfterHeader * 1000
        : Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  if (!lastResponse) throw lastError;
  return lastResponse;
}
