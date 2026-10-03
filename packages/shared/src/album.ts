// Photo shape shared by the owner album view (AlbumDetailPage.tsx) and the public share viewer.
// Optional fields are only present on the owner view or when a share opts into metadata.
export interface AlbumPhoto {
  photoId: string;
  captureId: string;
  width: number | null;
  height: number | null;
  commonName: string;
  scientificName: string;
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
  kind?: "image" | "video";
  durationSeconds?: number | string | null;
  // Owner view only: lets the per-photo menu offer Download original/RAW, as elsewhere.
  hasRawOriginal?: boolean;
  originalRef?: string | null;
  originalManaged?: boolean | null;
  originalKind?: string | null;
  rawRef?: string | null;
}
