// The pack download job's status (GET /offline-packs/download/status). The job runs three lanes
// at once: downloading pack files, setting them up on this computer, and fetching their photos.
import type { JobStatus, LoadProgress } from "./job.js";

export interface PackLane {
  /** The pack the lane is working on ("Canada birds"), null when idle. */
  currentItem: string | null;
  /** Packs this lane has finished, of the packs in the job so far (the total grows as packs are queued). */
  processed: number;
  total: number;
  /** Bytes of what the lane is fetching now: the pack file or its photos. Null when not fetching. */
  downloadedBytes: number | null;
  totalBytes: number | null;
}

export interface PackDownloadLanes {
  download: PackLane;
  /** `processed` counts packs whose checklist is in, so the species are usable. Hotspots
   *  ("where to find it") follow in the background: `step` is "hotspots" meanwhile. */
  setup: PackLane & { step: "checklist" | "hotspots" | null };
  photos: PackLane;
}

/** The old single-phase fields stay filled for the server's sync callers: `processed` counts
 *  packs with their photos done, `phase` and `currentItem` follow the busiest lane. */
export type PackDownloadStatus = JobStatus<{ packsApplied: number }> & {
  packIds: string[];
  currentPack: string | null;
  lanes: PackDownloadLanes;
  /** The species catalog load the packs wait for, while one runs. */
  catalogProgress?: LoadProgress | null;
};

const idleLane = (): PackLane => ({
  currentItem: null,
  processed: 0,
  total: 0,
  downloadedBytes: null,
  totalBytes: null,
});

export function idlePackLanes(): PackDownloadLanes {
  return { download: idleLane(), setup: { ...idleLane(), step: null }, photos: idleLane() };
}
