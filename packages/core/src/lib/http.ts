// Lifer's one outbound HTTP client for third-party APIs (iNaturalist, GBIF, Wikimedia...): one
// User-Agent, a hard per-attempt timeout, retries with Retry-After or exponential backoff, a
// process-wide pacer per host, and an optional raw-response cache table in Postgres.
import { APP_VERSION } from "../config.js";
import { log } from "./log.js";

// iNaturalist and Wikimedia ask for a descriptive User-Agent with a contact; unidentified
// clients get stricter limits.
export const USER_AGENT = `Lifer/${APP_VERSION} (+https://github.com/Sparklysparkspark/lifer-app)`;

/** iNaturalist asks for about one request a second; every iNaturalist call in a process shares
 *  this gap per host. Long bulk passes can raise it with INAT_MIN_HOST_INTERVAL_MS. */
export const INAT_MIN_HOST_INTERVAL_MS = Number(process.env.INAT_MIN_HOST_INTERVAL_MS) || 1000;
const INAT_HOSTS = new Set(["api.inaturalist.org", "www.inaturalist.org"]);

export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface ResponseCacheOptions {
  /** A table with (url text primary key, response text, fetched_at timestamptz). */
  table: "inat_response_cache" | "gbif_response_cache";
  /** Entries older than this are refetched; null or unset reads them however old. */
  maxAgeMs?: number | null;
  /** Defaults to the shared pool. */
  db?: Queryable;
}

export interface HttpOptions {
  /** Method, headers and body. A User-Agent is added unless one is given. */
  init?: Omit<RequestInit, "signal">;
  signal?: AbortSignal;
  /** Per attempt, enforced even when the connection goes silent. Default 30 s. */
  timeoutMs?: number;
  /** Attempts after the first one. Default 3. */
  maxRetries?: number;
  /** Also retry 5xx answers, not only 429. */
  retryServerErrors?: boolean;
  /** Exponential backoff between attempts when the server gives no Retry-After. */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** Minimum gap between calls to the URL's host, shared by every caller in the process.
   *  Defaults to INAT_MIN_HOST_INTERVAL_MS for iNaturalist hosts and none elsewhere. */
  paceMs?: number;
  /** GET only: successful bodies are cached by exact URL. */
  cache?: ResponseCacheOptions;
}

export class FetchTimeoutError extends Error {
  constructor(url: string, timeoutMs: number) {
    super(`fetch timed out after ${timeoutMs}ms: ${url}`);
    this.name = "FetchTimeoutError";
  }
}

const hostQueues = new Map<string, Promise<void>>();
const lastCallAtByHost = new Map<string, number>();
const heldUntilByHost = new Map<string, number>();

/** Waits for this host's turn: calls are serialized at least intervalMs apart, and none starts
 *  while the host is held (holdHost). */
export function paceHost(host: string, intervalMs: number): Promise<void> {
  const prior = hostQueues.get(host) ?? Promise.resolve();
  const next = prior.then(async () => {
    const readyAt = Math.max((lastCallAtByHost.get(host) ?? 0) + intervalMs, heldUntilByHost.get(host) ?? 0);
    const wait = readyAt - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAtByHost.set(host, Date.now());
  });
  hostQueues.set(host, next);
  return next;
}

/** After a 429 every caller backs off, not just the one that was refused: carrying on at once
 *  only keeps a host throttling. */
export function holdHost(host: string, ms: number): void {
  heldUntilByHost.set(host, Math.max(heldUntilByHost.get(host) ?? 0, Date.now() + ms));
}

// Unpaced hosts aren't serialized (GBIF downloads run in parallel); they only wait out a hold.
async function waitForHost(host: string, paceMs: number, signal?: AbortSignal): Promise<void> {
  if (paceMs > 0) return paceHost(host, paceMs);
  const wait = (heldUntilByHost.get(host) ?? 0) - Date.now();
  if (wait > 0) await sleep(wait, signal);
}

/** For tests: forget every host's last call and hold. */
export function resetHostPacing(): void {
  hostQueues.clear();
  lastCallAtByHost.clear();
  heldUntilByHost.clear();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// AbortSignal.timeout() alone isn't a reliable backstop: a stalled connection that neither sends
// nor closes can outlive it. Racing the fetch against an independent timer guarantees a retry.
// The timeout signal stays on the request so reading the body is bounded too.
async function fetchWithHardTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FetchTimeoutError(url, timeoutMs));
    }, timeoutMs);
  });
  const deadline = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, controller.signal, deadline].filter((s) => s != null));
  try {
    return await Promise.race([fetch(url, { ...init, signal: combined }), timeout]);
  } catch (err) {
    // Whichever timer fires first, a header timeout reads the same.
    if (deadline.aborted && !signal?.aborted) throw new FetchTimeoutError(url, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer!);
  }
}

