// What the photo map clusters: a feature per grid cell of placed photos and one per region with
// photos that have only a region (a hollow ring), all in one source so they merge as you zoom out.
import { taxaGroup } from "./taxaColour";

interface Cell {
  lat: number;
  lon: number;
  count: number;
  photoId: string;
  taxonClass: string | null;
  iconicTaxon: string | null;
}
interface Region {
  id: string;
  name: string;
  regionOnlyCount: number;
  lat: number | null;
  lon: number | null;
}

export interface MarkProps {
  count: number;
  /** Photos with coordinates: a cell's, never a ring's. */
  placed: number;
  /** Photos with only a region: a ring's, never a cell's. */
  regionOnly: number;
  ring: boolean;
  photoId?: string;
  group?: string;
  id?: string;
  name?: string;
}

/** The map's deepest zoom (MapLibre's default), and clustering runs all the way to it, so marks
 *  closer than the cluster radius merge at every zoom and never stack. */
export const MAP_MAX_ZOOM = 22;
export const PHOTO_CLUSTERING = { cluster: true, clusterRadius: 40, clusterMaxZoom: MAP_MAX_ZOOM } as const;
// About 3 screen pixels at the deepest zoom: points closer than this are the same spot.
export const SAME_POINT_DEGREES = (3 * 360) / (256 * 2 ** MAP_MAX_ZOOM);

/** Cells at the same point (or within SAME_POINT_DEGREES of one) as one cell with their counts
 *  summed, led by the first (the API sends the biggest first). */
export function mergeSamePoint<C extends Cell>(cells: readonly C[]): C[] {
  const out: C[] = [];
  const at = new Map<string, number[]>();
  const key = (i: number, j: number) => `${i}:${j}`;
  for (const c of cells) {
    const i = Math.round(c.lat / SAME_POINT_DEGREES);
    const j = Math.round(c.lon / SAME_POINT_DEGREES);
    let into = -1;
    // The neighbouring buckets too, so two points either side of a bucket edge still meet.
    for (let di = -1; di <= 1 && into < 0; di++)
      for (let dj = -1; dj <= 1 && into < 0; dj++)
        for (const k of at.get(key(i + di, j + dj)) ?? []) {
          const o = out[k];
          if (Math.abs(o.lat - c.lat) <= SAME_POINT_DEGREES && Math.abs(o.lon - c.lon) <= SAME_POINT_DEGREES) {
            into = k;
            break;
          }
        }
    if (into >= 0) out[into] = { ...out[into], count: out[into].count + c.count };
    else {
      at.set(key(i, j), [...(at.get(key(i, j)) ?? []), out.length]);
      out.push({ ...c });
    }
  }
  return out;
}

export function photoFeatures(cells: readonly Cell[], regions: readonly Region[]) {
  const point = (lon: number, lat: number) => ({ type: "Point" as const, coordinates: [lon, lat] });
  return [
    ...mergeSamePoint(cells).map((c) => ({
      type: "Feature" as const,
      properties: {
        count: c.count,
        placed: c.count,
        regionOnly: 0,
        ring: false,
        photoId: c.photoId,
        group: taxaGroup(c.taxonClass, c.iconicTaxon),
      } satisfies MarkProps,
      geometry: point(c.lon, c.lat),
    })),
    // A placed photo is its dot, never also part of a ring.
    ...regions
      .filter((r) => r.regionOnlyCount > 0 && r.lat !== null && r.lon !== null)
      .map((r) => ({
        type: "Feature" as const,
        properties: {
          count: r.regionOnlyCount,
          placed: 0,
          regionOnly: r.regionOnlyCount,
          ring: true,
          id: r.id,
          name: r.name,
        } satisfies MarkProps,
        geometry: point(r.lon!, r.lat!),
      })),
  ];
}

/** The source's cluster sums (MapLibre clusterProperties): each cluster adds up its marks'. */
export const CLUSTER_SUMS = {
  total: ["+", ["get", "count"]],
  placed: ["+", ["get", "placed"]],
  regionOnly: ["+", ["get", "regionOnly"]],
};

/** What a cluster made of `marks` reports, the same sums the map makes. */
export function clusterTotals(marks: readonly Pick<MarkProps, "count" | "placed" | "regionOnly">[]) {
  return marks.reduce(
    (t, m) => ({ total: t.total + m.count, placed: t.placed + m.placed, regionOnly: t.regionOnly + m.regionOnly }),
    { total: 0, placed: 0, regionOnly: 0 },
  );
}
