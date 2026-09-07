// Shared by both the owner-side album view (AlbumDetailPage.tsx) and the public share viewer
// (SharePage.tsx) — same minimal photo shape either endpoint returns.
export interface AlbumPhoto {
  photoId: string;
  captureId: string;
  width: number | null;
  height: number | null;
  commonName: string;
  scientificName: string;
  // Present on the owner-side album view; a public share link only includes these when its
  // owner opted in (see shares/routes.ts's own show_metadata gate) — always optional here so
  // one type covers both.
  cameraModel?: string | null;
  lens?: string | null;
  focalLengthMm?: number | null;
  aperture?: number | null;
  shutter?: string | null;
  iso?: number | null;
}
