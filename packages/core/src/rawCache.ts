import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { httpFetch } from "./lib/http.js";
import { log } from "./lib/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = path.join(__dirname, "..", "..", "..", "data", "raw");
export const BUILD_DIR = path.join(__dirname, "..", "..", "..", "data", "build");

// Bounds the whole download, body included; generous since some sources are hundreds of MB.
const DOWNLOAD_TIMEOUT_MS = 60 * 60 * 1000;

export interface FetchCachedOptions {
  /** Cache root instead of the repo's data/raw (the API passes one under CACHE_DIR). */
  dir?: string;
  /** Refuse bodies larger than this. */
  maxBytes?: number;
}

/** Downloads `url` into <dir>/<source>/<filename> unless already cached. Returns the local path. */
export async function fetchCached(
  source: string,
  filename: string,
  url: string,
  opts: FetchCachedOptions = {},
): Promise<string> {
  const dir = path.join(opts.dir ?? RAW_DIR, source);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  if (existsSync(dest)) {
    log.info(`[${source}] using cached ${filename}`);
    return dest;
  }
  log.info(`[${source}] downloading ${url}`);
  const res = await httpFetch(url, { timeoutMs: DOWNLOAD_TIMEOUT_MS });
  if (!res.ok) {
    throw new Error(`[${source}] fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const tooBig = (bytes: number) => opts.maxBytes != null && bytes > opts.maxBytes;
  if (tooBig(Number(res.headers.get("content-length") ?? 0))) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`[${source}] ${filename} is larger than ${opts.maxBytes} bytes (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (tooBig(buf.length)) throw new Error(`[${source}] ${filename} is larger than ${opts.maxBytes} bytes (${url})`);
  // Rename into place so a killed run never leaves a truncated file that looks cached.
  writeFileSync(`${dest}.part`, buf);
  renameSync(`${dest}.part`, dest);
  return dest;
}
