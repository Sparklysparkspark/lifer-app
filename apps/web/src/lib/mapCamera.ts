// The curated region view's camera (docs/plans/map-location-ux.md, "Curated region view"): a fixed,
// north-up framing per country or province, pan held near it, and 3D only as a choice inside it.
// Pure: the MapLibre calls live in hooks/useRegionCamera.ts.
import overrides from "./regionFraming.json";

/** West, south, east, north. East may pass 180 so a region across the antimeridian stays one box. */
export type Bounds = [number, number, number, number];

/** A far part of a region left out of its framing (Svalbard for Norway), reachable on its own. */
export interface RegionPart {
  /** Hand-set in regionFraming.json; null when derived from the outline. */
  name: string | null;
  bounds: Bounds;
}

export interface Framing {
  bounds: Bounds;
  /** The far parts the bounds leave out, largest first. */
  parts: RegionPart[];
  /** Pitch when 3D is on. */
  pitch: number;
  /** Terrain exaggeration when 3D is on. */
  exaggeration: number;
}

interface Override {
  /** Without it the rule frames the region and only the parts are hand-set. */
  bounds?: Bounds;
  parts?: RegionPart[];
  pitch?: number;
  exaggeration?: number;
}

/** A continent's or the world's downloaded countries, kept on its joined outline as
 *  `properties.countries` so the hub frames each country by its own framing. */
export interface HubCountry {
  outline: unknown;
  code: string | null;
}
const hubCountries = (outline: unknown): HubCountry[] | undefined =>
  (outline as { properties?: { countries?: HubCountry[] } } | null)?.properties?.countries;

type Ring = number[][];
type Geometry = { type: string; coordinates: unknown };

export const FLY_MS = 900;
/** The one 3D look: a fixed pitch once zoomed in far enough for relief to read (the elevation
 *  archive is detailed to zoom 5), flat again below a lower zoom so it doesn't flap at the edge.
 *  No free tilt or rotation anywhere. */
export const TILT = { pitch: 50, onZoom: 5, offZoom: 4.5 } as const;
export type TiltMode = "auto" | "flat";
const PITCH_3D = TILT.pitch;
const WIDE_KM = 1000;
const KEEP_AREA_SHARE = 0.95;
const NEAR_KM = 1500;
const PAN_SLACK = 0.25;
const KM_PER_DEG = 111.32;
// Far parts closer than this to each other are offered as one (an island group).
const PART_GROUP_KM = 500;

const OVERRIDES = overrides as unknown as Record<string, Override>;

function polygonsOf(outline: unknown): Ring[] {
  const g = ((outline as { geometry?: Geometry })?.geometry ?? outline) as Geometry | null;
  if (!g || !Array.isArray(g.coordinates)) return [];
  if (g.type === "Polygon") return [(g.coordinates as Ring[])[0]].filter(Boolean);
  if (g.type === "MultiPolygon") return (g.coordinates as Ring[][]).map((p) => p[0]).filter(Boolean);
  return [];
}

interface Part {
  w: number;
  e: number;
  s: number;
  n: number;
  km2: number;
}

const cosLat = (lat: number) => Math.cos((lat * Math.PI) / 180);

function partOf(ring: Ring): Part {
  let [w, e, s, n] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of ring) [w, e, s, n] = [Math.min(w, x), Math.max(e, x), Math.min(s, y), Math.max(n, y)];
  // Shoelace in degrees scaled by the latitude: plenty for ranking parts by size.
  return { w, e, s, n, km2: Math.abs(signedArea(ring)) * cosLat((s + n) / 2) * KM_PER_DEG * KM_PER_DEG };
}

// Box to box, flat-earth: close enough to tell a nearby island from an overseas territory.
function gapKm(a: Part, b: Part): number {
  const latGap = Math.max(0, b.s - a.n, a.s - b.n);
  const around = (x: number) => ((x % 360) + 360) % 360;
  const lonGap = a.w <= b.e && b.w <= a.e ? 0 : Math.min(around(b.w - a.e), around(a.w - b.e));
  const lat = (Math.max(a.s, b.s) + Math.min(a.n, b.n)) / 2;
  return Math.hypot(latGap, lonGap * cosLat(lat)) * KM_PER_DEG;
}

