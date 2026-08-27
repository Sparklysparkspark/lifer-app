// Response shape for GET /api/trips (list) and GET /api/trips/:id (detail) — a persistent
// grouping of captures pulled in from an external, reference-in-place folder (see
// apps/api/src/trips/ for the scan/import/rescan logic behind it).

export interface TripSummary {
  id: string;
  name: string;
  /** Absolute path on the server's own filesystem — see migration 046's own comment on why
   *  this is 1:1 with the trip rather than a separate scan-root table. Shown to the user as
   *  read-only context (where this trip's photos actually live), never editable after
   *  creation — moving the folder itself is what rescan's relink logic is for. */
  sourceFolder: string;
  speciesCount: number;
  captureCount: number;
  /** Null until at least one capture has been imported. */
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
  /** Defaults to the most recent capture with a photo, unless manually overridden (see
   *  coverCropX/Y/Size below) — parity with CollectionItem.coverPhotoUrl/cardCropX/Y/Size. */
  coverPhotoUrl: string | null;
  /** A movable/resizable square crop for the cover photo, same convention as
   *  CollectionItem.cardCropX/Y/Size (migration 006) — fractions (0-100) of the photo's own
   *  width. Null means no custom crop saved yet — render as a plain centered
   *  object-fit:cover. Only meaningful once a cover has been manually picked (see
   *  PUT /trips/:id/cover) — clears back to null whenever the cover photo itself changes. */
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  /** A scan or import is currently running for this trip (background jobs — see
   *  apps/api/src/trips/routes.ts) — the card shows a loading state instead of a cover photo
   *  that may not exist yet, or is about to change. */
  processing: boolean;
}
