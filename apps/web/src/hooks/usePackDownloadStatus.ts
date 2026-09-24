import type { JobStatus } from "@lifer/shared";
import { useJobPoll, type JobPoll } from "./useJobPoll";

export type PackDownloadStatus = JobStatus<{ packsApplied: number }> & {
  packIds: string[];
  currentPack: string | null;
};

// "downloading" then "applying" per pack; bytes are per pack, processed/total count packs.
export const PACK_DOWNLOAD_PHASES = {
  downloading: { label: "Downloading", progress: "bytes" as const, showItem: true },
  applying: { label: "Applying", progress: "none" as const, showItem: true },
  // A brand-new server still loading its species catalog; the pack is downloaded and waits.
  preparing: { label: "Finishing setup", progress: "none" as const, showItem: false },
};

// Polled independently wherever it's used: the job's real state lives server-side
// (offlinePacks/routes.ts), so the Settings card, the Offline Packs page and the updates banner
// all reflect an in-flight download no matter where it was started. Faster while running.
export function usePackDownloadJob(pollMs = 1000, onFinish?: (status: PackDownloadStatus) => void): JobPoll<PackDownloadStatus> {
  return useJobPoll<PackDownloadStatus>("/offline-packs/download/status", { intervalMs: pollMs, idleIntervalMs: pollMs * 3, onFinish });
}

export function usePackDownloadStatus(pollMs = 1000): PackDownloadStatus | null {
  return usePackDownloadJob(pollMs).status;
}

export function packProgressDetail(status: PackDownloadStatus | null): string | null {
  if (!status?.running || status.total == null || status.total <= 1) return null;
  return `Pack ${Math.min((status.processed ?? 0) + 1, status.total)} of ${status.total}`;
}
