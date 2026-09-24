import { useMigrationStatus } from "../hooks/useMigrationStatus";

// Fixed-position so it shows up on every page, not just Settings (where the migration is
// started), since the migration can run for a long time in the background and the user may
// navigate away while it's still going.
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
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-line border-t-ink" />
          <span>
            {status.cancelRequested
              ? "Cancelling sync…"
              : status.total != null
                ? `Syncing to server (${done} of ${status.total})`
                : "Syncing to server…"}
          </span>
        </>
      ) : status.error ? (
        <span className="text-red-600">Sync failed: {status.error}</span>
      ) : status.cancelled ? (
        <span>Sync cancelled after {status.migrated} photo{status.migrated === 1 ? "" : "s"}</span>
      ) : (
        <span>
          Synced {status.migrated} photo{status.migrated === 1 ? "" : "s"} to server
        </span>
      )}
    </div>
  );
}
