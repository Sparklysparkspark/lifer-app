// Ocean basins for sea zones, so a species is only kept at the edge of its range by a neighbour in
// the same ocean. Zones whose outlines touch across a land bridge (the Caribbean and Panama's
// Pacific coast, the two South African coasts) are neighbours to zoneNeighbours but share no fauna.
//
// Two zones of different basins whose outlines share a boundary at sea (the two South African
// coasts meet along a line off Cape Agulhas) are one coast, not a land bridge: only pairs that
// merely come close across land (Panama, Suez) separate the basins.
//
// A national part of an ocean names its ocean ("Panamanian part of the North Pacific Ocean"); a
// named sea takes the basin most of its neighbours have, repeated until nothing changes. Indian and
// Pacific are one basin (the Indo-Pacific fauna spans both); Arctic and Southern Ocean zones are
// "polar" and count as the same basin as anything, since they join the others by open sea.
import type { Point } from "@lifer/core/lib/geometry.js";
import { GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS, looksLikeGeographicOutlier } from "../regions/buildRegionSpecies.js";

export type Basin = "atlantic" | "indo-pacific" | "polar";

// Zones centred this far north or south are polar whatever their name: the Arctic seas link both
// oceans, and Tierra del Fuego's waters are one fauna on both sides of the strait.
const POLAR_NORTH = 66;
const POLAR_SOUTH = -50;

export interface ZoneShape {
  name: string;
  minLat: number;
  maxLat: number;
}

/** The basin a zone's own name or latitude gives, or null for a named sea. */
export function basinFromZone({ name, minLat, maxLat }: ZoneShape): Basin | null {
  const mid = (minLat + maxLat) / 2;
  if (mid >= POLAR_NORTH || mid <= POLAR_SOUTH) return "polar";
  if (/\bAtlantic Ocean\b/.test(name)) return "atlantic";
  if (/\b(Pacific|Indian) Ocean\b/.test(name)) return "indo-pacific";
  if (/\b(Arctic|Southern) Ocean\b/.test(name)) return "polar";
  return null;
}

// Vertices this close count as shared: neighbouring zones from one source repeat each other's
// boundary points, while coasts on either side of an isthmus share only a few by chance.
const SHARED_VERTEX_DEGREES = 0.001;
const MIN_SHARED_VERTICES = 10;

/** Whether two zones share a stretch of boundary at sea (many near-identical vertices). */
export function sharesSeaBoundary(a: Point[][], b: Point[][]): boolean {
  const key = (x: number, y: number) => `${Math.round(x / SHARED_VERTEX_DEGREES)},${Math.round(y / SHARED_VERTEX_DEGREES)}`;
  const seen = new Set<string>();
  for (const ring of a) for (const [x, y] of ring) seen.add(key(x, y));
  let shared = 0;
  for (const ring of b)
    for (const [x, y] of ring) {
      const kx = Math.round(x / SHARED_VERTEX_DEGREES);
      const ky = Math.round(y / SHARED_VERTEX_DEGREES);
      if ([-1, 0, 1].some((dx) => [-1, 0, 1].some((dy) => seen.has(`${kx + dx},${ky + dy}`))) && ++shared >= MIN_SHARED_VERTICES)
        return true;
    }
  return false;
}

/** Neighbour pairs in different basins that only meet across land, as "i|j" keys both ways.
 *  `seaLinks` ("i|j") are reviewed pairs a canal joins (Suez), which count as sea. */
export function landBridges(
  rings: Point[][][],
  basins: Array<Basin | undefined>,
  neighbours: Map<number, Set<number>>,
  seaLinks: Set<string> = new Set(),
): Set<string> {
  const out = new Set<string>();
  for (const [i, set] of neighbours)
    for (const j of set)
      if (
        i < j &&
        !sameBasin(basins[i], basins[j]) &&
        !seaLinks.has(`${i}|${j}`) &&
        !seaLinks.has(`${j}|${i}`) &&
        !sharesSeaBoundary(rings[i], rings[j])
      ) {
        out.add(`${i}|${j}`);
        out.add(`${j}|${i}`);
      }
  return out;
}

export const sameBasin = (a: Basin | undefined, b: Basin | undefined): boolean =>
  a === undefined || b === undefined || a === b || a === "polar" || b === "polar";

/** Every zone's basin, by index. A named sea none of whose neighbours ever gets a basin stays
 *  undefined, which sameBasin treats as matching anything. */
export function assignBasins(zones: ZoneShape[], neighbours: Map<number, Set<number>>): Array<Basin | undefined> {
  const basins: Array<Basin | undefined> = zones.map((z) => basinFromZone(z) ?? undefined);
  const fixed = basins.map((b) => b !== undefined);
  for (let round = 0; round < zones.length; round++) {
    let changed = false;
    const next = [...basins];
    zones.forEach((_, zi) => {
      if (fixed[zi]) return;
      const votes = new Map<Basin, number>();
      for (const nz of neighbours.get(zi) ?? []) {
        const b = basins[nz];
        if (b && b !== "polar") votes.set(b, (votes.get(b) ?? 0) + 1);
      }
      // Ties go to the basin first reached in alphabetical order, so the result never depends on input order.
      const best = [...votes].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))[0]?.[0];
      if (best && best !== basins[zi]) {
        next[zi] = best;
        changed = true;
      }
    });
    basins.splice(0, basins.length, ...next);
    if (!changed) break;
  }
  return basins;
}

