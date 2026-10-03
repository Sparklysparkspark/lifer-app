// Streams a URL to a file with byte progress, cancellation and a stall timeout. `pipeline`
// (not `pipe`) so a dropped connection rejects here instead of crashing the process.
import { createWriteStream, rmSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

export interface DownloadOptions {
  signal?: AbortSignal;
  // Abort if no bytes arrive for this long. Large files get no total cap, only this.
  stallMs?: number;
  // Time allowed to receive response headers.
  connectTimeoutMs?: number;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  headers?: Record<string, string>;
  // Only these bytes, [offset, length], of the file at the URL (a pack in a pack store shard).
  // Anything but exactly that range back is an error: a server that ignores Range would send the
  // whole shard.
  range?: [number, number];
}

export class DownloadStalledError extends Error {
  constructor(message = "The download stalled (no data received for too long). Check your network connection and try again.") {
    super(message);
    this.name = "DownloadStalledError";
  }
}

export async function downloadToFile(
  url: string,
  destPath: string,
  opts: DownloadOptions = {},
): Promise<{ bytes: number; totalBytes: number | null }> {
  const stallMs = opts.stallMs ?? 60_000;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 30_000;
  const stall = new AbortController();
  const signal = opts.signal ? AbortSignal.any([opts.signal, stall.signal]) : stall.signal;
  let timer: NodeJS.Timeout | null = null;
  const arm = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => stall.abort(new DownloadStalledError()), ms);
  };

  let bytes = 0;
  let totalBytes: number | null = null;
  try {
    const range = opts.range;
    if (range && !(Number.isSafeInteger(range[0]) && range[0] >= 0 && Number.isSafeInteger(range[1]) && range[1] > 0)) {
      throw new Error(`Download failed: invalid byte range ${JSON.stringify(range)}`);
    }
    arm(connectTimeoutMs);
    const headers = range ? { ...opts.headers, Range: `bytes=${range[0]}-${range[0] + range[1] - 1}` } : opts.headers;
    const res = await fetch(url, { signal, headers });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    if (range && (res.status !== 206 || !res.headers.get("content-range")?.startsWith(`bytes ${range[0]}-`))) {
      await res.body.cancel().catch(() => {});
      throw new Error(`Download failed: the server didn't return the requested part of the file (HTTP ${res.status})`);
    }
    const contentLength = res.headers.get("content-length");
    totalBytes = contentLength ? Number(contentLength) : null;
    opts.onProgress?.(0, totalBytes);
    arm(stallMs);

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        if (range && bytes > range[1]) return cb(new Error(`Download failed: more than the expected ${range[1]} bytes`));
        arm(stallMs);
        opts.onProgress?.(bytes, totalBytes);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), counter, createWriteStream(destPath), { signal });
    if (range && bytes !== range[1]) throw new Error(`Download failed: expected ${range[1]} bytes, got ${bytes}`);
    return { bytes, totalBytes };
  } catch (err) {
    rmSync(destPath, { force: true });
    if (stall.signal.aborted && !opts.signal?.aborted) throw stall.signal.reason ?? new DownloadStalledError();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
