// Guards for fetching packs and reading files out of an extracted (untrusted) pack archive.
import { realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { PACK_INDEX_URL } from "@lifer/core/config.js";
import { isWithin } from "@lifer/core/lib/pathContainment.js";

// Pack, shard and photo store urls come from the fetched index JSON, so a tampered index could aim
// this server's fetch at an internal service. They must share the index's origin.
export function assertTrustedPackUrl(url: string): void {
  if (!PACK_INDEX_URL) throw new Error("No pack index is configured for this instance yet");
  const packOrigin = new URL(url).origin;
  const indexOrigin = new URL(PACK_INDEX_URL).origin;
  if (packOrigin !== indexOrigin) {
    throw new Error(`Refusing to fetch a pack from an untrusted origin: ${packOrigin}`);
  }
}

// Only plain files and folders are extracted. A symlink or hardlink entry could otherwise point
// outside the extract dir, and the later copy would follow it.
export function isSafePackEntry(_entryPath: string, entry: { type?: string } | Stats): boolean {
  if (!("type" in entry) || typeof entry.type !== "string") return false;
  return entry.type === "File" || entry.type === "OldFile" || entry.type === "Directory";
}

// Manifest paths come from an untrusted archive, so "../", absolute paths and symlinks must not
// escape `dir`. Both sides are realpath'd; returns null for anything outside `dir` or missing.
export function resolveWithinDir(dir: string, relativePath: string): string | null {
  let root: string;
  let real: string;
  try {
    root = realpathSync(dir);
    real = realpathSync(path.resolve(root, relativePath));
  } catch {
    return null;
  }
  if (!isWithin(root, real)) return null;
  return real;
}
