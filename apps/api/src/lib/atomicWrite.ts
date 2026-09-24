import { renameSync, rmSync, writeFileSync } from "node:fs";

// Temp file + rename, so a crash mid-write leaves the old file intact instead of a truncated one.
export function writeFileAtomicSync(filePath: string, data: string): void {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, filePath);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
