// A small tus 1.0 client for sending a file from disk to another Lifer server's /api/uploads/tus
// (the desktop-to-server migration). Each PATCH body is a slice of a file-backed Blob, streamed
// from disk as it's sent, so memory stays flat for a file of any size.
import { openAsBlob } from "node:fs";
import { stat } from "node:fs/promises";
import type { Agent } from "undici";
import { viaDispatcher } from "./outboundGuard.js";

export const TUS_INITIAL_CHUNK_SIZE = 8 * 1024 * 1024;
export const TUS_MIN_CHUNK_SIZE = 256 * 1024;

export interface TusClientOptions {
  /** e.g. "https://lifer.example.com/api/uploads/tus" */
  endpoint: string;
  /** Auth for every request (cookie or API key, plus x-lifer-client). */
  headers: Record<string, string>;
  signal?: AbortSignal;
  /** Shared across files, so after one file finds the size a proxy allows, the rest start there. */
  chunkState?: { size: number };
  initialChunkSize?: number;
  minChunkSize?: number;
  requestTimeoutMs?: number;
  /** Waits before each retry of a failed request that isn't fixed by a smaller chunk. */
  retryDelaysMs?: number[];
  /** Connections go through this (lib/outboundGuard.ts guardedDispatcher), the upload URL the
   *  server answers with included. */
  dispatcher?: Agent;
}

export class TusClientError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

const b64 = (v: string) => Buffer.from(v, "utf8").toString("base64");
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (ms <= 0) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), reject(signal.reason)), { once: true });
  });

/** Uploads `filePath` and resolves with its uploadId (the last segment of the upload URL). */
export async function tusUploadFile(
  filePath: string,
  meta: { filename: string; filetype?: string | null },
  opts: TusClientOptions,
): Promise<string> {
  const minChunk = opts.minChunkSize ?? TUS_MIN_CHUNK_SIZE;
  const chunkState = opts.chunkState ?? { size: opts.initialChunkSize ?? TUS_INITIAL_CHUNK_SIZE };
  const retryDelays = opts.retryDelaysMs ?? [1000, 3000, 10_000];
  const timeoutMs = opts.requestTimeoutMs ?? 5 * 60_000;
  const size = (await stat(filePath)).size;
  const blob = await openAsBlob(filePath);
  const base = { ...opts.headers, "Tus-Resumable": "1.0.0" };
  const request = (url: string, init: RequestInit) =>
    fetch(url, {
      ...init,
      ...viaDispatcher(opts.dispatcher),
      signal: opts.signal
        ? AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
    });

  const metadata = [
    `filename ${b64(meta.filename)}`,
    ...(meta.filetype ? [`filetype ${b64(meta.filetype)}`] : []),
  ].join(",");
  const created = await request(opts.endpoint, {
    method: "POST",
    headers: { ...base, "Upload-Length": String(size), "Upload-Metadata": metadata },
  });
  if (created.status === 413) throw new TusClientError(`${meta.filename} is over the server's upload size limit`, 413);
  const location = created.headers.get("location");
  if (created.status !== 201 || !location)
    throw new TusClientError(`Couldn't start the upload (${created.status})`, created.status);
  const uploadUrl = new URL(location, opts.endpoint).toString();

  // The server's offset, asked after anything went wrong, so the next PATCH carries on from it.
  const headOffset = async (): Promise<number> => {
    const res = await request(uploadUrl, { method: "HEAD", headers: base });
    const offset = Number(res.headers.get("upload-offset"));
    if (res.status >= 400 || !Number.isFinite(offset))
      throw new TusClientError(`The server lost the upload (${res.status})`, res.status);
    return offset;
  };

  let offset = 0;
  let retries = 0;
  try {
    while (offset < size) {
      opts.signal?.throwIfAborted();
      const end = Math.min(offset + chunkState.size, size);
      let status: number | null = null;
      try {
        const res = await request(uploadUrl, {
          method: "PATCH",
          headers: { ...base, "Upload-Offset": String(offset), "Content-Type": "application/offset+octet-stream" },
          body: blob.slice(offset, end),
        });
        status = res.status;
        await res.arrayBuffer().catch(() => {});
        if (status === 204) {
          const next = Number(res.headers.get("upload-offset"));
          // A missing or stalled offset would end the loop early or resend the same chunk forever.
          if (!Number.isSafeInteger(next) || next <= offset || next > size) {
            throw new TusClientError(
              `The server reported an unexpected upload offset (${res.headers.get("upload-offset")})`,
              status,
            );
          }
          offset = next;
          retries = 0;
          continue;
        }
      } catch (err) {
        if (opts.signal?.aborted || err instanceof TusClientError) throw err;
        // No response at all: a proxy over its body limit often just drops the connection.
      }
      if (status === 404 || status === 410) throw new TusClientError("The server lost the upload part way", status);
      const tooBig = status === 413 || status === null;
      if (tooBig && chunkState.size > minChunk) {
        chunkState.size = Math.max(minChunk, Math.floor(chunkState.size / 2));
      } else if (status === 413) {
        throw new TusClientError(`The server refused even ${Math.round(minChunk / 1024)} KB pieces (413)`, 413);
      } else if (status !== null && status < 500 && status !== 409 && status !== 423) {
        throw new TusClientError(`Upload failed (${status})`, status);
      } else {
        if (retries >= retryDelays.length)
          throw new TusClientError(
            status ? `Upload failed (${status})` : "Upload failed: the connection dropped",
            status,
          );
        await sleep(retryDelays[retries++], opts.signal);
      }
      offset = await headOffset();
    }
  } catch (err) {
    // Best effort: the server drops an abandoned upload after two hours anyway.
    void fetch(uploadUrl, {
      method: "DELETE",
      headers: base,
      ...viaDispatcher(opts.dispatcher),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => {});
    throw err;
  }
  return new URL(uploadUrl).pathname.replace(/\/+$/, "").split("/").pop()!;
}
