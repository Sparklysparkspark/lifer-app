// Forgiving hit-testing for the photo map: a click or hover takes the nearest mark within reach of
// the pointer, not only what is under its exact pixel. Pure, so hover and click share it.

export type PickKind = "spot" | "cluster" | "point" | "ring" | "province" | "country";

export interface PickCandidate<T = unknown> {
  kind: PickKind;
  /** Where the mark is drawn, in screen pixels (map.project, so it holds when tilted too). */
  x: number;
  y: number;
  /** Its drawn radius in pixels. */
  radius: number;
  data: T;
}

/** Marks drawn as a point. Areas (provinces, countries) only count when under the pointer itself. */
const POINT_KINDS: ReadonlySet<PickKind> = new Set(["spot", "cluster", "point", "ring"]);
// Lower wins when two marks are about as close: a photo dot or spot before a hollow ring.
const RANK: Record<PickKind, number> = { spot: 0, cluster: 0, point: 0, ring: 1, province: 2, country: 3 };
// Within this many pixels two marks count as equally near, and the rank decides.
const TIE_PX = 3;

/** How far past a mark's edge the pointer may be: a finger is wider than a mouse, and at world zoom
 *  the dots are smallest and most crowded. */
export function pickSlop(pointerType: string, zoom: number): number {
  const base = pointerType === "touch" || pointerType === "pen" ? 22 : 8;
  return zoom < 3 ? Math.round(base * 1.5) : base;
}

/** The furthest any mark can reach, for the box queried around the pointer. */
export const MAX_MARK_RADIUS = 36;

/** Photo marks drawn as a point; they always win over a saved spot under them. */
const PHOTO_KINDS: ReadonlySet<PickKind> = new Set(["cluster", "point", "ring"]);

/** Whether a saved spot sits inside a photo mark: it is drawn under the mark and folds into it,
 *  so the mark (and its count) stays whole and its card names the spot instead. */
export function spotUnderMark(spot: { x: number; y: number }, mark: { x: number; y: number; radius: number }): boolean {
  return Math.hypot(spot.x - mark.x, spot.y - mark.y) <= mark.radius;
}

/** The mark a pointer at (x, y) means: the nearest point mark within its radius plus `slop`, else
 *  the area under the pointer (a province before its country), else nothing. */
export function pickNearest<T>(
  candidates: ReadonlyArray<PickCandidate<T>>,
  x: number,
  y: number,
  slop: number,
): PickCandidate<T> | null {
  let best: { c: PickCandidate<T>; d: number } | null = null;
  const photoMarks = candidates.filter((c) => PHOTO_KINDS.has(c.kind));
  for (const c of candidates) {
    if (!POINT_KINDS.has(c.kind)) continue;
    // A spot under a photo mark isn't a target of its own: the mark's card names it.
    if (c.kind === "spot" && photoMarks.some((m) => spotUnderMark(c, m))) continue;
    // The smallest dots get a floor, so a 5 px dot is as easy to reach as a 6 px one.
    const d = Math.hypot(c.x - x, c.y - y);
    if (d > Math.max(c.radius, 6) + slop) continue;
    if (!best || d < best.d - TIE_PX || (Math.abs(d - best.d) <= TIE_PX && RANK[c.kind] < RANK[best.c.kind]))
      best = { c, d };
  }
  if (best) return best.c;
  const areas = candidates.filter((c) => !POINT_KINDS.has(c.kind)).sort((a, b) => RANK[a.kind] - RANK[b.kind]);
  return areas[0] ?? null;
}

// The drawn radii, matching the photo map's circle paint (PhotoMap addPhotoLayers).
const lerp = (v: number, [x0, y0]: [number, number], [x1, y1]: [number, number]) =>
  v <= x0 ? y0 : v >= x1 ? y1 : y0 + ((v - x0) / (x1 - x0)) * (y1 - y0);
export const clusterRadius = (total: number) => {
  const s = Math.sqrt(total);
  return s <= 30 ? lerp(s, [1, 11], [30, 22]) : lerp(s, [30, 22], [300, 36]);
};
export const pointRadius = (count: number) => lerp(count, [1, 5], [50, 9]);
// A ring grows with its count like a cluster, so the two read as the same scale.
export const ringRadius = clusterRadius;
export const SPOT_RADIUS = 7.5;
