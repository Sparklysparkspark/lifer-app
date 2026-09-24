import type { JobStatus } from "@lifer/shared";
import { useJobPoll, type JobPoll } from "./useJobPoll";
import { useDeploymentMode } from "./useDeploymentMode";

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
// since it's a cheap read of in-memory job status. The endpoint only exists on a desktop API, so
// nothing polls until the mode is known to be desktop.
export function useMigrationStatus(pollMs = 3000): JobPoll<MigrationStatus> {
  const enabled = useDeploymentMode() === "desktop";
  return useJobPoll<MigrationStatus>("/settings/migrate-to-server/status", { intervalMs: pollMs, idleIntervalMs: pollMs, enabled });
}
