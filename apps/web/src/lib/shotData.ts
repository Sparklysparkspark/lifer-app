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

// Rough average character width for the 9px shot-data line — used only to guess whether a
// SPECIFIC photo's line will wrap to a second line at a given column width, so MasonryGrid can
// reserve extra row height for just that item rather than for every item uniformly (a fixed
// camera model + lens + exposure string varies a lot in length photo to photo, so a global
// "always budget for 2 lines" estimate wastes vertical space on every photo whose line happens
// to fit on one). 0.55 * font-size is a standard rule-of-thumb average glyph width for a normal-
// weight sans body font across mixed letters/digits/punctuation — not exact (nothing short of
// actually measuring the rendered text would be), but good enough for a layout estimate that
// only has to be right most of the time, not exactly.
const SHOT_DATA_FONT_SIZE_PX = 9;
const AVG_CHAR_WIDTH_RATIO = 0.55;

// Returns how much EXTRA row height (beyond one line's worth, already covered by the caller's
// own flat per-line budget) this specific shot-data line needs — 0 if it's expected to fit on
// one line, or one line's height if it's expected to wrap to two. Caller decides the per-line
// height itself (font size/line-height are its own styling choice, not this module's).
export function estimateShotDataWrapExtraPx(line: string | null, columnWidthPx: number, lineHeightPx: number): number {
  if (!line) return 0;
  const avgCharWidthPx = SHOT_DATA_FONT_SIZE_PX * AVG_CHAR_WIDTH_RATIO;
  const estimatedCharsPerLine = Math.max(1, Math.floor(columnWidthPx / avgCharWidthPx));
  return line.length > estimatedCharsPerLine ? lineHeightPx : 0;
}
