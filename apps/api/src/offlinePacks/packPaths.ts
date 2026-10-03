// Guards for reading files out of an extracted (untrusted) pack archive.
import { realpathSync, type Stats } from "node:fs";
import path from "node:path";

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
  if (real !== root && !real.startsWith(root + path.sep)) return null;
  return real;
}
