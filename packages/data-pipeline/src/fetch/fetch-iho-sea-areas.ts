// Source: IHO Sea Areas, version 3 (Marine Regions, Flanders Marine Institute, 2018): the limits
// of the world's oceans and seas from the International Hydrographic Organization's "Limits of
// Oceans and Seas" (Special Publication 23, 1953), 101 named areas.
// License: CC BY 4.0. Required attribution: "Flanders Marine Institute (2018). IHO Sea Areas,
// version 3. Available online at https://www.marineregions.org/ https://doi.org/10.14284/323".
// Marine Regions also asks users to point to https://www.marineregions.org/ for current versions.
// Changes made here, which CC BY asks to be indicated: each area is reduced to the outline of its
// largest polygon (holes and smaller pieces dropped) and simplified to at most MAX_WKT_POINTS
// points; the seven oceans are left out (see OPEN_OCEANS and wrapsTheGlobe), their coastal
// waters coming from fetch-eez-iho.ts instead.
//
// Replaces Marine Ecoregions of the World, whose license forbade both altering and redistributing
// it, which the catalog seed's sea_zones table does to every source here. The downloads page on
// marineregions.org sits behind a form, so this reads the same layer ("IHO Sea Areas (v3)") from
// Marine Regions' public WFS: full-resolution GeoJSON, about 250 MB, a download of several minutes,
// cached in data/raw like every other source.
import { readFileSync } from "node:fs";
import { fetchCached } from "@lifer/core/rawCache.js";
import {
  simplifyRingToMaxPointsRepaired,
  ensureCounterClockwise,
  ringToWktPolygon,
  ringBoundingBox,
  type Point,
  type BoundingBox,
} from "@lifer/core/lib/geometry.js";

const IHO_WFS_URL =
  "https://geo.vliz.be/geoserver/MarineRegions/wfs?service=WFS&version=1.0.0&request=GetFeature&typeName=MarineRegions:iho&outputFormat=application/json";

// Two undocumented GBIF limits stack here, both found empirically: (1) the `geometry` WKT param
// rejects rings above ~170 coordinates; (2) the whole request URL fails around 3,840
// characters. Fish queries repeat up to 52 taxonKeys (~710 characters, see
// fetch-fish-orders.ts), leaving much less room for geometry. 80 points keeps a realistic shape
// at ~2,500 URL characters with all fish keys attached.
const MAX_WKT_POINTS = 80;

export interface SeaZone {
  name: string;
  // What GBIF is queried with and what installs store.
  wkt: string;
  bbox: BoundingBox;
  // The same ring at full resolution, only for working out which regions it's near
  // (nearby-sea-zones.ts). Never stored.
  outline: Point[];
}

export interface IhoFeature {
  properties: { name?: string | null };
  geometry: { type: string; coordinates: unknown } | null;
}

// A whole ocean is one area from the equator to the pole. Its checklist would be every fish across
// the basin, 5,500 (North Atlantic) to 9,100 (Indian) species in GBIF, which is no one's "nearby
// water", and every bordering country's fish pack would pull it in as a dependency. The coasts IHO
// gives only to an ocean (California, Portugal, Chile, East Africa, most Pacific islands) get each
// country's own part of it instead, from fetch-eez-iho.ts.
export const OPEN_OCEANS = new Set([
  "North Atlantic Ocean",
  "South Atlantic Ocean",
  "North Pacific Ocean",
  "South Pacific Ocean",
  "Indian Ocean",
]);

// Shoelace area in square degrees: only compared between pieces of the same area, so the
// distortion away from the equator doesn't matter.
function ringArea(ring: Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length - 1; i++) sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return Math.abs(sum / 2);
}

// The Arctic and Southern Oceans each come as one ring running from -180 to 180 around a pole,
// which a lon/lat polygon can't express as an area GBIF understands. Areas that merely cross the
// antimeridian (Bering Sea, the Pacific) come already split at it into separate pieces, so no
// single piece of theirs touches both edges.
function wrapsTheGlobe(bbox: BoundingBox): boolean {
  return bbox.minLon <= -179.9 && bbox.maxLon >= 179.9;
}

// One zone from an area's geometry, or null for one that can't be a zone (no polygon, or a ring
// around a pole). Shared with fetch-eez-iho.ts.
export function seaZoneFromGeometry(name: string, geometry: { type: string; coordinates: unknown }): SeaZone | null {
  let exteriorRings: Point[][];
  if (geometry.type === "Polygon") {
    exteriorRings = [(geometry.coordinates as Point[][])[0]];
  } else if (geometry.type === "MultiPolygon") {
    exteriorRings = (geometry.coordinates as Point[][][]).map((poly) => poly[0]);
  } else {
    return null;
  }
  // Largest by area, not by vertex count as for the old MEOW zones: the South Pacific's most
  // detailed piece is the small part west of the antimeridian, not the main ocean.
  const largest = exteriorRings.reduce((a, b) => (ringArea(b) > ringArea(a) ? b : a));
  const bbox = ringBoundingBox(largest);
  if (wrapsTheGlobe(bbox)) return null;
  const simplified = ensureCounterClockwise(simplifyRingToMaxPointsRepaired(largest, MAX_WKT_POINTS));
  return { name, wkt: ringToWktPolygon(simplified), bbox, outline: largest };
}

export function seaZonesFromFeatures(features: IhoFeature[]): SeaZone[] {
  const zones: SeaZone[] = [];
  for (const feature of features) {
    const name = feature.properties.name?.trim();
    if (!name || !feature.geometry || OPEN_OCEANS.has(name)) continue;
    const zone = seaZoneFromGeometry(name, feature.geometry);
    if (zone) zones.push(zone);
  }
  return zones;
}

/** The raw IHO features at full resolution (also read by compute-sea-zones-offline.ts). */
export async function loadIhoFeatures(): Promise<IhoFeature[]> {
  const path = await fetchCached("iho-sea-areas", "iho-sea-areas-v3.geojson", IHO_WFS_URL);
  return (JSON.parse(readFileSync(path, "utf-8")) as { features: IhoFeature[] }).features;
}

export async function fetchIhoSeaAreas(): Promise<SeaZone[]> {
  const data = { features: await loadIhoFeatures() };
  const zones = seaZonesFromFeatures(data.features);
  console.log(`[iho-sea-areas] parsed ${zones.length} sea zones from ${data.features.length} IHO sea areas`);
  return zones;
}

async function main() {
  const zones = await fetchIhoSeaAreas();
  console.log(
    zones
      .slice(0, 5)
      .map((z) => ({ name: z.name, wktLength: z.wkt.length, outlinePoints: z.outline.length, bbox: z.bbox })),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
