// Fetching from the internet without mistaking a slow connection for none. Lifer works offline,
// so callers answer from what's on this computer first; these helpers only decide how long to
// wait, whether a failure means "unreachable" or merely "slow", and when to try again.

/** What the last attempt to reach a host says about the connection. */
export type RemoteState = "online" | "slow" | "offline";

// Errors that come back quickly when there's no way to the host at all.
const UNREACHABLE_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
]);

/** No route, refused or no DNS: the host can't be reached. Timeouts and stalls are only slow. */
export function isUnreachable(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 4; depth++) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && UNREACHABLE_CODES.has(code)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

export function remoteStateOf(err: unknown): RemoteState {
  return isUnreachable(err) ? "offline" : "slow";
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    what: string,
  ) {
    super(`Couldn't fetch ${what} (${status})`);
    this.name = "HttpStatusError";
  }
}

const timeoutError = (what: string) => new DOMException(`No answer from ${what} in time`, "TimeoutError");

/** fetch() for a slow link: waits up to `firstByteMs` for the headers, then reads the body for as
 *  long as bytes keep coming, giving up only after `stallMs` of silence (or `totalMs`, if set).
 *  The body is read here, so the stall timer covers it. */
export async function fetchPatient(
  url: string,
  {
    firstByteMs = 20_000,
    stallMs = 30_000,
    totalMs,
    signal,
    headers,
    readBody = () => true,
  }: {
    firstByteMs?: number;
    stallMs?: number;
    totalMs?: number;
    signal?: AbortSignal;
    headers?: HeadersInit;
    /** False skips (and releases) the body, e.g. a whole file sent back instead of a range. */
    readBody?: (res: Response) => boolean;
  } = {},
): Promise<{ res: Response; body: Buffer }> {
  const host = new URL(url).host;
  const ctl = new AbortController();
  let timer = setTimeout(() => ctl.abort(timeoutError(host)), firstByteMs);
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => ctl.abort(timeoutError(host)), stallMs);
  };
  const signals = [ctl.signal, ...(signal ? [signal] : []), ...(totalMs ? [AbortSignal.timeout(totalMs)] : [])];
  try {
    const res = await fetch(url, { signal: AbortSignal.any(signals), headers });
    arm();
    const chunks: Buffer[] = [];
    if (res.body && !readBody(res)) await res.body.cancel().catch(() => {});
    else if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.from(value));
        arm();
      }
    }
    return { res, body: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

/** Remembers failures with exponential backoff (10 s, 20 s, ... up to 2 minutes), so callers
 *  answer from local state instead of retrying on every request. Any success resets it. */
export function backoffMemo({ firstMs = 10_000, maxMs = 120_000 }: { firstMs?: number; maxMs?: number } = {}) {
  let last: { until: number; delay: number; error: Error } | null = null;
  return {
    /** The remembered error while its backoff lasts, else null. */
    recent: (): Error | null => (last && Date.now() < last.until ? last.error : null),
    fail: (err: unknown): Error => {
      const delay = last ? Math.min(maxMs, last.delay * 2) : firstMs;
      const error = err instanceof Error ? err : new Error(String(err));
      last = { until: Date.now() + delay, delay, error };
      return error;
    },
    clear: () => {
      last = null;
    },
  };
}

// Worth another try: everything but a cancel, a full disk, and a 4xx other than 408 or 429.
function isRetryable(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return false;
  if ((err as Error)?.name === "DiskFullError") return false;
  if (err instanceof HttpStatusError) return err.status >= 500 || err.status === 408 || err.status === 429;
  return true;
}

/** Runs `fn` up to `attempts` times, waiting `baseMs`, 2x, 4x... between tries. downloadResumable
 *  retries on its own, so it needs no wrapping. */
export async function retrying<T>(
  fn: () => Promise<T>,
  { attempts = 4, baseMs = 2_000, signal }: { attempts?: number; baseMs?: number; signal?: AbortSignal } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err, signal)) throw err;
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, baseMs * 2 ** (attempt - 1));
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(signal.reason);
          },
          { once: true },
        );
      });
    }
  }
}
