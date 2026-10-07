// Point-in-polygon against the sea zones' full-resolution outlines (hundreds of thousands of
// vertices each), fast enough for every fish record in the GBIF country downloads. Each zone's
// edges are bucketed into thin latitude bands, so a ray cast only looks at the edges of the
// point's own band, and a coarse grid of zone bounding boxes picks the candidate zones.
import type { Point } from "@lifer/core/lib/geometry.js";

// ~1km bands: a detailed sea's band then holds a few hundred edges at most.
const BAND_DEGREES = 0.01;
const GRID_DEGREES = 1;

interface IndexedZone {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
  // Band index -> flat edges [x1, y1, x2, y2, ...] crossing that band.
  bands: Map<number, Float64Array>;
}

function bandOf(lat: number): number {
  return Math.floor(lat / BAND_DEGREES);
}

function gridKey(lonCell: number, latCell: number): number {
  return (latCell + 200) * 1000 + (lonCell + 400);
}

export class ZonePolygonIndex {
  private readonly zones: IndexedZone[] = [];
  private readonly grid = new Map<number, number[]>();

  /** `rings` are every ring of a zone, exterior and holes alike: the even-odd rule makes a hole
   *  (an island) count as outside and a second part count as inside. */
  constructor(zones: Array<{ rings: Point[][] }>) {
    zones.forEach((zone, zi) => {
      let minLon = Infinity;
      let minLat = Infinity;
      let maxLon = -Infinity;
      let maxLat = -Infinity;
      const lists = new Map<number, number[]>();
      for (const ring of zone.rings) {
        for (let i = 0; i < ring.length - 1; i++) {
          const [x1, y1] = ring[i];
          const [x2, y2] = ring[i + 1];
          if (x1 < minLon) minLon = x1;
          if (x1 > maxLon) maxLon = x1;
          if (y1 < minLat) minLat = y1;
          if (y1 > maxLat) maxLat = y1;
          // A horizontal edge never crosses a horizontal ray.
          if (y1 === y2) continue;
          for (let b = bandOf(Math.min(y1, y2)); b <= bandOf(Math.max(y1, y2)); b++) {
            const list = lists.get(b);
            if (list) list.push(x1, y1, x2, y2);
            else lists.set(b, [x1, y1, x2, y2]);
          }
        }
      }
      const bands = new Map<number, Float64Array>();
      for (const [b, list] of lists) bands.set(b, Float64Array.from(list));
      this.zones.push({ minLon, minLat, maxLon, maxLat, bands });
      if (minLon > maxLon) return; // no edges
      for (let cx = Math.floor(minLon / GRID_DEGREES); cx <= Math.floor(maxLon / GRID_DEGREES); cx++) {
        for (let cy = Math.floor(minLat / GRID_DEGREES); cy <= Math.floor(maxLat / GRID_DEGREES); cy++) {
          const key = gridKey(cx, cy);
          const list = this.grid.get(key);
          if (list) list.push(zi);
          else this.grid.set(key, [zi]);
        }
      }
    });
  }

  /** Indexes (in constructor order) of the zones containing the point. */
  zonesContaining(lon: number, lat: number): number[] {
    const candidates = this.grid.get(gridKey(Math.floor(lon / GRID_DEGREES), Math.floor(lat / GRID_DEGREES)));
    if (!candidates) return [];
    const found: number[] = [];
    for (const zi of candidates) {
      const zone = this.zones[zi];
      if (lon < zone.minLon || lon > zone.maxLon || lat < zone.minLat || lat > zone.maxLat) continue;
      const edges = zone.bands.get(bandOf(lat));
      if (!edges) continue;
      let inside = false;
      for (let i = 0; i < edges.length; i += 4) {
        const x1 = edges[i];
        const y1 = edges[i + 1];
        const x2 = edges[i + 2];
        const y2 = edges[i + 3];
        if (y1 > lat === y2 > lat) continue;
        if (lon < x1 + ((lat - y1) / (y2 - y1)) * (x2 - x1)) inside = !inside;
      }
      if (inside) found.push(zi);
    }
    return found;
  }
}
