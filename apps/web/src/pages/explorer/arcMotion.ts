// The Circle view's morph between views: every arc tweens its angles and radii, so a zoom reads as
// the clicked wedge opening into the new circle and stepping out as it folding back. Pure, so the
// maths is tested without a DOM.

/** An arc's drawn shape: angles in radians from 12 o'clock, radii in viewBox units. */
export interface Geo {
  start: number;
  end: number;
  r0: number;
  r1: number;
  opacity: number;
  /** Photographed share, 0 to 1. */
  share: number;
}
/** A drawn circle: arcs by key, and the key of the group in the middle. */
export interface View {
  geo: ReadonlyMap<string, Geo>;
  centre: string;
}
export interface Tween {
  key: string;
  from: Geo;
  to: Geo;
}

// The Stats charts' feel: Recharts bars tween for 400 ms on CSS `ease`.
export const MOTION_MS = 400;
const TAU = 2 * Math.PI;

/** CSS `ease`, cubic-bezier(0.25, 0.1, 0.25, 1). */
export function ease(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bez = (u: number, p1: number, p2: number) => 3 * (1 - u) ** 2 * u * p1 + 3 * (1 - u) * u * u * p2 + u ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (bez(mid, 0.25, 0.25) < t) lo = mid;
    else hi = mid;
  }
  return bez((lo + hi) / 2, 0.1, 1);
}

export function lerpGeo(a: Geo, b: Geo, t: number): Geo {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    start: l(a.start, b.start),
    end: l(a.end, b.end),
    r0: l(a.r0, b.r0),
    r1: l(a.r1, b.r1),
    opacity: l(a.opacity, b.opacity),
    share: l(a.share, b.share),
  };
}

/** The top of the tree's key; a group's key is its tree id. */
export const ROOT = "";
/** A "more" arc's key: its parent group and how many groups it merges. */
export const moreKey = (parent: string | null, count: number) => `${parent ?? ROOT}|more${count}`;

/** The key one level up: ids are rank:name paths joined by "/". */
export function parentKey(key: string): string | null {
  if (key === ROOT) return null;
  const bar = key.indexOf("|");
  if (bar >= 0) return key.slice(0, bar);
  const slash = key.lastIndexOf("/");
  return slash < 0 ? ROOT : key.slice(0, slash);
}

/** Maps angles through a group drawn in both views, so its descendants keep their place inside it. */
const through = (a: Geo, b: Geo) => (x: number) =>
  b.start + ((x - a.start) * (b.end - b.start)) / (a.end - a.start || 1e-9);
const clamp = (x: number) => Math.min(TAU, Math.max(0, x));

/** Seen only if some end of the tween is at least half a pixel long. */
const visible = (g: Geo) => g.opacity > 0 && (g.end - g.start) * g.r1 >= 0.5;

/**
 * The tweens from what is drawn to the next view. An arc in both morphs; the group zoomed into
 * becomes the middle disc (`centre`), and the middle becomes an arc again on the way out. An arc
 * only on one side grows out of (or folds into) its nearest group drawn on both sides; failing
 * that, the zoom's pivot pushes it off the circle's ends, and failing that it fades in place.
 */
export function transition(from: View, to: View, centre: Omit<Geo, "share">): Tween[] {
  const at = (v: View, key: string): Geo | undefined =>
    v.geo.get(key) ?? (key === v.centre ? { ...centre, share: 0 } : undefined);
  // The zoom's pivot: the new middle (or its nearest ancestor) drawn as an arc before, or the old one after.
  let fwd: ((x: number) => number) | null = null;
  let back: ((x: number) => number) | null = null;
  const full = { ...centre, share: 0 };
  for (let k: string | null = to.centre; k != null && !fwd; k = parentKey(k)) {
    const g = from.geo.get(k);
    if (g) [fwd, back] = [through(g, full), through(full, g)];
  }
  for (let k: string | null = from.centre; k != null && !fwd; k = parentKey(k)) {
    const g = to.geo.get(k);
    if (g) [fwd, back] = [through(full, g), through(g, full)];
  }

  const out: Tween[] = [];
  for (const key of new Set([...from.geo.keys(), ...to.geo.keys()])) {
    const a = at(from, key);
    const b = at(to, key);
    if (a && b) {
      // The middle disc carries the arc's share, so the green doesn't blink.
      const tween = {
        key,
        from: from.geo.has(key) ? a : { ...a, share: b.share },
        to: to.geo.has(key) ? b : { ...b, share: a.share },
      };
      if (visible(tween.from) || visible(tween.to)) out.push(tween);
      continue;
    }
    const g = (a ?? b)!;
    const entering = !a;
    const [here, there] = entering ? [to, from] : [from, to];
    let other: Geo = { ...g, opacity: 0 };
    let placed = false;
    for (let k = parentKey(key); k != null && !placed; k = parentKey(k)) {
      const p = at(here, k);
      const q = at(there, k);
      if (!p || !q) continue;
      const f = through(p, q);
      other = { start: f(g.start), end: f(g.end), r0: q.r1, r1: q.r1, opacity: 0, share: g.share };
      placed = true;
    }
    const pivot = entering ? back : fwd;
    if (!placed && pivot) other = { ...g, start: clamp(pivot(g.start)), end: clamp(pivot(g.end)), opacity: 0 };
    const tween = entering ? { key, from: other, to: g } : { key, from: g, to: other };
    if (visible(tween.from) || visible(tween.to)) out.push(tween);
  }
  return out;
}

/** Whether a transition changes anything on screen. */
export const moves = (tweens: Tween[]) =>
  tweens.some(({ from, to }) =>
    (["start", "end", "r0", "r1", "opacity", "share"] as const).some((p) => Math.abs(from[p] - to[p]) > 1e-6),
  );
