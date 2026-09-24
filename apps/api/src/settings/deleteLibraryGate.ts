// Gate for POST /settings/delete-local-library. The in-memory check covers the last run; the
// caller also confirms in the DB that every capture has a 'migrated' row, since captures
// skipped by an EARLIER run are excluded from later runs and wouldn't show up in `skipped`.
export interface MigrationOutcome {
  running: boolean;
  finishedAt: number | null;
  error: string | null;
  cancelled: boolean;
  failed: number;
  skipped: number;
  serverUrl: string | null;
}

export function deleteLocalLibraryBlockedReason(job: MigrationOutcome, unmigratedCaptureCount: number): string | null {
  if (job.running) return "A migration is still running.";
  if (job.finishedAt == null || !job.serverUrl) return "Local files can only be deleted right after a migration to a server.";
  if (job.error != null) return "The last migration stopped with an error, so some photos may not be on the server.";
  if (job.cancelled) return "The last migration was cancelled, so some photos may not be on the server.";
  if (job.failed > 0) return "The last migration had failures. Run it again until it finishes with zero failures.";
  if (job.skipped > 0 || unmigratedCaptureCount > 0) {
    const n = Math.max(job.skipped, unmigratedCaptureCount);
    return `${n} photo${n === 1 ? " isn't" : "s aren't"} on the server yet (for example RAW-only photos, which can't be migrated), so local files can't be deleted.`;
  }
  return null;
}
