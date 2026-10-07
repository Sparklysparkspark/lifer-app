import { useTranslation } from "react-i18next";
import type { ReactNode } from "react";
import { useMigrationStatus } from "../hooks/useMigrationStatus";
import InlineSpinner from "./InlineSpinner";
import ShowForAWhile from "./ShowForAWhile";

// How long the outcome stays up after a migration ends.
const OUTCOME_MS = 8000;

function Pill({ children }: { children: ReactNode }) {
  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-sm">
      {children}
    </div>
  );
}

// Fixed-position so it shows on every page while a long migration runs in the background.
export default function MigrationStatusIndicator() {
  const { t } = useTranslation();
  const { status } = useMigrationStatus();
  if (!status) return null;

  if (status.running) {
    const done = status.migrated + status.skipped + status.failed;
    return (
      <Pill>
        <InlineSpinner tone="ink" />
        <span>
          {status.cancelRequested
            ? t("status.migration.cancelling")
            : status.total != null
              ? t("status.migration.syncingProgress", { done, total: status.total })
              : t("status.migration.syncing")}
        </span>
      </Pill>
    );
  }

  if (status.finishedAt == null) return null;
  return (
    <ShowForAWhile key={status.finishedAt} since={status.finishedAt} forMs={OUTCOME_MS}>
      <Pill>
        {status.error ? (
          <span className="text-rose-700 dark:text-rose-400">{t("status.migration.failed", { error: status.error })}</span>
        ) : status.cancelled ? (
          <span>{t("status.migration.cancelled", { count: status.migrated })}</span>
        ) : (
          <span>{t("status.migration.done", { count: status.migrated })}</span>
        )}
      </Pill>
    </ShowForAWhile>
  );
}
