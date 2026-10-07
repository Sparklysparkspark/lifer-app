import { useEffect, useRef } from "react";
import { Map as MapLibreMap, LngLatBounds } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";

// Opening a species unmounts the collection, so the last camera per region is kept at module
// scope and a remount starts there instead of replaying the fit-to-bounds animation.
const lastCameraByRegion = new Map<string, { center: [number, number]; zoom: number }>();

export default function RegionMap({ boundaryGeoJson, regionKey }: { boundaryGeoJson: unknown; regionKey?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapAvailable = useMapAvailable();
  // The basemap flavor follows the app theme; the light flavor is unreadable in dark mode.
  const { theme } = useTheme();

  useEffect(() => {
    if (!containerRef.current || !boundaryGeoJson || !mapAvailable) return;
    ensurePmtilesProtocol();

    const cachedCamera = regionKey ? lastCameraByRegion.get(regionKey) : undefined;

    const map = new MapLibreMap({
      container: containerRef.current,
      ...(cachedCamera ? { center: cachedCamera.center, zoom: cachedCamera.zoom } : {}),
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
      // Compact so the attribution bar doesn't open expanded over the map.
      attributionControl: { compact: true },
    });

    map.on("load", () => {
      const feature = boundaryGeoJson as { type: "Feature"; geometry: { coordinates: unknown } };
      map.addSource("region-boundary", { type: "geojson", data: feature } as Parameters<
        typeof map.addSource
      >[1] as never);
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

      const bounds = new LngLatBounds();
      const extend = (coords: unknown): void => {
        if (Array.isArray(coords) && typeof coords[0] === "number") {
          bounds.extend(coords as [number, number]);
        } else if (Array.isArray(coords)) {
          coords.forEach(extend);
        }
      };
      extend(feature.geometry.coordinates);
      // Only fit on a region's first view this session; capped at the archive's max zoom.
      if (!cachedCamera) {
        map.fitBounds(bounds, { padding: 24, maxZoom: 8 });
      }
    });

    if (regionKey) {
      map.on("moveend", () => {
        lastCameraByRegion.set(regionKey, {
          center: map.getCenter().toArray() as [number, number],
          zoom: map.getZoom(),
        });
      });
    }

    return () => map.remove();
  }, [boundaryGeoJson, mapAvailable, regionKey, theme]);

  // The basemap is an opt-in download; with none (or still checking) the map takes no space.
  if (!boundaryGeoJson || !mapAvailable) return null;

  return <div ref={containerRef} className="h-80 w-full rounded-lg border border-line" />;
}
