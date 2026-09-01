import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { ensurePmtilesProtocol, pmtilesStyle, checkPmtilesAvailable } from "../lib/pmtiles";

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
    checkPmtilesAvailable().then(setMapAvailable);
  }, []);

  useEffect(() => {
    if (!containerRef.current || !boundaryGeoJson || !mapAvailable) return;
    ensurePmtilesProtocol();

    const cachedCamera = regionKey ? lastCameraByRegion.get(regionKey) : undefined;

    const map = new MapLibreMap({
      container: containerRef.current,
      ...(cachedCamera ? { center: cachedCamera.center, zoom: cachedCamera.zoom } : {}),
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
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
