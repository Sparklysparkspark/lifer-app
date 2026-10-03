import { setWorkerUrl, addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";
// MapLibre builds its worker URL at runtime, which the production bundle can't see; `?url`
// makes Vite emit the worker file and hand back its real path.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { PMTILES_URL } from "./pmtilesAvailable";
setWorkerUrl(maplibreWorkerUrl);

// Self-hosted offline basemap: a Protomaps PMTiles archive (zoom 0-8) served by our API, with
// the style layers generated client-side. No sprites or glyphs yet, so no labels or POI icons.
export { PMTILES_URL, checkPmtilesAvailable } from "./pmtilesAvailable";
export const PMTILES_SOURCE_ID = "protomaps";

let protocolRegistered = false;
export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

// maxzoom must match the archive's real max (8) so deeper zooms reuse z8 tiles instead of
// requesting ones that don't exist.
export function pmtilesStyle(theme: "light" | "dark"): StyleSpecification {
  const absolutePmtilesUrl = new URL(PMTILES_URL, window.location.origin).toString();
  return {
    version: 8,
    sources: {
      [PMTILES_SOURCE_ID]: { type: "vector", url: `pmtiles://${absolutePmtilesUrl}`, maxzoom: 8 },
    },
    layers: layers(PMTILES_SOURCE_ID, namedFlavor(theme === "dark" ? "dark" : "light"), { lang: "en" }),
  };
}
