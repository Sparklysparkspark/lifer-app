// Where uploads land before they are imported: temp files, the inspect staging area and resumable
// (tus) uploads. Kept on the library's drive when possible, so filing an upload into the library
// is a rename instead of a second full copy of a multi-gigabyte file.
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { APP_DATA_DIR, ORIGINALS_DIR, UPLOAD_WORK_DIR } from "@lifer/core/config.js";

// A dot folder, which every library scan skips (library/reimport.ts, trips/scan.ts).
export const LIBRARY_UPLOAD_DIR_NAME = ".lifer-uploads";

let resolved: string | null = null;

function deviceOf(dir: string): number | null {
  try {
    mkdirSync(dir, { recursive: true });
    return statSync(dir).dev;
  } catch {
    return null;
  }
}

/** The upload work folder: LIFER_UPLOAD_WORK_DIR, else app data when it shares the library's
 *  drive, else a hidden folder inside the library. */
export function uploadWorkDir(): string {
  if (resolved) return resolved;
  if (UPLOAD_WORK_DIR) {
    resolved = path.resolve(UPLOAD_WORK_DIR);
    return resolved;
  }
  const appData = path.join(APP_DATA_DIR, "uploads");
  const appDev = deviceOf(appData);
  const libraryDev = deviceOf(ORIGINALS_DIR);
  resolved =
    appDev !== null && libraryDev !== null && appDev !== libraryDev
      ? path.join(ORIGINALS_DIR, LIBRARY_UPLOAD_DIR_NAME)
      : appData;
  return resolved;
}

/** Scratch files for one request (removed when it ends). */
export const uploadTempDir = () => path.join(uploadWorkDir(), "tmp");
/** Checked photos kept for their import (lib/stagedUploads.ts). */
export const uploadStagingDir = () => path.join(uploadWorkDir(), "staging");
/** Resumable uploads (lib/tusUploads.ts). */
export const tusUploadDir = () => path.join(uploadWorkDir(), "tus");
