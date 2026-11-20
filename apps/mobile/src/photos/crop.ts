/** A square crop as the desktop saves it: left, top and side, all percent of the photo's width. */
export interface Crop {
  x: number;
  y: number;
  size: number;
}

export const toCrop = (
  x: number | null | undefined,
  y: number | null | undefined,
  size: number | null | undefined,
): Crop | null => (x != null && y != null && size != null && size > 0 ? { x, y, size } : null);

export interface CropFrame {
  width: string;
  height: string;
  left: string;
  top: string;
}

/**
 * Where to place the whole photo inside a square box so the crop fills it (percent of the box). The crop
 * is clamped to the photo exactly as the hub cuts its square: a crop as tall as, or taller than, the photo
 * (a full-height crop of a 3:2 shot is 66.68% wide) shows the full height rather than falling back to centring.
 * Null only with no crop or an unknown shape: the caller centres instead.
 */
export function cropFrame(crop: Crop | null | undefined, aspect: number | null | undefined): CropFrame | null {
  if (!crop || !aspect || !(aspect > 0)) return null;
  const tall = 100 / aspect;
  const size = Math.min(crop.size, 100, tall);
  const x = Math.min(Math.max(0, crop.x), 100 - size);
  const y = Math.min(Math.max(0, crop.y), tall - size);
  const width = (100 * 100) / size;
  return {
    width: `${width}%`,
    height: `${width / aspect}%`,
    left: `${(-100 * x) / size}%`,
    top: `${(-100 * y) / size}%`,
  };
}