// A species is a stray in a basin when the whole basin has at most STRAY_BASIN_RECORDS of its
// records and another basin STRAY_RATIO times as many, or at most OVERWHELMED_BASIN_RECORDS
// against OVERWHELMED_RATIO times as many (Blacktip Reef Shark: 41 Atlantic, 226,680 Indo-Pacific).
// The absolute caps keep wide-ranging species (Bull Shark, Spinner Dolphin) whose Atlantic records
// are a small share but still hundreds.
export const STRAY_BASIN_RECORDS = 10;
export const STRAY_RATIO = 20;
export const OVERWHELMED_BASIN_RECORDS = 50;
export const OVERWHELMED_RATIO = 1000;

export interface ZoneSpeciesRow {
  zone: number;
  speciesId: string;
  recordCount: number;
}

export interface StrayDecision extends ZoneSpeciesRow {
  rule: "edge-across-basin" | "basin-stray" | "deep-sea-review";
  reason: string;
}

export interface StrayInputs {
  basins: Array<Basin | undefined>;
  neighbours: Map<number, Set<number>>;
  /** From landBridges. */
  bridges: Set<string>;
  zoneNames: string[];
  globalCount: Map<string, number>;
  marineOrBrackish: Set<string>;
  /** Reviewed species that really live in both basins. */
  allow: Set<string>;
  /** Deep-sea species: so thinly sampled that few records in one ocean prove little, so a stray
   *  among them is listed for review, not removed. */
  deep: Set<string>;
}

/** The rows to drop: an edge-of-range species kept only by a neighbour across a land bridge and
 *  well recorded nowhere in its own basin (the builder's exemption, applied again without those
 *  neighbours), and strays recorded overwhelmingly in another basin. A zone that meets another basin at sea shares its fauna, so
 *  the stray rule skips it. */
export function decideBasinStrays(rows: ZoneSpeciesRow[], inputs: StrayInputs): StrayDecision[] {
  const { basins, neighbours, zoneNames, bridges } = inputs;
  const junction = new Set<number>();
  // Zones that meet another basin at sea, or a polar sea (Arctic fish reach both oceans through it).
  for (const [i, set] of neighbours)
    for (const j of set)
      if (basins[j] === "polar" || (!sameBasin(basins[i], basins[j]) && !bridges.has(`${i}|${j}`))) junction.add(i);
  const count = new Map<string, number>();
  const totals = new Map<string, Map<Basin, number>>();
  const most = new Map<string, number>();
  for (const r of rows) {
    count.set(`${r.zone}|${r.speciesId}`, r.recordCount);
    const b = basins[r.zone];
    if (!b || b === "polar") continue;
    let t = totals.get(r.speciesId);
    if (!t) totals.set(r.speciesId, (t = new Map()));
    t.set(b, (t.get(b) ?? 0) + r.recordCount);
    const key = `${b}|${r.speciesId}`;
    most.set(key, Math.max(most.get(key) ?? 0, r.recordCount));
  }
  const out: StrayDecision[] = [];
  for (const r of rows) {
    if (inputs.allow.has(r.speciesId)) continue;
    const here = basins[r.zone];
    const t = totals.get(r.speciesId);
    if (here && here !== "polar" && t && !junction.has(r.zone)) {
      const mine = t.get(here) ?? 0;
      const other = Math.max(0, ...[...t].filter(([b]) => b !== here).map(([, n]) => n));
      if (
        (mine <= STRAY_BASIN_RECORDS && other >= STRAY_RATIO * mine) ||
        (mine <= OVERWHELMED_BASIN_RECORDS && other >= OVERWHELMED_RATIO * mine)
      ) {
        out.push({
          ...r,
          rule: inputs.deep.has(r.speciesId) ? "deep-sea-review" : "basin-stray",
          reason: `${mine} records in the ${here} basin, ${other} in another`,
        });
        continue;
      }
    }
    if (
      (most.get(`${here}|${r.speciesId}`) ?? 0) > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS ||
      !inputs.marineOrBrackish.has(r.speciesId) ||
      !looksLikeGeographicOutlier(r.recordCount, inputs.globalCount.get(r.speciesId) ?? 0)
    )
      continue;
    const wellRecorded = [...(neighbours.get(r.zone) ?? [])].filter(
      (nz) => (count.get(`${nz}|${r.speciesId}`) ?? 0) > GEOGRAPHIC_OUTLIER_MAX_LOCAL_RECORDS,
    );
    if (wellRecorded.length > 0 && wellRecorded.every((nz) => bridges.has(`${r.zone}|${nz}`))) {
      out.push({
        ...r,
        rule: inputs.deep.has(r.speciesId) ? "deep-sea-review" : "edge-across-basin",
        reason: `kept only because ${zoneNames[wellRecorded[0]]} has it well recorded, across a land bridge`,
      });
    }
  }
  return out;
}
