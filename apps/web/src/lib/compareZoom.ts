// The zoom and pan math behind ZoomPane, the one zoomable photo frame (Lightbox, both compare
// views). Pan is a fraction of the frame, so photos of different shapes stay on the same spot.
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 4;
const MAX_ZOOM = 6;

export type View = { scale: number; x: number; y: number };
export const FIT: View = { scale: 1, x: 0, y: 0 };

/** The share of the frame a photo drawn object-contain covers on each axis. */
export type Fit = { w: number; h: number };
export const FULL: Fit = { w: 1, h: 1 };

/** `aspect` is the photo's width/height over the frame's. */
export function containFit(aspect: number): Fit {
  if (!Number.isFinite(aspect) || aspect <= 0) return FULL;
  return aspect >= 1 ? { w: 1, h: 1 / aspect } : { w: aspect, h: 1 };
}

/** Keeps a zoomed photo over its frame: it can't be pushed past its own edges, and an axis it
 *  doesn't fill yet stays centred. */
export function clampView(v: View, fit: Fit = FULL): View {
  if (v.scale <= 1) return FIT;
  const maxX = Math.max(0, (v.scale * fit.w - 1) / 2);
  const maxY = Math.max(0, (v.scale * fit.h - 1) / 2);
  return { scale: v.scale, x: Math.max(-maxX, Math.min(maxX, v.x)), y: Math.max(-maxY, Math.min(maxY, v.y)) };
}

/** The view that fills most of the frame with `box` (percent of the photo), for a photo drawn
 *  object-contain. `aspect` is the photo's width/height over the frame's. */
export function frameView(box: { x: number; y: number; w: number; h: number }, aspect: number): View {
  const fit = containFit(aspect);
  const size = Math.max((box.w / 100) * fit.w, (box.h / 100) * fit.h, 0.01);
  // The animal fills about 60% of the frame, leaving some of its perch and surroundings.
  const scale = Math.max(1, Math.min(MAX_ZOOM, 0.6 / size));
  const cx = ((box.x + box.w / 2) / 100 - 0.5) * fit.w;
  const cy = ((box.y + box.h / 2) / 100 - 0.5) * fit.h;
  return clampView({ scale, x: -scale * cx, y: -scale * cy }, fit);
}

/** Zooms to `scale` keeping the point at (fx, fy), a fraction from the frame's centre, where it is. */
export function zoomView(v: View, scale: number, fx = 0, fy = 0, fit: Fit = FULL): View {
  const next = Math.max(1, Math.min(MAX_ZOOM, scale));
  const k = next / v.scale;
  return clampView({ scale: next, x: fx - k * (fx - v.x), y: fy - k * (fy - v.y) }, fit);
}

/** A wheel event's delta in pixels: Windows mice report lines, some devices pages. */
export function wheelPixels(delta: number, mode: number, pageSize: number): number {
  return delta * (mode === 1 ? 16 : mode === 2 ? pageSize : 1);
}

/** The zoom factor for one pinch (ctrl+wheel) event. Capped per event, so a mouse wheel's
 *  100px notch steps evenly instead of jumping. */
export function pinchFactor(pixels: number): number {
  return Math.exp(-Math.max(-25, Math.min(25, pixels)) * 0.01);
}
