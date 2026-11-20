import type { ReactNode } from "react";
import Button from "./Button";
import i18n from "../i18n";
import { connectionMessage } from "../lib/userMessage";
import { offlineBannerShown } from "./OfflineBanner";

// The shared "nothing here" state: icon, heading, description, and an optional next step. A page's
// own empty state is full size; `compact` is for a panel or a section inside a page.
// One rule for the action: when the page header already offers it (New album), leave it out here.
// A load failure passes `error`: offline, unreachable or slow then replaces the description, so
// every "Couldn't load" says why in the same words.
export default function EmptyState({
  icon,
  title,
  description,
  action,
  secondaryAction,
  compact = false,
  error,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: { label: string; onClick: () => void };
  /** A quieter alternative beside the action, for a page with nothing else on it. */
  secondaryAction?: { label: string; onClick: () => void };
  compact?: boolean;
  /** What a failed load threw. */
  error?: unknown;
}) {
  const bannerUp = offlineBannerShown.use();
  const reason = error != null ? connectionMessage(error) : null;
  // The offline banner already says it; the strongest single statement wins.
  const text = reason && bannerUp && reason === i18n.t("errors.user.offline") ? null : (reason ?? description);
  return (
    <div
      className={`flex flex-col items-center justify-center text-center ${compact ? "gap-1.5 py-8" : "gap-3 py-24"}`}
    >
      {icon && !compact && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted">{icon}</div>
      )}
      {/* A compact one sits inside a section that has its own heading, so its title is plain text. */}
      {compact ? (
        <p className="text-callout font-medium text-ink">{title}</p>
      ) : (
        <h2 className="text-title-3 font-semibold text-ink">{title}</h2>
      )}
      {text && (
        <p className={compact ? "max-w-md text-subheadline text-muted" : "max-w-md text-body text-muted"}>{text}</p>
      )}
      {(action || secondaryAction) && (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action && (
            <Button variant={compact ? "secondary" : "primary"} size={compact ? "sm" : "md"} onClick={action.onClick}>
              {action.label}
            </Button>
          )}
          {secondaryAction && (
            <Button variant="secondary" size={compact ? "sm" : "md"} onClick={secondaryAction.onClick}>
              {secondaryAction.label}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
