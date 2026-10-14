// Trip shapes come from the API's own response schemas (api/schema.gen.ts).
import type { ApiResponse } from "../../api/client";
import type { ReviewRowBase } from "../../components/importReview/useImportReview";

export type TripDetail = ApiResponse<"/trips/{id}">;
/** What was new or notable about the trip. */
export type TripSummary = ApiResponse<"/trips/{id}/summary">;
export type TripPhoto = ApiResponse<"/trips/{id}/photos">["items"][number];
export type ScanStatus = ApiResponse<"/trips/{id}/scan/status">;
export type ImportStatus = ApiResponse<"/trips/{id}/import/status">;

export type ReviewRowStatus = "pending" | "ready" | "importing" | "done" | "error";

// key is the file's path within the trip folder.
export interface ReviewRow extends ReviewRowBase {
  status: ReviewRowStatus;
  error?: string;
}

export type TripFolder = "sourceFolder" | "destinationFolder";
