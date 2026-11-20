// Wording for the Sync rows in Settings > Server (SyncSettings.tsx), kept apart so the page
// module only exports a component. Plain words: what is waiting, why, and what the last run did.
import type { JobStatus } from "@lifer/shared";
import i18n from "../../i18n";
import { formatDate, formatNumber } from "../../lib/format";

export interface SyncStatus {
  linked: boolean;
  serverUrl: string | null;
  unpushed: number;
  /** What's waiting for the server, by what the user sees. */
  waiting: { photos: number; albums: number; trips: number };
  /** The link points at a server this install hasn't synced with: waiting for the user's answer. */
  serverChanged: boolean;
  derivative: "thumb" | "medium";
  packs: JobStatus;
  mirror: JobStatus<{
    applied: number;
    removed: number;
    skippedSpecies: number;
    userSpecies: number;
    library: number;
  }>;
  push: JobStatus<{
    pushed: number;
    uploaded: number;
    failed: number;
    unknownSpecies: number;
    conflicts: number;
    userSpecies: number;
    library: number;
  }>;
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, options);
const when = (ms: number | null) => (ms ? formatDate(ms, "dateTime") : t("settings.sync.never"));

/** "Up to date", or how many changes are waiting. */
export function describeWaiting(count: number): string {
  return count > 0 ? t("settings.sync.waiting", { count }) : t("settings.sync.upToDate");
}

/** Why something is still waiting, or null when nothing is. */
export function describeReason(s: SyncStatus): string | null {
  if (s.unpushed === 0) return null;
  if (s.push.running) return t("settings.sync.reason.running");
  if (s.serverChanged) return t("settings.sync.reason.serverChanged");
  if (s.push.error) return t("settings.sync.reason.failed", { error: s.push.error });
  return t("settings.sync.reason.later");
}

/** What the last send of photos did. */
export function describePush(s: SyncStatus): string {
  if (s.push.running)
    return t("settings.sync.sending", {
      done: formatNumber(s.push.processed ?? 0),
      total: s.push.total == null ? "?" : formatNumber(s.push.total),
    });
  const r = s.push.result;
  if (s.push.error) return t("settings.sync.lastStopped", { date: when(s.push.finishedAt), error: s.push.error });
  if (!r) return t("settings.sync.nothingSent");
  const last = t("settings.sync.lastSent", {
    date: when(s.push.finishedAt),
    uploaded: r.uploaded,
    updated: r.pushed,
    failed: r.failed,
  });
  return r.conflicts > 0 ? `${last} ${t("settings.sync.conflicts", { count: r.conflicts })}` : last;
}

/** What the last send of albums and trips did. */
export function describeLibraryPush(s: SyncStatus): string {
  const r = s.push.result;
  if (s.push.running || !r) return t("settings.sync.libraryNeverSent");
  return t("settings.sync.libraryLastSent", { date: when(s.push.finishedAt), count: r.library ?? 0 });
}

/** What the last copy of the server's collection did. */
export function describeMirror(s: SyncStatus): string {
  if (s.mirror.running) return t("settings.sync.copying", { done: formatNumber(s.mirror.processed ?? 0) });
  const r = s.mirror.result;
  if (!r) return t("settings.sync.notCopied");
  return t("settings.sync.lastCopied", {
    date: when(s.mirror.finishedAt),
    photos: r.applied,
    marks: r.userSpecies,
    library: r.library ?? 0,
  });
}
