// Downloads a large file to disk: streamed (never buffered in memory), resumable via HTTP Range
// when a previous attempt left a partial file, aborted only when the connection stalls (not after
// a fixed total time, which a slow but healthy link can exceed), and verified against a sha256.
// `pipeline` (not `pipe`) so a dropped connection rejects here instead of crashing the process.
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DiskFullError, ensureRoom, isDiskFull } from "./freeSpace.js";
import { USER_AGENT } from "./http.js";

export const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const CONNECT_TIMEOUT_MS = 30_000;

export interface ResumableDownloadOptions {
  signal?: AbortSignal;
  expectedSha256?: string | null;
  stallTimeoutMs?: number;
  onProgress?: (downloadedBytes: number, totalBytes: number | null) => void;
  // Used in error messages, e.g. "the catalog update".
  label?: string;
  // Only these bytes, [offset, length], of the file at the URL (a pack in a pack store shard).
  // Anything but exactly that range back is an error: a server that ignores Range would send the
  // whole shard. A ranged download resumes only when the server sent a validator (ETag or
  // Last-Modified) for that same range, so a stray partial file is never spliced in.
  range?: [number, number];
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

function isValidRange(range: [number, number]): boolean {
  return Number.isSafeInteger(range[0]) && range[0] >= 0 && Number.isSafeInteger(range[1]) && range[1] > 0;
}

/** Downloads `url` to `destPath` (atomically, via `${destPath}.part`). If destPath already exists
 * with the expected sha256, returns immediately without touching the network. Resolves with the
 * file's size and the size the server announced, when it did. */
export async function downloadResumable(
  url: string,
  destPath: string,
  opts: ResumableDownloadOptions = {},
): Promise<{ bytes: number; totalBytes: number | null }> {
  const label = opts.label ?? "the file";
  const stallMs = opts.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const range = opts.range;
  if (range && !isValidRange(range))
    throw new Error(`Couldn't download ${label}: invalid byte range ${JSON.stringify(range)}`);

  if (opts.expectedSha256 && existsSync(destPath) && (await sha256OfFile(destPath)) === opts.expectedSha256) {
    const size = statSync(destPath).size;
    return { bytes: size, totalBytes: size };
  }

  const partPath = `${destPath}.part`;
  // The file's ETag (or Last-Modified) when the partial file was started, and for which range: a
  // resume sends it as If-Range, so a file republished meanwhile comes back whole (and is
  // refused or restarted) instead of being spliced.
  const validatorPath = `${partPath}.validator`;
  const rangeKey = range ? `${range[0]}+${range[1]}` : "";
  let saved: { range: string; validator: string } | null;
  try {
    saved = JSON.parse(readFileSync(validatorPath, "utf8")) as { range: string; validator: string };
  } catch {
    saved = null;
  }
  const validator = saved?.range === rangeKey && saved.validator ? saved.validator : null;
  if (range && !validator) rmSync(partPath, { force: true });
  const existing = existsSync(partPath) ? statSync(partPath).size : 0;
  // A ranged part already whole can't be asked for more: start it over.
  if (range && existing >= range[1]) rmSync(partPath, { force: true });
  const resumeFrom = range && existing >= range[1] ? 0 : existing;
  let badAnswer = false;

  const ctl = new AbortController();
  const onOuterAbort = () => ctl.abort(opts.signal?.reason);
  if (opts.signal?.aborted) onOuterAbort();
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

  let downloaded = 0;
  let totalBytes: number | null = null;
  try {
    armStall(CONNECT_TIMEOUT_MS);
    const rangeHeader = range
      ? `bytes=${range[0] + resumeFrom}-${range[0] + range[1] - 1}`
      : resumeFrom > 0
        ? `bytes=${resumeFrom}-`
        : undefined;
    // Plain fetch, not httpFetch: its timeout bounds the whole body, which a large download on a
    // slow link can outlast. The stall timer here bounds silence instead.
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(rangeHeader ? { Range: rangeHeader } : {}),
        ...(resumeFrom > 0 && validator ? { "If-Range": validator } : {}),
      },
      redirect: "follow",
    });
    // A partial file that's already whole (the app quit while hashing it) can't be resumed: restart.
    if (res.status === 416 && !range && existing > 0) {
      await res.body?.cancel().catch(() => {});
      if (stallTimer) clearTimeout(stallTimer);
      rmSync(partPath, { force: true });
      rmSync(validatorPath, { force: true });
      return await downloadResumable(url, destPath, opts);
    }
    if (!res.ok || !res.body) throw new Error(`Couldn't download ${label}: HTTP ${res.status}`);
    if (
      range &&
      (res.status !== 206 || !res.headers.get("content-range")?.startsWith(`bytes ${range[0] + resumeFrom}-`))
    ) {
      badAnswer = true;
      await res.body.cancel().catch(() => {});
      throw new Error(
        `Couldn't download ${label}: the server didn't return the requested part of the file (HTTP ${res.status})`,
      );
    }

    // 206 means the server honored the Range request; anything else restarts from zero.
    const resumed = res.status === 206 && resumeFrom > 0;
    const offset = resumed ? resumeFrom : 0;
    if (!resumed) {
      const fresh = res.headers.get("etag") ?? res.headers.get("last-modified");
      if (fresh) writeFileSync(validatorPath, JSON.stringify({ range: rangeKey, validator: fresh }));
      else rmSync(validatorPath, { force: true });
    }
    const len = res.headers.get("content-length");
    totalBytes = range ? range[1] : len ? Number(len) + offset : null;
    downloaded = offset;
    if (totalBytes != null) await ensureRoom(destPath, totalBytes - offset);
    opts.onProgress?.(downloaded, totalBytes);
    armStall(stallMs);

    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        downloaded += chunk.length;
        if (range && downloaded > range[1]) {
          badAnswer = true;
          return cb(new Error(`Couldn't download ${label}: more than the expected ${range[1]} bytes`));
        }
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
    // Keep the partial file so the next attempt resumes, unless the answer itself was wrong.
    if (badAnswer || isDiskFull(err)) {
      rmSync(partPath, { force: true });
      rmSync(validatorPath, { force: true });
    }
    if (isDiskFull(err)) throw new DiskFullError(totalBytes ?? 0, 0, destPath);
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
  rmSync(validatorPath, { force: true });
  return { bytes: downloaded, totalBytes };
}
