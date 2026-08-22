import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const RAW_DIR = path.join(__dirname, "..", "..", "..", "data", "raw");
export const BUILD_DIR = path.join(__dirname, "..", "..", "..", "data", "build");

/** Downloads `url` into data/raw/<source>/<filename> unless already cached. Returns the local path. */
export async function fetchCached(source: string, filename: string, url: string): Promise<string> {
  const dir = path.join(RAW_DIR, source);
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, filename);
  if (existsSync(dest)) {
    console.log(`[${source}] using cached ${filename}`);
    return dest;
  }
  console.log(`[${source}] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`[${source}] fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(dest, buf);
  return dest;
}

export function readCachedJson<T>(dest: string): T {
  return JSON.parse(readFileSync(dest, "utf-8")) as T;
}