/** The smallest longitude span covering every interval, on a circle: the largest empty gap is what
 *  the box leaves out. East comes back past 180 when the span crosses the antimeridian. */
export function lonSpan(intervals: Array<[number, number]>): [number, number] {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [w, e] of sorted) {
    const last = merged.at(-1);
    if (last && w <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([w, e]);
  }
  let best = merged[0][0] + 360 - merged.at(-1)![1];
  let span: [number, number] = [merged[0][0], merged.at(-1)![1]];
  for (let i = 0; i < merged.length - 1; i++) {
    const gap = merged[i + 1][0] - merged[i][1];
    if (gap > best) [best, span] = [gap, [merged[i + 1][0], merged[i][1] + 360]];
  }
  return span;
}

/** The rule: frame the largest parts that hold 95% of the area, plus any part within 1,500 km of
 *  the largest, so far-flung islands don't shrink the region to a dot. */
export function framingBounds(outline: unknown): Bounds | null {
  const parts = polygonsOf(outline)
    .filter((r) => r.length >= 4)
    .map(partOf);
  if (parts.length === 0) return null;
  parts.sort((a, b) => b.km2 - a.km2);
  const total = parts.reduce((sum, p) => sum + p.km2, 0);
  let covered = 0;
  const kept = parts.filter((p, i) => {
    const keep = i === 0 || covered < KEEP_AREA_SHARE * total || gapKm(p, parts[0]) <= NEAR_KM;
    covered += p.km2;
    return keep;
  });
  const [w, e] = lonSpan(kept.map((p) => [p.w, p.e]));
  return [w, Math.min(...kept.map((p) => p.s)), e, Math.max(...kept.map((p) => p.n))];
}

// The far north stretches so much on the map's projection that above this latitude a country's
// Arctic (Canada's islands to 83°N, Russia's to 81°N) sets the zoom and wastes the top of the view.
const START_CROP_LAT = 76;

/** A region's first view: its framing, with the stretched far north cropped off for a country
 *  that lies mostly well south of it, but never cropping a pin (`pinLats`). Only the first view:
 *  zooming out and panning still reach all of it. */
export function startFraming(outline: unknown, bounds: Bounds, pinLats: readonly number[] = []): Bounds {
  const [w, s, e, n] = bounds;
  if (n <= START_CROP_LAT) return bounds;
  // At a hub, no crop if any country lies mostly in the far north (Greenland).
  const outlines = hubCountries(outline)?.map((c) => c.outline) ?? [outline];
  if (outlines.some((o) => meanLat(o) >= START_CROP_LAT - 10)) return bounds;
  // A pin up there keeps a little room above it.
  const north = Math.max(START_CROP_LAT, ...pinLats.map((lat) => lat + 1));
  return [w, s, e, Math.min(n, north)];
}

function meanLat(outline: unknown): number {
  const parts = polygonsOf(outline)
    .filter((r) => r.length >= 4)
    .map(partOf);
  const total = parts.reduce((sum, p) => sum + p.km2, 0);
  return total > 0 ? parts.reduce((sum, p) => sum + ((p.s + p.n) / 2) * p.km2, 0) / total : 90;
}

/** The box a map of `width` x `height` pixels shows at `zoom` around `center` (north up, flat). */
export function viewAround(center: [number, number], zoom: number, width: number, height: number): Bounds {
  const size = 512 * 2 ** zoom;
  const x = (center[0] + 180) / 360;
  const y = (1 - Math.log(Math.tan(Math.PI / 4 + (center[1] * Math.PI) / 360)) / Math.PI) / 2;
  const lat = (my: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * my))) * 180) / Math.PI;
  const dx = width / 2 / size;
  const dy = height / 2 / size;
  return [(x - dx) * 360 - 180, lat(Math.min(1, y + dy)), (x + dx) * 360 - 180, lat(Math.max(0, y - dy))];
}

/** The photo map's opening view: every photo's point, but never tighter than the whole of each
 *  country they're in (its framing). Null with nothing to frame. */