/** Retry-After in seconds or as an HTTP date, in ms; null when absent or unusable. */
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : null;
  const at = Date.parse(header);
  return Number.isFinite(at) && at > now ? at - now : null;
}

let defaultDb: Promise<Queryable> | null = null;
// Loaded on first use, so modules that only need USER_AGENT or the pacer don't open a pool.
function cacheDb(cache: ResponseCacheOptions): Promise<Queryable> {
  if (cache.db) return Promise.resolve(cache.db);
  defaultDb ??= import("../db.js").then((m) => m.pool as unknown as Queryable);
  return defaultDb;
}

async function readCache(cache: ResponseCacheOptions, url: string): Promise<string | null> {
  try {
    const db = await cacheDb(cache);
    const res = await db.query(
      `SELECT response FROM ${cache.table}
       WHERE url = $1 AND ($2::double precision IS NULL OR fetched_at > now() - $2 * interval '1 millisecond')`,
      [url, cache.maxAgeMs ?? null],
    );
    const response = res.rows[0]?.response;
    return typeof response === "string" ? response : null;
  } catch {
    // The cache is only an optimization: a DB error falls through to a live fetch.
    return null;
  }
}

async function writeCache(cache: ResponseCacheOptions, url: string, response: string): Promise<void> {
  try {
    const db = await cacheDb(cache);
    await db.query(
      `INSERT INTO ${cache.table} (url, response) VALUES ($1, $2)
       ON CONFLICT (url) DO UPDATE SET response = EXCLUDED.response, fetched_at = now()`,
      [url, response],
    );
  } catch {
    // Best effort: failing to cache never fails the request.
  }
}

/** Drops a cached body, e.g. one that turned out not to have the expected shape. */
export async function evictCachedResponse(cache: ResponseCacheOptions, url: string): Promise<void> {
  try {
    const db = await cacheDb(cache);
    await db.query(`DELETE FROM ${cache.table} WHERE url = $1`, [url]);
  } catch {
    // Best effort, like writing it.
  }
}

/** Fetches `url` politely. Resolves with the final Response, which is still a 429 (or 5xx with
 *  retryServerErrors) when every attempt was refused; rejects with the last network error or
 *  FetchTimeoutError when no attempt got an answer. */
export async function httpFetch(url: string, opts: HttpOptions = {}): Promise<Response> {
  const host = new URL(url).host;
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxRetries = opts.maxRetries ?? 3;
  const baseMs = opts.backoffBaseMs ?? 1000;
  const maxMs = opts.backoffMaxMs ?? 60_000;
  const paceMs = opts.paceMs ?? (INAT_HOSTS.has(host) ? INAT_MIN_HOST_INTERVAL_MS : 0);
  const method = (opts.init?.method ?? "GET").toUpperCase();
  const cache = opts.cache && method === "GET" ? opts.cache : null;
  const headers = new Headers(opts.init?.headers);
  if (!headers.has("User-Agent")) headers.set("User-Agent", USER_AGENT);
  const init: RequestInit = { ...opts.init, headers };

  if (cache) {
    const cached = await readCache(cache, url);
    if (cached !== null) return new Response(cached, { status: 200 });
  }

  const backoff = (attempt: number) => Math.min(baseMs * 2 ** attempt, maxMs);
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const last = attempt === maxRetries;
    await waitForHost(host, paceMs, opts.signal);
    let res: Response;
    try {
      res = await fetchWithHardTimeout(url, init, timeoutMs, opts.signal);
    } catch (err) {
      // A dropped connection throws rather than returning a Response; retried like any blip.
      if (opts.signal?.aborted) throw err;
      lastError = err;
      if (last) break;
      log.warn({ host, attempt, err: err instanceof Error ? err.message : err }, "HTTP request failed, retrying");
      await sleep(backoff(attempt), opts.signal);
      continue;
    }
    const retryAfter = retryAfterMs(res.headers.get("retry-after"));
    // Throttling holds the host for every caller in the process, final attempt included.
    if (res.status === 429) holdHost(host, retryAfter ?? backoff(attempt));
    const retryable = res.status === 429 || (opts.retryServerErrors === true && res.status >= 500);
    if (retryable && !last) {
      const delayMs = retryAfter ?? backoff(attempt);
      log.warn(
        { host, status: res.status, backoffSeconds: Math.round(delayMs / 1000) },
        "HTTP request refused, backing off",
      );
      await res.body?.cancel().catch(() => {});
      // A 429 already holds the host (waited out at the top of the loop); a 5xx waits here.
      if (res.status !== 429) await sleep(delayMs, opts.signal);
      continue;
    }
    // Only a success is cached, so a transient error is retried next time.
    if (cache && res.ok) await writeCache(cache, url, await res.clone().text());
    return res;
  }
  throw lastError;
}
