// Camera/lens/focal length/aperture/shutter/ISO as a single compact line, only the fields
// that are actually present — most captures won't have every EXIF field populated. Shared
// between SpeciesDetailPage's own-photo grid and GalleryPage's global gallery so both
// "show camera info" toggles format the line identically.
export function shotDataLine(c: {
  camera_model?: string | null;
  lens?: string | null;
  focal_length_mm?: string | number | null;
  aperture?: string | number | null;
  shutter?: string | null;
  iso?: number | null;
}): string | null {
  const parts = [
    c.camera_model,
    c.lens,
    c.focal_length_mm ? `${Math.round(Number(c.focal_length_mm))}mm` : null,
    c.aperture ? `f/${c.aperture}` : null,
    c.shutter,
    c.iso ? `ISO ${c.iso}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