export function openingBounds(points: ReadonlyArray<[number, number]>, countries: readonly Bounds[]): Bounds | null {
  const boxes: Bounds[] = [...countries, ...points.map(([lon, lat]): Bounds => [lon, lat, lon, lat])];
  if (boxes.length === 0) return null;
  const [w, e] = lonSpan(boxes.map(([bw, , be]) => [bw, be]));
  return [w, Math.min(...boxes.map((b) => b[1])), e, Math.max(...boxes.map((b) => b[3]))];
}

/** Width or height, whichever is larger. */
export function spanKm([w, s, e, n]: Bounds): number {
  return Math.max((e - w) * cosLat((s + n) / 2), n - s) * KM_PER_DEG;
}

const overlapsLon = (p: Part, [w, , e]: Bounds) => [-360, 0, 360].some((k) => p.w + k <= e && w <= p.e + k);

/** The outline's parts that lie outside `bounds`, nearby ones grouped, largest group first. */
export function farParts(outline: unknown, bounds: Bounds): RegionPart[] {
  const outside = polygonsOf(outline)
    .filter((r) => r.length >= 4)
    .map(partOf)
    .filter((p) => !(overlapsLon(p, bounds) && p.s <= bounds[3] && bounds[1] <= p.n))
    .sort((a, b) => b.km2 - a.km2);
  const groups: Part[][] = [];
  for (const p of outside) {
    const near = groups.find((g) => g.some((q) => gapKm(p, q) <= PART_GROUP_KM));
    if (near) near.push(p);
    else groups.push([p]);
  }
  const size = (g: Part[]) => g.reduce((sum, p) => sum + p.km2, 0);
  return groups
    .sort((a, b) => size(b) - size(a))
    .map((g) => {
      const [w, e] = lonSpan(g.map((p) => [p.w, p.e]));
      return { name: null, bounds: [w, Math.min(...g.map((p) => p.s)), e, Math.max(...g.map((p) => p.n))] };
    });
}

const memo = new WeakMap<object, Map<string, Framing | null>>();

/** A region's framing: a hand-tuned override for its eBird code (regionFraming.json), else the
 *  rule above (at a hub, over its countries' framings); with the far parts it leaves out. Memoised per outline, since outlines are large. */
export function regionFraming(outline: unknown, code?: string | null): Framing | null {
  const o = code ? OVERRIDES[code] : undefined;
  const hasOutline = !!outline && typeof outline === "object";
  if (!hasOutline) return o?.bounds ? withDefaults(o.bounds, o, o.parts ?? []) : null;
  const byCode = memo.get(outline) ?? new Map<string, Framing | null>();
  memo.set(outline, byCode);
  const key = code ?? "";
  if (byCode.has(key)) return byCode.get(key)!;
  // A hub covers each of its countries' own framings, so a small one far from a big one stays in.
  const countries = hubCountries(outline);
  const bounds =
    o?.bounds ??
    (countries
      ? openingBounds(
          [],
          countries.map((c) => regionFraming(c.outline, c.code)?.bounds).filter((b): b is Bounds => !!b),
        )
      : framingBounds(outline));
  const framing = bounds && withDefaults(bounds, o ?? {}, o?.parts ?? farParts(outline, bounds));
  byCode.set(key, framing);
  return framing;
}

/** A far part's own framing. */
export const partFraming = (part: RegionPart): Framing => withDefaults(part.bounds, {}, []);

function withDefaults(bounds: Bounds, o: Partial<Override>, parts: RegionPart[]): Framing {
  return {
    bounds,
    parts,
    pitch: o.pitch ?? PITCH_3D,
    exaggeration: o.exaggeration ?? (spanKm(bounds) > WIDE_KM ? 1.5 : 1.3),
  };
}

/** Pan stays within the framing plus a quarter of its size each way, and never less than the view
 *  at the framing (MapLibre would zoom in to fit a smaller box). */
