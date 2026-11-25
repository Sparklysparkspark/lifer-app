// Files the user picked in the desktop app's own Choose files dialog. The desktop shell reports
// them with LIFER_SHELL_TOKEN, a per-launch secret it never hands to a page, so page scripts can't
// add a path (docs/plans/move-picked-files.md). A picked file may be read for the import and, with
// "Move photos into my library" on, go to the Trash once the library's copy is proven
// (sourceTrash.ts). Held in memory: picks end with the launch, or after a day.
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { canonicalPath } from "@lifer/core/lib/pathContainment.js";

export const SHELL_TOKEN_HEADER = "x-lifer-shell-token";
const KEEP_MS = 24 * 60 * 60 * 1000;
const picked = new Map<string, number>();

/** Whether the request carries the desktop shell's own secret. */
export function isShellRequest(
  headers: Record<string, string | string[] | undefined>,
  token = process.env.LIFER_SHELL_TOKEN,
): boolean {
  const header = headers[SHELL_TOKEN_HEADER];
  if (!token || typeof header !== "string") return false;
  const a = Buffer.from(header);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function rememberPicked(paths: string[], now = Date.now()): void {
  for (const [p, until] of picked) if (until <= now) picked.delete(p);
  for (const p of paths) if (path.isAbsolute(p)) picked.set(canonicalPath(p), now + KEEP_MS);
}

export function wasPicked(file: string, now = Date.now()): boolean {
  return path.isAbsolute(file) && (picked.get(canonicalPath(file)) ?? 0) > now;
}
