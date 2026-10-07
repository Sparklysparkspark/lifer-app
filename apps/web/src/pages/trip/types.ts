import type { CullMarks, JobStatus } from "@lifer/shared";
import type { ReviewRowBase } from "../../components/importReview/useImportReview";

// GET /api/trips/:id
export interface TripDetail {
  id: string;
  name: string;
  description: string | null;
  sourceFolder: string;
  destinationFolder: string;
  coverCaptureId: string | null;
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  coverLayout: "single" | "quad";
}

// GET /api/trips/:id/summary: what was new or notable about the trip.
export interface TripSummary {
  speciesCount: number;
  liferCount: number;
  rareCount: number;
  endemicCount: number;
}

// GET /api/trips/:id/photos
export interface TripPhoto {
  photoId: string;
  width: number | null;
  height: number | null;
  captureId: string;
  speciesId: string;
  scientificName: string;
  commonName: string | null;
  takenAt: string | null;
  hasRaw: boolean;
  originalRef: string | null;
  originalKind: string | null;
  qualityRating: number | null;
  cameraModel: string | null;
  lens: string | null;
  focalLengthMm: number | null;
  aperture: number | null;
  shutter: string | null;
  iso: number | null;
}

export type ScanStatus = JobStatus & {
  relinked: number;
  markedStale: number;
  collisions: number;
  recovered: number;
  rawsLinked: number;
  /** Each new photo with what a culling app marked it. */
  newFiles: Array<{ relativePath: string; cull?: CullMarks }>;
  cullRejected?: number;
  cullPicked?: number;
};

export type ImportStatus = JobStatus<{ imported: number; failed: number; skipped?: number; hidden?: number }> & {
  /** `skipped` when a culling app rejected it and the import skipped those; `hidden` when it was
   *  imported hidden. */
  results: Array<{ relativePath: string; captureId?: string; error?: string; skipped?: "rejected"; hidden?: boolean }>;
};

export type ReviewRowStatus = "pending" | "ready" | "importing" | "done" | "error";

// key is the file's path within the trip folder.
export interface ReviewRow extends ReviewRowBase {
  status: ReviewRowStatus;
  error?: string;
}

export type TripFolder = "sourceFolder" | "destinationFolder";
