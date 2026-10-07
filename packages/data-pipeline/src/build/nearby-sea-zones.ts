// Which sea zones count as a region's "nearby water", precomputed into regions.nearby_sea_zone_ids
// from each zone's full-resolution outline. The API's live fallback (apps/api regions/nearbyZones.ts)
// measures vertex to vertex against the stored 80-point WKT, which worked for the small MEOW
// ecoregions but not for IHO sea areas: an 80-point Caribbean Sea has vertices hundreds of km
// apart, so Costa Rica, Honduras or Ghana matched nothing. The catalog seed ships this column, so
// installs never need the fallback for catalog regions.
import { ringBoundingBox, pointInRing, type BoundingBox, type Point } from "@lifer/core/lib/geometry.js";

// IHO limits follow the coastline itself, so a coastal region touches its zone up to the small
// mismatch between Natural Earth's and IHO's coastlines. ~11km also admits a province whose
// boundary stops just short of the shore, but not an inland one.
export const NEARBY_SEA_ZONE_MAX_DISTANCE_DEGREES = 0.1;

// Neighbouring countries' parts of an ocean meet where their land border reaches the sea, so a
// coastal border region also comes within reach of its neighbour's part. Each stretch of boundary
// counts only for the zone nearest it, which leaves the neighbour's part little more than the
// meeting point, and a zone needs ~11km of the region's boundary: enough to drop those corners,
// short enough for the shortest real coasts (Jordan's is 26km).
export const MIN_SHARED_BOUNDARY_DEGREES = 0.1;
const TIE_DEGREES = 0.01;

// Grid cells must be at least the distance cutoff wide, so a point's 3x3 neighbourhood covers
// every segment that could be within it.
const CELL_DEGREES = 0.5;

export interface ZoneOutline {
  id: string;
  ring: Point[];
}

interface Segment {
  zone: number;
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

function cellKey(cx: number, cy: number): number {
  // Shifted so both indexes are non-negative; 1000 cells per row covers -180..180 at 0.5 degrees.
  return (cy + 400) * 1000 + (cx + 400);
}

function pointSegmentDistance(px: number, py: number, s: Segment): number {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - s.ax) * dx + (py - s.ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + t * dx), py - (s.ay + t * dy));
}

/** Every zone outline's segments, bucketed by grid cell, built once for all regions. */
export class ZoneSegmentIndex {
  private readonly cells = new Map<number, Segment[]>();
  readonly bboxes: BoundingBox[];

  constructor(readonly zones: ZoneOutline[]) {
    this.bboxes = zones.map((z) => ringBoundingBox(z.ring));
    zones.forEach((zone, zi) => {
      for (let i = 0; i < zone.ring.length - 1; i++) {
        const [ax, ay] = zone.ring[i];
        const [bx, by] = zone.ring[i + 1];
        const seg: Segment = { zone: zi, ax, ay, bx, by };
        const x0 = Math.floor(Math.min(ax, bx) / CELL_DEGREES);
        const x1 = Math.floor(Math.max(ax, bx) / CELL_DEGREES);
        const y0 = Math.floor(Math.min(ay, by) / CELL_DEGREES);
        const y1 = Math.floor(Math.max(ay, by) / CELL_DEGREES);
        for (let cx = x0; cx <= x1; cx++) {
          for (let cy = y0; cy <= y1; cy++) {
            const key = cellKey(cx, cy);
            const list = this.cells.get(key);
            if (list) list.push(seg);
            else this.cells.set(key, [seg]);
          }
        }
      }
    });
  }

  // The zone nearest a point within maxDistance (`closest`), and the zone that point's coast
  // belongs to (`owner`): the same one, unless another is about as near (within TIE_DEGREES). That
  // is the point where two zones meet, which belongs to neither; a coast belongs to the water right
  // off it, not to a zone a few km further out.
  private nearest(px: number, py: number, maxDistance: number): { owner: number | null; closest: [number, number] | null } {
    const distances = new Map<number, number>();
    const cx = Math.floor(px / CELL_DEGREES);
    const cy = Math.floor(py / CELL_DEGREES);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const seg of this.cells.get(cellKey(cx + dx, cy + dy)) ?? []) {
          const d = pointSegmentDistance(px, py, seg);
          if (d <= maxDistance && d < (distances.get(seg.zone) ?? Infinity)) distances.set(seg.zone, d);
        }
      }
    }
    const sorted = [...distances].sort((a, b) => a[1] - b[1]);
    if (sorted.length === 0) return { owner: null, closest: null };
    const tied = sorted.length > 1 && sorted[1][1] - sorted[0][1] <= TIE_DEGREES;
    return { owner: tied ? null : sorted[0][0], closest: sorted[0] };
  }

  /** Ids of the zones that run along enough of the region's boundary, or that contain one of its
   *  parts (an island inside a sea, which the outline only carries as a hole). */
  nearbyZoneIds(regionRings: Point[][], maxDistance = NEARBY_SEA_ZONE_MAX_DISTANCE_DEGREES): string[] {
    const found = new Set<number>();
    let closest: [number, number] | null = null;
    for (const ring of regionRings) {
      if (ring.length === 0) continue;
      // Boundary length along each zone: the edges whose both ends belong to it.
      const shared = new Map<number, number>();
      let perimeter = 0;
      let previous: number | null = null;
      for (let i = 0; i < ring.length; i++) {
        const point = this.nearest(ring[i][0], ring[i][1], maxDistance);
        if (point.closest && (!closest || point.closest[1] < closest[1])) closest = point.closest;
        if (i > 0) {
          const length = Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
          perimeter += length;
          if (point.owner !== null && point.owner === previous) shared.set(point.owner, (shared.get(point.owner) ?? 0) + length);
        }
        previous = point.owner;
      }
      // An islet shorter than the minimum counts with half its coast on the zone.
      const needed = Math.min(MIN_SHARED_BOUNDARY_DEGREES, perimeter / 2);
      for (const [zi, length] of shared) if (length >= needed) found.add(zi);

      const [x, y] = ring[0];
      this.zones.forEach((zone, zi) => {
        if (found.has(zi)) return;
        const b = this.bboxes[zi];
        if (x < b.minLon || x > b.maxLon || y < b.minLat || y > b.maxLat) return;
        if (pointInRing(ring[0], zone.ring)) found.add(zi);
      });
    }
    // A coast too short to pass on its own, all of it near where zones meet (Gibraltar's), still
    // gets the nearest one rather than none.
    if (found.size === 0 && closest) found.add(closest[0]);
    return [...found].sort((a, b) => a - b).map((zi) => this.zones[zi].id);
  }
}
