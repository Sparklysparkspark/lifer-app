// Resumable uploads (tus, /api/uploads/tus) for every imported file, so large files pass reverse
// proxies and dropped connections resume. The finished upload's id then goes to /uploads/*.
import { Upload, type DetailedError, type PreviousUpload } from "tus-js-client";
import { CLIENT_HEADER } from "../api/client";
import { formatBytes } from "./formatBytes";

const ENDPOINT = "/api/uploads/tus";
export const INITIAL_CHUNK_SIZE = 8 * 1024 * 1024;
export const MIN_CHUNK_SIZE = 256 * 1024;
const RETRY_DELAYS = [0, 1000, 3000, 5000, 10000];
// Fresh starts after the server lost an upload (404/410), before giving up.
const MAX_RESTARTS = 2;

// The chunk size that got through this session's proxy, so later files skip the 413s.
let sessionChunkSize = INITIAL_CHUNK_SIZE;

export function currentChunkSize(): number {
  return sessionChunkSize;
}

/** Half the chunk size, down to MIN_CHUNK_SIZE; null when it's already there. */
export function shrinkChunkSize(current: number): number | null {
  if (current <= MIN_CHUNK_SIZE) return null;
  return Math.max(MIN_CHUNK_SIZE, Math.floor(current / 2));
}

/** The size to retry with after a 413 at `current`: half of it, or smaller still when another
 *  upload this session already found a size that works. null when nothing smaller is left. */
export function nextChunkSize(current: number, session: number): number | null {
  const half = shrinkChunkSize(current);
  return half == null ? null : Math.min(half, Math.max(MIN_CHUNK_SIZE, session));
}

export type UploadFailure = "shrink" | "restart" | "too-large" | "fatal";

/** What to do about a failed tus request, from its method and status (null: no response). */
export function classifyFailure(method: string | null, status: number | null, online: boolean): UploadFailure {
  const m = method?.toUpperCase() ?? null;
  if (m === "POST" && status === 413) return "too-large";
  if (m === "PATCH" && status === 413) return "shrink";
  // A proxy rejecting a big body often drops the connection mid-send, so no status arrives at all.
  if (m === "PATCH" && !status && online) return "shrink";
  if ((m === "PATCH" || m === "HEAD") && (status === 404 || status === 410)) return "restart";
  return "fatal";
}

