import { closeSync, fsyncSync, openSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

// Temp file + rename, so a crash mid-write leaves the old file intact instead of a truncated one.
// The temp file is flushed to disk before the rename, so a power cut can't leave the new name on
// an empty file, and the folder after it, so the rename itself survives one.
export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  syncDirectory(path.dirname(filePath));
}

// Windows can't open a folder for fsync, and NTFS journals the rename anyway. Elsewhere a
// filesystem that refuses it (some network shares) only loses the extra guarantee: the file is
// already written.
function syncDirectory(dir: string): void {
  if (process.platform === "win32") return;
  let fd: number | null = null;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // best effort, see above
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
