// Photo shape shared by the owner album view (AlbumDetailPage.tsx) and the public share viewer.
// Optional fields are only present on the owner view or when a share opts into metadata.
export interface AlbumPhoto {
  photoId: string;
  captureId: string;
  width: number | null;
  height: number | null;
  commonName: string;
  scientificName: string;
  abaCode?: string | null;
  ebirdCode?: string | null;
  // Owner view: lets the per-photo menu link to the species page.
  speciesId?: string;
  // Owner view: for the date and rating sorts.
  takenAt?: string | null;
  qualityRating?: number | null;
  // Owner view, or a share whose owner enabled show_metadata.
  cameraModel?: string | null;
  lens?: string | null;
  focalLengthMm?: number | null;
  aperture?: number | null;
  shutter?: string | null;
  iso?: number | null;
  // Owner view only.
  kind?: "image" | "video" | "audio";
  durationSeconds?: number | string | null;
  // Owner view only: lets the per-photo menu offer Download original/RAW, as elsewhere.
  hasRawOriginal?: boolean;
  originalRef?: string | null;
  /** The iNaturalist observation this photo was sent as, when it has been. */
  inatObservationId?: string | null;
  originalManaged?: boolean | null;
  originalKind?: string | null;
  rawRef?: string | null;
  // Owner view only: for the photo menu's edits.
  tags?: string[];
  regionId?: string | null;
  locationLabel?: string | null;
  regionName?: string | null;
  lat?: number | string | null;
  lon?: number | string | null;
  /** Its species' card photo. */
  isFeatured?: boolean | null;
}

/** Longest album or trip name a person can save. Older, longer stored names stay as they are. */
export const NAME_MAX_LENGTH = 255;
/** Characters left at which the name fields start counting down. */
export const NAME_COUNTDOWN_FROM = 200;