export function panLimits([w, s, e, n]: Bounds, view?: Bounds): Bounds {
  const dx = (e - w) * PAN_SLACK;
  const dy = (n - s) * PAN_SLACK;
  const [vw, vs, ve, vn] = view ?? [w, s, e, n];
  return [
    Math.min(w - dx, vw),
    Math.max(-85, Math.min(s - dy, vs)),
    Math.max(e + dx, ve),
    Math.min(85, Math.max(n + dy, vn)),
  ];
}

/** The box a view can be held to: none when it already spans the world, as a wide, short map does
 *  for a tall country (Canada with its Arctic islands lands below zoom 1), since MapLibre snaps the
 *  camera to a wrong place when held to a box wider than the world. */
export function holdableView([w, s, e, n]: Bounds): Bounds | null {
  return e - w >= 360 ? null : [w, s, e, n];
}

/** Zooming out stops just past the framing. */
export const zoomFloor = (framingZoom: number): number => Math.max(0, framingZoom - 0.5);

/** The pitch for this zoom: the curated tilt in Auto with relief, else flat. `tilted` is whether
 *  the map is tilted now, for the hysteresis. */
export function curatedPitch(zoom: number, tilted: boolean, mode: TiltMode, relief: boolean): number {
  if (mode === "flat" || !relief) return 0;
  return zoom >= (tilted ? TILT.offZoom : TILT.onZoom) ? TILT.pitch : 0;
}

/** North up always; tilted only at the curated angle; no flight with reduced motion. */
export function regionCamera(framing: Framing, view3d: boolean, reducedMotion: boolean) {
  return { bearing: 0, pitch: view3d ? framing.pitch : 0, duration: reducedMotion ? 0 : FLY_MS };
}

/** One move onto a clicked mark: a cluster to the zoom where it splits, a dot, ring or spot about
 *  two levels closer; never out, never past `maxZoom`. Short moves are quicker; reduced motion jumps. */
export function markMove({
  zoom,
  expansionZoom,
  maxZoom = 12,
  reducedMotion,
}: {
  zoom: number;
  /** A cluster's: where it splits into its marks. */
  expansionZoom?: number | null;
  maxZoom?: number;
  reducedMotion: boolean;
}): { zoom: number; duration: number } {
  const wanted = expansionZoom ?? zoom + 2;
  const target = Math.max(zoom, Math.min(wanted, maxZoom));
  const duration = reducedMotion ? 0 : target - zoom < 1 ? 500 : 750;
  return { zoom: target, duration };
}

/** The screen point to zoom around so a mark at `from` (pixels) slides straight to `to` (the
 *  visible centre) while the map zooms in by `dz` levels: zooming around a fixed point scales every
 *  screen position away from it, so the mark moves along one line toward the centre, stays on
 *  screen and lands there as the zoom does. Null when there's hardly any zoom (a plain pan then). */
export function zoomAnchor(from: [number, number], to: [number, number], dz: number): [number, number] | null {
  const s = 2 ** dz;
  if (Math.abs(s - 1) < 0.05) return null;
  return [(to[0] - from[0] * s) / (1 - s), (to[1] - from[1] * s) / (1 - s)];
}

/** Where a mark is on screen partway through that zoom (`e` is the eased progress, 0 to 1). */
export function anchoredPosition(
  anchor: [number, number],
  from: [number, number],
  dz: number,
  e: number,
): [number, number] {
  const s = 2 ** (dz * e);
  return [anchor[0] + (from[0] - anchor[0]) * s, anchor[1] + (from[1] - anchor[1]) * s];
}

/** Ease-out for the region flight. */
export const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** The dimmed world outside a region: the world as one ring with the region's parts cut out. Holes
 *  wind opposite to the outer ring so every renderer reads them as holes. */
export function outsideMask(outline: unknown) {
  const world: Ring = [
    [-180, -89],
    [180, -89],
    [180, 89],
    [-180, 89],
    [-180, -89],
  ];
  const holes = polygonsOf(outline).map((r) => (signedArea(r) > 0 ? [...r].reverse() : r));
  return {
    type: "Feature" as const,
    properties: {},
    geometry: { type: "Polygon" as const, coordinates: [world, ...holes] },
  };
}

function signedArea(ring: Ring): number {
  let twice = 0;
  for (let i = 0; i < ring.length - 1; i++) twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return twice / 2;
}
