import { useMigrationStatus } from "../hooks/useMigrationStatus";

// Fixed-position so it shows up on every page, not just Settings (where the migration is
// started), since the migration can run for a long time in the background and the user may
// navigate away while it's still going.
export default function MigrationStatusIndicator() {
  const status = useMigrationStatus();
  if (!status) return null;

  const justFinished = !status.running && status.finishedAt != null && Date.now() - status.finishedAt < 8000;
  if (!status.running && !justFinished) return null;

  return (
    <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600 shadow-sm">
      {status.running ? (
        <>
          <span className="h-3 w-3 animate-spin rounded-full border-2 border-stone-300 border-t-stone-700" />
          <span>
            Syncing to server… {status.migrated + status.skipped + status.failed}/{status.total}
          </span>
        </>
      ) : status.error ? (
        <span className="text-red-600">Sync failed: {status.error}</span>
      ) : (
        <span>
          Synced {status.migrated} photo{status.migrated === 1 ? "" : "s"} to server
        </span>
      )}
    </div>
  );
}
