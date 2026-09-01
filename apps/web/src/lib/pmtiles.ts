import { setWorkerUrl, addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import type { StyleSpecification } from "maplibre-gl";
// MapLibre parses vector tiles off the main thread in a web worker, loaded at runtime via a
// URL it constructs itself rather than a static import Rollup/Vite's production bundler can
// see — left alone, that request 404s through to the SPA fallback (index.html), the browser
// refuses to run HTML as a JS module, and the map silently never renders any tile data (just
// the flat style background) even though every network/data layer underneath it is fine. The
// `?url` suffix makes Vite copy the real worker file into the build output and hand back its
// actual fingerprinted path instead of trying to resolve it at runtime.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
setWorkerUrl(maplibreWorkerUrl);

// Self-hosted offline basemap: a PMTiles archive (Protomaps' daily OpenStreetMap build,
// zoom 0-8 — enough detail for a country/province-scale region map, ~550MB) served by our
// own API at /maps/world-z8.pmtiles, with @protomaps/basemaps generating the vector style
// layers entirely client-side (no network call for the style itself). No sprite/glyph URLs
// are configured yet, so POI icons and text labels won't render — base geometry (land,
// water, roads, admin boundaries) does. Shared between RegionMap.tsx (single-region detail
// view) and PacksMap.tsx (whole-world offline-packs picker) — extracted here so both import
// one bootstrap instead of duplicating the protocol/worker/style setup.
export const PMTILES_URL = "/maps/world-z8.pmtiles";
export const PMTILES_SOURCE_ID = "protomaps";

let protocolRegistered = false;
export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

// maxzoom must match the archive's actual baked-in max (8) — without it, fitting a small
// region's bounds zooms the map in past what the archive has, MapLibre requests tiles that
// don't exist, and land/water never renders (just the flat background color). Setting it
// tells MapLibre to keep reusing the z8 tiles, scaled up, for any deeper zoom instead.
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

// The basemap file is a large (~500MB) optional download, not guaranteed to be present — check
// first rather than letting maplibre fail loudly against a 404.
export async function checkPmtilesAvailable(): Promise<boolean> {
  try {
    const res = await fetch(PMTILES_URL, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}
