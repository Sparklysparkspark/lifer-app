import type { ReactNode } from "react";
import type { JobStatus } from "@lifer/shared";
import FormMessage from "./FormMessage";
import { formatBytes } from "../lib/formatBytes";

export interface PhaseConfig {
  label: string;
  // Which counter drives the text and bar. "auto" uses bytes when the job reports them, else
  // processed/total, else just a spinner.
  progress?: "auto" | "bytes" | "count" | "none";
  // Noun for the count, e.g. "tables" gives "(4 of 11 tables)".
  countNoun?: string;
  // Append currentItem after the label, e.g. "Applying species".
  showItem?: boolean;
}

export type PhaseLabels = Record<string, string | PhaseConfig>;

// The subset of JobStatus this renders. Lets callers pass a hand-built status too (the app
// updater's download progress comes from Tauri events, not a status endpoint).
export type JobProgressStatus = Pick<
  JobStatus,
  "running" | "phase" | "downloadedBytes" | "totalBytes" | "processed" | "total" | "currentItem" | "error" | "cancelRequested" | "cancelled"
>;

const smallButtonClass = "shrink-0 rounded-md border border-line px-3 py-1 text-xs text-ink hover:bg-surface-muted disabled:opacity-50";

function describe(status: JobProgressStatus, phases: PhaseLabels | undefined, fallbackLabel: string) {
  const raw = status.phase ? phases?.[status.phase] : undefined;
  const config: PhaseConfig = typeof raw === "string" ? { label: raw } : (raw ?? { label: fallbackLabel });
  const mode = config.progress ?? "auto";
  const hasBytes = status.downloadedBytes != null;
  const hasCount = status.total != null && status.processed != null;
  const useBytes = mode === "bytes" || (mode === "auto" && hasBytes);
  const useCount = !useBytes && (mode === "count" || (mode === "auto" && hasCount));

  let text = config.label;
  if (config.showItem && status.currentItem) text += ` ${status.currentItem}`;
  let fraction: number | null = null;
  if (useBytes && hasBytes) {
    text += status.totalBytes
      ? ` ${formatBytes(status.downloadedBytes!)} of ${formatBytes(status.totalBytes)}`
      : ` ${formatBytes(status.downloadedBytes!)}`;
    if (status.totalBytes) fraction = status.downloadedBytes! / status.totalBytes;
  } else if (useCount && hasCount) {
    text += ` (${status.processed} of ${status.total}${config.countNoun ? ` ${config.countNoun}` : ""})`;
    if (status.total! > 0) fraction = status.processed! / status.total!;
  }
  return { text, fraction: fraction == null ? null : Math.max(0, Math.min(1, fraction)) };
}

// Shared progress UI for every background job: a determinate bar when the job reports enough
// to compute one (a spinner otherwise), a phase label, optional Cancel, and the finished
// error/cancelled state with an optional Retry. Renders nothing for an idle, successful job;
// callers show their own success message.
export default function JobProgress({
  status,
  phases,
  fallbackLabel = "Working…",
  detail,
  onCancel,
  cancelling = false,
  onRetry,
  retryLabel = "Retry",
  error,
  errorPrefix,
  showCancelled = true,
}: {
  status: JobProgressStatus | null;
  phases?: PhaseLabels;
  fallbackLabel?: string;
  // Extra line under the label (e.g. which pack is being worked on).
  detail?: ReactNode;
  onCancel?: () => void;
  cancelling?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  // An error from outside the job itself (e.g. the start request failed). Shown with the job's own.
  error?: string | null;
  errorPrefix?: string;
  showCancelled?: boolean;
}) {
  if (status?.running) {
    const { text, fraction } = describe(status, phases, fallbackLabel);
    const stopping = cancelling || status.cancelRequested;
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="flex min-w-0 items-center gap-2 text-sm text-muted">
            {fraction == null && (
              <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-accent/40 border-t-accent" />
            )}
            <span className="min-w-0 truncate">{stopping ? "Cancelling…" : text}</span>
          </p>
          {onCancel && (
            <button type="button" onClick={onCancel} disabled={stopping} className={smallButtonClass}>
              Cancel
            </button>
          )}
        </div>
        {fraction != null && (
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-muted">
            <div className="h-full bg-accent transition-all" style={{ width: `${Math.round(fraction * 100)}%` }} />
          </div>
        )}
        {detail && <p className="text-xs text-muted">{detail}</p>}
      </div>
    );
  }

  const message = error ?? status?.error ?? null;
  if (message) {
    return (
      <div className="space-y-2">
        <FormMessage error={errorPrefix ? `${errorPrefix}: ${message}` : message} />
        {onRetry && (
          <button type="button" onClick={onRetry} className={smallButtonClass}>
            {retryLabel}
          </button>
        )}
      </div>
    );
  }

  if (status?.cancelled && showCancelled) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted">Cancelled.</p>
        {onRetry && (
          <button type="button" onClick={onRetry} className={smallButtonClass}>
            {retryLabel}
          </button>
        )}
      </div>
    );
  }

  return null;
}
