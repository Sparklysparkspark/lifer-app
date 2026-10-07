// Source: the intersect of the Exclusive Economic Zones and IHO sea areas, version 5 (Marine
// Regions, Flanders Marine Institute, 2024): every IHO sea area cut along national EEZ boundaries,
// e.g. "Chilean part of the South Pacific Ocean".
// License: CC BY 4.0. Required attribution: "Flanders Marine Institute (2024). The intersect of the
// Exclusive Economic Zones and IHO sea areas, version 5. Available online at
// https://www.marineregions.org/ https://doi.org/10.14284/699".
// Changes made here, which CC BY asks to be indicated: only the pieces of the seven oceans are used,
// without the high seas and the joint regime areas; each is reduced to the outline of its largest
// polygon and simplified to at most 80 points, as in fetch-iho-sea-areas.ts.
//
// fetch-iho-sea-areas.ts leaves the oceans out as zones (one would run from the equator to the
// pole), which left coasts facing only open ocean with no zone at all: Chile, Peru, Portugal,
// California, East Africa, most Pacific islands. A country's part of an ocean is bounded by its
// EEZ, at most 200 nautical miles offshore, so it stays a coastal zone. The named seas still come
// from IHO Sea Areas, unsplit: a sea is a more useful "nearby water" than a country's share of it.
// Read from Marine Regions' public WFS (layer "The intersect of the Exclusive Economic Zones and IHO
// areas (v5)"), filtered server side to the ocean pieces: about 90 MB, cached in data/raw.
import { readFileSync } from "node:fs";
import { fetchCached } from "@lifer/core/rawCache.js";
import { seaZoneFromGeometry, type SeaZone } from "./fetch-iho-sea-areas.js";

export const OCEANS = [
  "North Atlantic Ocean",
  "South Atlantic Ocean",
  "North Pacific Ocean",
  "South Pacific Ocean",
  "Indian Ocean",
  "Arctic Ocean",
  "Southern Ocean",
];

const EEZ_IHO_WFS_URL =
  "https://geo.vliz.be/geoserver/MarineRegions/wfs?service=WFS&version=1.0.0&request=GetFeature" +
  "&typeName=MarineRegions:eez_iho&outputFormat=application/json&CQL_FILTER=" +
  encodeURIComponent(`iho_sea IN (${OCEANS.map((o) => `'${o}'`).join(",")}) AND eez IS NOT NULL`);

export interface EezIhoFeature {
  properties: { marregion?: string | null; iho_sea?: string | null; eez?: string | null };
  geometry: { type: string; coordinates: unknown } | null;
}

// A joint regime area is a patch of open sea two countries manage together, between their EEZs
// and away from either coast, so no region would ever border it. Overlapping claims are kept: they
// surround islands (the Falklands, Mayotte, the Kurils). The high seas have no EEZ and are filtered
// out by the request already; checked again here in case the cached file predates that.
function isCoastalPiece(p: EezIhoFeature["properties"]): boolean {
  return !!p.eez && !!p.iho_sea && OCEANS.includes(p.iho_sea) && !p.marregion?.startsWith("Joint regime area");
}

export function oceanZonesFromFeatures(features: EezIhoFeature[]): SeaZone[] {
  const zones: SeaZone[] = [];
  for (const feature of features) {
    const name = feature.properties.marregion?.trim();
    if (!name || !feature.geometry || !isCoastalPiece(feature.properties)) continue;
    const zone = seaZoneFromGeometry(name, feature.geometry);
    if (zone) zones.push(zone);
  }
  return zones;
}

/** The raw ocean pieces at full resolution (also read by compute-sea-zones-offline.ts). */
export async function loadEezIhoFeatures(): Promise<EezIhoFeature[]> {
  const path = await fetchCached("eez-iho", "eez-iho-v5-oceans.geojson", EEZ_IHO_WFS_URL);
  return (JSON.parse(readFileSync(path, "utf-8")) as { features: EezIhoFeature[] }).features;
}

export async function fetchOceanEezZones(): Promise<SeaZone[]> {
  const data = { features: await loadEezIhoFeatures() };
  const zones = oceanZonesFromFeatures(data.features);
  console.log(`[eez-iho] parsed ${zones.length} sea zones from ${data.features.length} national parts of the oceans`);
  return zones;
}
