// A dismissed low-space notice stays hidden per drive until the drive gets much fuller, falls
// under the critical line, or a week passes. Kept on this device in localStorage.
import type { ImportSpace } from "./importSpace";

const KEY = "lifer:lowSpaceDismissed";
export const DISMISS_DAYS_MS = 7 * 24 * 3600_000;
export const CRITICAL_LINE = 5e9;

interface Dismissal {
  free: number;
  at: number;
}
const volumeKey = (s: ImportSpace) => String(s.volume ?? "default");

function readAll(): Record<string, Dismissal> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    return raw && typeof raw === "object" ? (raw as Record<string, Dismissal>) : {};
  } catch {
    return {};
  }
}

export function dismissLowSpace(space: ImportSpace, now = Date.now()): void {
  if (space.free === null) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...readAll(), [volumeKey(space)]: { free: space.free, at: now } }));
  } catch {
    // Storage blocked: the caller still hides it until this page reloads.
  }
}

/** Whether the notice should show: a tight or critical drive that was never dismissed, or whose
 *  dismissal lapsed (a week, half the dismissed free space, or newly under the critical line). */
export function shouldShowLowSpace(space: ImportSpace, now = Date.now()): boolean {
  if (space.tier === "ok" || space.free === null) return false;
  const d = readAll()[volumeKey(space)];
  if (!d || typeof d.free !== "number" || typeof d.at !== "number") return true;
  return (
    now - d.at > DISMISS_DAYS_MS || space.free < d.free / 2 || (d.free >= CRITICAL_LINE && space.free < CRITICAL_LINE)
  );
}
