// Camera, lens, focal length, aperture, shutter and ISO as one compact line, skipping missing fields.
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

// Rough glyph width for the 9px line (0.55em is a common sans average), used to guess wrapping
// per photo so MasonryGrid reserves a second line only where needed.
const SHOT_DATA_FONT_SIZE_PX = 9;
const AVG_CHAR_WIDTH_RATIO = 0.55;

// Extra row height beyond the first line: 0 if it should fit, one line height if it should wrap.
export function estimateShotDataWrapExtraPx(line: string | null, columnWidthPx: number, lineHeightPx: number): number {
  if (!line) return 0;
  const avgCharWidthPx = SHOT_DATA_FONT_SIZE_PX * AVG_CHAR_WIDTH_RATIO;
  const estimatedCharsPerLine = Math.max(1, Math.floor(columnWidthPx / avgCharWidthPx));
  return line.length > estimatedCharsPerLine ? lineHeightPx : 0;
}
