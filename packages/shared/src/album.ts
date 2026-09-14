// Shared by both the owner-side album view (AlbumDetailPage.tsx) and the public share viewer
// (SharePage.tsx) — same minimal photo shape either endpoint returns.
export interface AlbumPhoto {
  photoId: string;
  captureId: string;
  width: number | null;
  height: number | null;
  commonName: string;
  scientificName: string;
  // Present on the owner-side view (same toGalleryItem passthrough as the EXIF fields below) —
  // lets the album's own per-photo menu link straight to the species detail page, same as
  // Gallery/Trip already do.
  speciesId?: string;
  // Present on the owner-side view (backend already returns these via toGalleryItem — see
  // albums/routes.ts) — used for the same Newest/Oldest/Highest/Lowest rated sort Gallery has.
  // Optional here for the same "one type covers both endpoints" reason as the EXIF fields below.
  takenAt?: string | null;
  qualityRating?: number | null;
  // Present on the owner-side album view; a public share link only includes these when its
  // owner opted in (see shares/routes.ts's own show_metadata gate) — always optional here so
  // one type covers both.
  cameraModel?: string | null;
  lens?: string | null;
  focalLengthMm?: number | null;
  aperture?: number | null;
  shutter?: string | null;
  iso?: number | null;
  // Present on the owner-side view (backend already returns these via toGalleryItem) — same
  // photo/video distinction Gallery/SpeciesDetailPage rely on. Optional for the same reason as
  // the EXIF fields above (kept off the public share viewer's stricter response for now).
  kind?: "image" | "video";
  durationSeconds?: number | string | null;
  // Present on the owner-side view only (same toGalleryItem passthrough as the EXIF fields
  // above) - lets the album's own per-photo menu offer the same Download original/RAW options
  // every other photo-management surface (Gallery, species detail, Trip) already has.
  hasRawOriginal?: boolean;
  originalRef?: string | null;
  originalManaged?: boolean | null;
  originalKind?: string | null;
}
