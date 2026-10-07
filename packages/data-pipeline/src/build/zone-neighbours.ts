// Which sea zones border each other, from their outlines: two zones are neighbours when a vertex
// of one lies within about one grid cell of a vertex of the other. Neighbouring IHO seas and EEZ
// parts share their boundary lines, so their vertices land in the same or adjacent cells, while
// zones on different coasts never do. Used to tell a species at the edge of its range from one
// recorded in the wrong ocean (see sea-zone-checklist.ts).
import type { Point } from "@lifer/core/lib/geometry.js";

export const NEIGHBOUR_CELL_DEGREES = 0.25;

function cellKey(x: number, y: number, columns: number): number {
  // Longitude wraps, so a zone on either side of the antimeridian still meets its neighbour.
  const wrapped = ((x % columns) + columns) % columns;
  return y * columns + wrapped;
}

/** For each zone index, the indexes of the zones bordering it (never itself). */
export function zoneNeighbours(zones: Point[][][], cellDegrees = NEIGHBOUR_CELL_DEGREES): Map<number, Set<number>> {
  const columns = Math.round(360 / cellDegrees);
  const zonesByCell = new Map<number, Set<number>>();
  zones.forEach((rings, zi) => {
    for (const ring of rings) {
      for (const [lon, lat] of ring) {
        const key = cellKey(Math.floor((lon + 180) / cellDegrees), Math.floor((lat + 90) / cellDegrees), columns);
        let set = zonesByCell.get(key);
        if (!set) zonesByCell.set(key, (set = new Set()));
        set.add(zi);
      }
    }
  });
  const neighbours = new Map<number, Set<number>>(zones.map((_, zi) => [zi, new Set<number>()]));
  for (const [key, here] of zonesByCell) {
    const y = Math.floor(key / columns);
    const x = key % columns;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const there = zonesByCell.get(cellKey(x + dx, y + dy, columns));
        if (!there) continue;
        for (const a of here) for (const b of there) if (a !== b) neighbours.get(a)!.add(b);
      }
    }
  }
  return neighbours;
}
