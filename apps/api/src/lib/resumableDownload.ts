// Downloads a large file to disk: streamed (never buffered in memory), resumable via HTTP Range
// when a previous attempt left a partial file, aborted only when the connection stalls (not after
// a fixed total time, which a slow but healthy link can exceed), and verified against a sha256.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

export interface ResumableDownloadOptions {
  signal?: AbortSignal;
  expectedSha256?: string | null;
  stallTimeoutMs?: number;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  // Used in error messages, e.g. "the catalog update".
  label?: string;
}

export async function sha256OfFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export class StallError extends Error {
  constructor(label: string, seconds: number) {
    super(
      `Couldn't download ${label}: no data received for ${seconds} seconds. Check this server's network access and try again.`,
    );
    this.name = "StallError";
  }
}

/** Downloads `url` to `destPath` (atomically, via `${destPath}.part`). If destPath already exists
 * with the expected sha256, returns immediately without touching the network. */
export async function downloadResumable(url: string, destPath: string, opts: ResumableDownloadOptions = {}): Promise<void> {
  const label = opts.label ?? "the file";
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  if (opts.expectedSha256 && existsSync(destPath) && (await sha256OfFile(destPath)) === opts.expectedSha256) return;

  const partPath = `${destPath}.part`;
  const existing = existsSync(partPath) ? statSync(partPath).size : 0;

  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort(opts.signal?.reason);
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  let stalled = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;
  const armStall = (ms: number) => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      ctl.abort();
    }, ms);
  };

  try {
    armStall(CONNECT_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: existing > 0 ? { Range: `bytes=${existing}-` } : undefined,
      redirect: "follow",
    });
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${label}: HTTP ${res.status}`);

    // 206 means the server honored the Range request; anything else restarts from zero.
    const resumed = res.status === 206 && existing > 0;
    const offset = resumed ? existing : 0;
    const len = res.headers.get("content-length");
    const totalBytes = len ? Number(len) + offset : null;
    let downloaded = offset;
    opts.onProgress?.(downloaded, totalBytes);
    armStall(stallMs);

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        downloaded += chunk.length;
        armStall(stallMs);
        opts.onProgress?.(downloaded, totalBytes);
        cb(null, chunk);
      },
    });
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(partPath, { flags: resumed ? "a" : "w" }),
    );
    if (totalBytes != null && downloaded !== totalBytes) {
      throw new Error(`Couldn't download ${label}: connection closed early (${downloaded} of ${totalBytes} bytes)`);
    }
  } catch (err) {
    // Keep the partial file so the next attempt resumes, unless the user cancelled.
    if (stalled) throw new StallError(label, Math.round(stallMs / 1000));
    throw err;
  } finally {
    if (stallTimer) clearTimeout(stallTimer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }

  if (opts.expectedSha256) {
    const actual = await sha256OfFile(partPath);
    if (actual !== opts.expectedSha256) {
      rmSync(partPath, { force: true });
      throw new Error(`Couldn't download ${label}: the file was corrupted in transit (checksum mismatch). Try again.`);
    }
  }
  renameSync(partPath, destPath);
}
