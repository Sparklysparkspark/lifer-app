import { useMigrationStatus } from "../hooks/useMigrationStatus";
import { pluralize } from "../lib/pluralize";
import InlineSpinner from "./InlineSpinner";

// Fixed-position so it shows on every page while a long migration runs in the background.
export default function MigrationStatusIndicator() {
  const { status } = useMigrationStatus();
  if (!status) return null;

  const justFinished = !status.running && status.finishedAt != null && Date.now() - status.finishedAt < 8000;
  if (!status.running && !justFinished) return null;
  const done = status.migrated + status.skipped + status.failed;

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-xs text-muted shadow-sm">
      {status.running ? (
        <>
          <InlineSpinner tone="ink" />
          <span>
            {status.cancelRequested
              ? "Cancelling sync…"
              : status.total != null
                ? `Syncing to server (${done} of ${status.total})`
                : "Syncing to server…"}
          </span>
        </>
      ) : status.error ? (
        <span className="text-rose-700 dark:text-rose-400">Sync failed: {status.error}</span>
      ) : status.cancelled ? (
        <span>Sync cancelled after {pluralize(status.migrated, "photo")}</span>
      ) : (
        <span>Synced {pluralize(status.migrated, "photo")} to server</span>
      )}
    </div>
  );
}
