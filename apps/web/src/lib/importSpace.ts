// The drives an import writes to (the server's check, apps/api/src/lib/importSpace.ts): with room
// the import runs as usual, when tight it checks and imports one photo at a time, and when
// critical it pauses until the user frees space and presses Continue.
import { api, ApiError } from "../api/client";

export type SpaceTier = "ok" | "tight" | "critical";
export interface ImportSpace {
  tier: SpaceTier;
  free: number | null;
  toFree: number;
}

const UNKNOWN: ImportSpace = { tier: "ok", free: null, toFree: 0 };

/** A drive too full for the work refused it (507 disk_full). */
export const isDiskFullError = (err: unknown) =>
  err instanceof ApiError && (err.status === 507 || err.code === "disk_full");

/** Room for `files` photos of `bytes` still to go. A failed check counts as room: the server
 *  still refuses work it has no room for. */
export const checkImportSpace = (files: number, bytes: number): Promise<ImportSpace> =>
  api.post("/uploads/space", { files, bytes }).catch(() => UNKNOWN);