/** The uploadId other endpoints take: the last path segment of the upload URL. */
export function uploadIdFromUrl(url: string): string {
  const path = url.split(/[?#]/)[0].replace(/\/+$/, "");
  return path.slice(path.lastIndexOf("/") + 1);
}

// In memory rather than localStorage: a reloaded page can't get its File objects back anyway,
// but a retry of the same file in this session resumes instead of resending.
const storedUploads = new Map<string, PreviousUpload & { fingerprint: string }>();
const urlStorage = {
  async findAllUploads() {
    return [...storedUploads.values()];
  },
  async findUploadsByFingerprint(fingerprint: string) {
    return [...storedUploads.values()].filter((u) => u.fingerprint === fingerprint);
  },
  async removeUpload(key: string) {
    storedUploads.delete(key);
  },
  async addUpload(fingerprint: string, upload: PreviousUpload) {
    const key = `${fingerprint}::${Math.random().toString(36).slice(2)}`;
    storedUploads.set(key, { ...upload, urlStorageKey: key, fingerprint });
    return key;
  },
};
function forgetStoredUrl(url: string | null) {
  for (const [key, u] of storedUploads) if (u.uploadUrl === url) storedUploads.delete(key);
}
// Upload URLs some uploadFile call is sending right now; never resumed by a second one.
const activeUrls = new Set<string>();

function responseError(err: DetailedError): string | null {
  try {
    const body = err.originalResponse?.getBody();
    const parsed = body ? (JSON.parse(body) as { error?: unknown }) : null;
    return typeof parsed?.error === "string" ? parsed.error : null;
  } catch {
    return null;
  }
}

async function tooLargeMessage(file: File): Promise<string> {
  // The server advertises its cap on OPTIONS (Tus-Max-Size); a 413 on creation doesn't carry it.
  let max: number | null = null;
  try {
    const res = await fetch(ENDPOINT, { method: "OPTIONS", credentials: "same-origin", headers: { ...CLIENT_HEADER, "Tus-Resumable": "1.0.0" } });
    const header = Number(res.headers.get("Tus-Max-Size"));
    if (Number.isFinite(header) && header > 0) max = header;
  } catch {
    // Falls back to the message without a number.
  }
  return max
    ? `${file.name} is ${formatBytes(file.size)}, over this server's upload limit of ${formatBytes(max)}`
    : `${file.name} is over this server's upload size limit`;
}

/** Uploads `file` and resolves with its uploadId. Aborting the signal stops it and deletes the
 *  partial upload on the server. */
export function uploadFile(
  file: File,
  opts: { onProgress?: (sentBytes: number, totalBytes: number) => void; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let chunkSize = sessionChunkSize;
    let restarts = 0;
    let current: Upload | null = null;
    let settled = false;

    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      if (current?.url) activeUrls.delete(current.url);
      opts.signal?.removeEventListener("abort", onAbort);
      action();
    };
    const onAbort = () => {
      const upload = current;
      settle(() => reject(new DOMException("Upload cancelled", "AbortError")));
      if (upload) {
        forgetStoredUrl(upload.url);
        void upload.abort(true).catch(() => {});
      }
    };
    if (opts.signal?.aborted) return onAbort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const start = async (uploadUrl: string | null, resumePrevious: boolean) => {
      const upload: Upload = new Upload(file, {
        endpoint: ENDPOINT,
        uploadUrl,
        chunkSize,
        retryDelays: RETRY_DELAYS,
        // No body on creation, so a 413 there can only mean the file is over the server's cap.
        uploadDataDuringCreation: false,
        metadata: { filename: file.name, filetype: file.type },
        headers: { ...CLIENT_HEADER },
        urlStorage,
        storeFingerprintForResuming: true,
        removeFingerprintOnSuccess: true,
        // tus-js-client's own rule (retry 5xx, network errors, 409 and 423), except a PATCH 413,
        // which retrying at the same size can't fix.
        onShouldRetry: (err) => {
          const status = err.originalResponse?.getStatus() ?? 0;
          if (status === 413) return false;
          const retryable = status < 400 || status >= 500 || status === 409 || status === 423;
          return retryable && (typeof navigator === "undefined" || navigator.onLine !== false);
        },
        onUploadUrlAvailable: () => {
          if (upload.url) activeUrls.add(upload.url);
        },
        onProgress: (sent, total) => {
          if (!settled) opts.onProgress?.(sent, total);
        },
        onSuccess: () => {
          if (current !== upload) return;
          const url = upload.url;
          forgetStoredUrl(url);
          settle(() => (url ? resolve(uploadIdFromUrl(url)) : reject(new Error("Upload failed"))));
        },
        onError: (err) => {
          if (current !== upload || settled) return;
          void handleError(upload, err as DetailedError);
        },
      });
      current = upload;
      if (resumePrevious) {
        const previous = (await upload.findPreviousUploads().catch(() => [])).find((p) => p.uploadUrl && !activeUrls.has(p.uploadUrl));
        if (previous) upload.resumeFromPreviousUpload(previous);
      }
      if (!settled) upload.start();
    };

    const handleError = async (upload: Upload, err: DetailedError) => {
      const method = err.originalRequest?.getMethod() ?? null;
      const status = err.originalResponse?.getStatus() || null;
      const kind = classifyFailure(method, status, typeof navigator === "undefined" || navigator.onLine !== false);
      if (upload.url) activeUrls.delete(upload.url);
      if (kind === "shrink" && upload.url) {
        const next = nextChunkSize(chunkSize, sessionChunkSize);
        if (next) {
          chunkSize = next;
          sessionChunkSize = Math.min(sessionChunkSize, next);
          // The same upload URL: tus asks the server how much it has and carries on from there.
          return start(upload.url, false);
        }
      }
      if (kind === "restart" && restarts < MAX_RESTARTS) {
        restarts++;
        forgetStoredUrl(upload.url);
        return start(null, false);
      }
      if (kind === "too-large") {
        const message = await tooLargeMessage(file);
        return settle(() => reject(new Error(message)));
      }
      const message = responseError(err) ?? (status ? `Upload failed (${status})` : "Upload failed: the connection dropped");
      settle(() => reject(new Error(message)));
    };

    void start(null, true).catch((err) => settle(() => reject(err instanceof Error ? err : new Error("Upload failed"))));
  });
}

/** Deletes a finished upload that won't be imported (a skipped duplicate, a removed row). Best-effort:
 *  the server drops it after two hours anyway. */
export function discardUpload(uploadId: string): void {
  void fetch(`${ENDPOINT}/${encodeURIComponent(uploadId)}`, {
    method: "DELETE",
    credentials: "same-origin",
    headers: { ...CLIENT_HEADER, "Tus-Resumable": "1.0.0" },
  }).catch(() => {});
}
