import type { ReactNode } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { JobStatus } from "@lifer/shared";
import FormMessage from "./FormMessage";
import ProgressBar from "./ProgressBar";
import { formatBytes } from "../lib/format";
import Button from "./Button";

export interface PhaseConfig {
  label: string;
  // Which counter drives the text and bar. "auto" uses bytes when the job reports them, else
  // processed/total, else an indeterminate bar.
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
  | "running"
  | "phase"
  | "downloadedBytes"
  | "totalBytes"
  | "processed"
  | "total"
  | "currentItem"
  | "error"
  | "cancelRequested"
  | "cancelled"
>;

function describe(status: JobProgressStatus, phases: PhaseLabels | undefined, fallbackLabel: string, t: TFunction) {
  const raw = status.phase ? phases?.[status.phase] : undefined;
  const config: PhaseConfig = typeof raw === "string" ? { label: raw } : (raw ?? { label: fallbackLabel });
  const mode = config.progress ?? "auto";
  const hasBytes = status.downloadedBytes != null;
  const hasCount = status.total != null && status.processed != null;
  const useBytes = mode === "bytes" || (mode === "auto" && hasBytes);
  const useCount = !useBytes && (mode === "count" || (mode === "auto" && hasCount));

  let head = config.label;
  if (config.showItem && status.currentItem) head += ` ${status.currentItem}`;
  let amount = "";
  let fraction: number | null = null;
  if (useBytes && hasBytes) {
    amount = status.totalBytes
      ? t("ui.job.ofTotal", { done: formatBytes(status.downloadedBytes!), total: formatBytes(status.totalBytes) })
      : formatBytes(status.downloadedBytes!);
    if (status.totalBytes) fraction = status.downloadedBytes! / status.totalBytes;
  } else if (useCount && hasCount) {
    // Strings, so ICU doesn't add digit grouping the count never had.
    const of = t("ui.job.ofTotal", { done: String(status.processed), total: String(status.total) });
    amount = `(${of}${config.countNoun ? ` ${config.countNoun}` : ""})`;
    if (status.total! > 0) fraction = status.processed! / status.total!;
  }
  const text = amount ? `${head} ${amount}` : head;
  return { head, amount, text, fraction: fraction == null ? null : Math.max(0, Math.min(1, fraction)) };
}

// Shared progress UI for background jobs: a bar (indeterminate when progress is unknown), a phase
// label, optional Cancel, and error/cancelled states with optional Retry. Renders nothing when idle or done.
export default function JobProgress({
  status,
  phases,
  fallbackLabel,
  detail,
  onCancel,
  cancelling = false,
  onRetry,
  retryLabel,
  error,
  errorPrefix,
  showCancelled = true,
  compact = false,
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
  // One line: the item (truncated), its amount and the detail, then a thin bar.
  compact?: boolean;
}) {
  const { t } = useTranslation();
  if (status?.running) {
    const { head, amount, text, fraction } = describe(status, phases, fallbackLabel ?? t("ui.job.working"), t);
    const stopping = cancelling || status.cancelRequested;
    const cancelButton = onCancel && (
      <Button variant="secondary" size="sm" onClick={onCancel} disabled={stopping} className="shrink-0">
        {t("common.cancel")}
      </Button>
    );
    const bar = (
      // Keyed by item too: per-pack byte counts restart at 0 within one "downloading" phase.
      <ProgressBar
        value={fraction}
        size={compact ? "xs" : "sm"}
        resetKey={`${status.phase ?? ""}:${status.currentItem ?? ""}`}
        label={text}
      />
    );
    if (compact)
      return (
        <div className="space-y-1.5">
          <div className="flex items-center gap-3 text-callout text-muted">
            <p className="min-w-0 flex-1 truncate">{stopping ? t("ui.job.cancelling") : head}</p>
            {!stopping && amount && <span className="shrink-0 tabular-nums">{amount}</span>}
            {detail && <span className="shrink-0 text-footnote">{detail}</span>}
            {cancelButton}
          </div>
          {bar}
        </div>
      );
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="min-w-0 truncate text-callout text-muted">{stopping ? t("ui.job.cancelling") : text}</p>
          {cancelButton}
        </div>
        {bar}
        {detail && <p className="text-footnote text-muted">{detail}</p>}
      </div>
    );
  }

  const message = error ?? status?.error ?? null;
  if (message) {
    return (
      <div className="space-y-2">
        <FormMessage error={errorPrefix ? `${errorPrefix}: ${message}` : message} />
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry} className="shrink-0">
            {retryLabel ?? t("common.retry")}
          </Button>
        )}
      </div>
    );
  }

  if (status?.cancelled && showCancelled) {
    return (
      <div className="flex items-center gap-3">
        <p className="text-callout text-muted">{t("ui.job.cancelled")}</p>
        {onRetry && (
          <Button variant="secondary" size="sm" onClick={onRetry} className="shrink-0">
            {retryLabel ?? t("common.retry")}
          </Button>
        )}
      </div>
    );
  }

  return null;
}
