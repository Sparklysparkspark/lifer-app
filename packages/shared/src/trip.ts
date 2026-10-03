// Response shape for GET /api/trips and GET /api/trips/:id: a persistent grouping of captures
// from a reference-in-place folder (see apps/api/src/trips/).

/** One resolved tile of a "quad" cover grid, shared by Albums and Trips. */
export interface QuadSlot {
  photoId: string;
  cropX: number | null;
  cropY: number | null;
  cropSize: number | null;
}

export interface TripSummary {
  id: string;
  name: string;
  /** Absolute path on the server's filesystem. Read-only after creation; rescan relinks a
   *  moved folder. */
  sourceFolder: string;
  speciesCount: number;
  captureCount: number;
  /** Null until at least one capture has been imported. */
  earliestTakenAt: string | null;
  latestTakenAt: string | null;
  /** Defaults to the most recent capture with a photo unless manually overridden, like
   *  CollectionItem.coverPhotoUrl. */
  coverPhotoUrl: string | null;
  /** Square cover crop, same convention as CollectionItem.cardCropX/Y/Size. Null means a
   *  plain centered object-fit:cover; clears whenever the cover photo changes. */
  coverCropX: number | null;
  coverCropY: number | null;
  coverCropSize: number | null;
  /** "quad" renders quadPhotoIds as a 2x2 grid instead of one cropped cover. Unlike Albums,
   *  slots are auto-picked from the most recent photos with no per-slot crop. */
  coverLayout: "single" | "quad";
  /** Only used when coverLayout is "quad": up to 4 most recent photos, possibly none. */
  quadPhotoIds: string[];
  /** A scan or import is running for this trip, so the card shows a loading state. */
  processing: boolean;
}
