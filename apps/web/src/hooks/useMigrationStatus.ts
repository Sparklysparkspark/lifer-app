import type { JobStatus } from "@lifer/shared";
import { useJobPoll, type JobPoll } from "./useJobPoll";

export interface MigrationResult {
  migrated: number;
  skipped: number;
  failed: number;
  total: number;
}

export type MigrationStatus = JobStatus<MigrationResult> & {
  serverUrl: string | null;
  migrated: number;
  skipped: number;
  failed: number;
};

// Polled independently wherever it's used (the header indicator and the Settings migrate card)
// since it's a cheap read of in-memory job status. 404s outside desktop mode, where status
// stays null.
export function useMigrationStatus(pollMs = 3000): JobPoll<MigrationStatus> {
  return useJobPoll<MigrationStatus>("/settings/migrate-to-server/status", { intervalMs: pollMs, idleIntervalMs: pollMs });
}
