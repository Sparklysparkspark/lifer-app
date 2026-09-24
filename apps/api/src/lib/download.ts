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
    arm(connectTimeoutMs);
    const res = await fetch(url, { signal, headers: opts.headers });
    if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status}`);
    const contentLength = res.headers.get("content-length");
    totalBytes = contentLength ? Number(contentLength) : null;
    opts.onProgress?.(0, totalBytes);
    arm(stallMs);

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        bytes += chunk.length;
        arm(stallMs);
        opts.onProgress?.(bytes, totalBytes);
        cb(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as WebReadableStream), counter, createWriteStream(destPath), { signal });
    return { bytes, totalBytes };
  } catch (err) {
    rmSync(destPath, { force: true });
    if (stall.signal.aborted && !opts.signal?.aborted) throw stall.signal.reason ?? new DownloadStalledError();
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
