import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds, addProtocol, setWorkerUrl } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
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
// water, roads, admin boundaries) does.
const PMTILES_URL = "/maps/world-z8.pmtiles";
const PMTILES_SOURCE_ID = "protomaps";

let protocolRegistered = false;
function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  protocolRegistered = true;
}

// Species detail is a sibling route (see App.tsx/CollectionPage.tsx's own comment on the same
// issue for its item list), so leaving a region page and coming back destroys this whole
// component and recreates a brand new MapLibre instance from scratch — replaying the
// zoom/pan-into-place animation every single time, even though the user was just looking at
// this exact view seconds ago. Persisting the last camera position per region (module-scoped,
// survives remounts) and initializing the new map instance there directly — skipping
// fitBounds' animation entirely when a cached shot already exists — fixes that without needing
// to keep the map instance itself alive across an unmount it has no way to avoid.
const lastCameraByRegion = new Map<string, { center: [number, number]; zoom: number }>();

export default function RegionMap({ boundaryGeoJson, regionKey }: { boundaryGeoJson: unknown; regionKey?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [mapAvailable, setMapAvailable] = useState<boolean | null>(null);
  // The basemap style was hardcoded to Protomaps' "light" flavor regardless of app theme — in
  // dark mode its land/water/road colors are all pale tones tuned to sit against a light page,
  // rendering pale-on-pale (barely visible) with only our own boundary overlay (a fixed dark
  // fill, unrelated to this flavor) standing out. Matching the flavor to the app's own theme
  // is the fix, not a rendering bug to chase further.
  const { theme } = useTheme();

  // The basemap file is a large (~500MB) optional download, not guaranteed to be present —
  // check first rather than letting maplibre fail loudly against a 404.
  useEffect(() => {
    fetch(PMTILES_URL, { method: "HEAD" })
      .then((res) => setMapAvailable(res.ok))
      .catch(() => setMapAvailable(false));
  }, []);

  useEffect(() => {
    if (!containerRef.current || !boundaryGeoJson || !mapAvailable) return;
    ensurePmtilesProtocol();

    const cachedCamera = regionKey ? lastCameraByRegion.get(regionKey) : undefined;

    const absolutePmtilesUrl = new URL(PMTILES_URL, window.location.origin).toString();
    const map = new MapLibreMap({
      container: containerRef.current,
      ...(cachedCamera ? { center: cachedCamera.center, zoom: cachedCamera.zoom } : {}),
      style: {
        version: 8,
        sources: {
          // maxzoom must match the archive's actual baked-in max (8) — without it, fitting a
          // small region's bounds zooms the map in past what the archive has, MapLibre
          // requests tiles that don't exist, and land/water never renders (just the flat
          // background color). Setting it tells MapLibre to keep reusing the z8 tiles,
          // scaled up, for any deeper zoom instead.
          [PMTILES_SOURCE_ID]: { type: "vector", url: `pmtiles://${absolutePmtilesUrl}`, maxzoom: 8 },
        },
        layers: layers(PMTILES_SOURCE_ID, namedFlavor(theme === "dark" ? "dark" : "light"), { lang: "en" }),
      },
      interactive: true,
    });

    map.on("load", () => {
      const feature = boundaryGeoJson as { type: "Feature"; geometry: { coordinates: unknown } };
      map.addSource("region-boundary", { type: "geojson", data: feature } as Parameters<typeof map.addSource>[1] as never);
      map.addLayer({
        id: "region-boundary-fill",
        type: "fill",
        source: "region-boundary",
        paint: { "fill-color": "#1c1917", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "region-boundary-line",
        type: "line",
        source: "region-boundary",
        paint: { "line-color": "#1c1917", "line-width": 2 },
      });

      // Fit the map to the boundary's bounding box.
      const bounds = new LngLatBounds();
      const extend = (coords: unknown): void => {
        if (Array.isArray(coords) && typeof coords[0] === "number") {
          bounds.extend(coords as [number, number]);
        } else if (Array.isArray(coords)) {
          coords.forEach(extend);
        }
      };
      extend(feature.geometry.coordinates);
      // Only fly-to-fit on a region's FIRST-ever view this session — once cached, the
      // constructor's own center/zoom above already put the camera in the right place with no
      // animation, and re-fitting here on every mount is exactly the "starts zoomed out and
      // re-animates in" behavior this cache exists to avoid.
      if (!cachedCamera) {
        // Capped at the archive's own max zoom (8) — a small region would otherwise fit tight
        // enough to zoom in well past that, just enlarging the same z8 tile pixels rather than
        // showing any real extra detail.
        map.fitBounds(bounds, { padding: 24, maxZoom: 8 });
      }
    });

    if (regionKey) {
      map.on("moveend", () => {
        lastCameraByRegion.set(regionKey, { center: map.getCenter().toArray() as [number, number], zoom: map.getZoom() });
      });
    }

    return () => map.remove();
  }, [boundaryGeoJson, mapAvailable, regionKey, theme]);

  // The map is an opt-in download (see SettingsPage.tsx's MapSection) that most installs
  // won't have — rather than a placeholder box explaining that on every region page, this
  // whole component just isn't part of the layout when there's nothing to show. `null` (still
  // checking) is treated the same as `false` here so nothing flashes a box then removes it.
  if (!boundaryGeoJson || !mapAvailable) return null;

  return <div ref={containerRef} className="h-64 w-full rounded-lg border border-line" />;
}
