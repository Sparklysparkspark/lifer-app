import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { useLatest } from "../hooks/useLatest";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";

// Opening a species unmounts the collection, so the last camera per region is kept at module
// scope and a remount starts where the user left it.
const lastCameraByRegion = new Map<string, { center: [number, number]; zoom: number }>();

// Capped at the archive's max zoom.
const FIT = { padding: 24, maxZoom: 8 };
const SOURCE_ID = "region-boundary";

type Boundary = { type: "Feature"; geometry: { coordinates: unknown } };

function boundsOf(boundary: Boundary): LngLatBounds {
  const bounds = new LngLatBounds();
  const extend = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === "number") bounds.extend(coords as [number, number]);
    else if (Array.isArray(coords)) coords.forEach(extend);
  };
  extend(boundary.geometry.coordinates);
  return bounds;
}

export default function RegionMap({ boundaryGeoJson, regionKey }: { boundaryGeoJson: unknown; regionKey?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // The region the map's outline and camera show, so a region change glides from it.
  const shownKeyRef = useRef<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);
  const mapAvailable = useMapAvailable();
  // The basemap flavor follows the app theme; the light flavor is unreadable in dark mode.
  const { theme } = useTheme();
  const boundaryRef = useLatest(boundaryGeoJson as Boundary | null);
  const regionKeyRef = useLatest(regionKey);
  const hasBoundary = !!boundaryGeoJson;

  // One map for as long as the page shows one: drilling from a country to a province (or back)
  // moves its camera rather than building a new map.
  useEffect(() => {
    const boundary = boundaryRef.current;
    if (!containerRef.current || !boundary || !mapAvailable) return;
    ensurePmtilesProtocol();

    const key = regionKeyRef.current;
    const cachedCamera = key ? lastCameraByRegion.get(key) : undefined;
    const bounds = boundsOf(boundary);
    const map = new MapLibreMap({
      container: containerRef.current,
      ...(cachedCamera
        ? { center: cachedCamera.center, zoom: cachedCamera.zoom }
        : bounds.isEmpty()
          ? {}
          : { bounds, fitBoundsOptions: FIT }),
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
      // Compact so the attribution bar doesn't open expanded over the map.
      attributionControl: { compact: true },
    });
    mapRef.current = map;
    shownKeyRef.current = key;

    map.on("load", () => {
      map.addSource(SOURCE_ID, { type: "geojson", data: boundaryRef.current ?? boundary } as Parameters<
        typeof map.addSource
      >[1] as never);
      map.addLayer({
        id: "region-boundary-fill",
        type: "fill",
        source: SOURCE_ID,
        paint: { "fill-color": "#1c1917", "fill-opacity": 0.15 },
      });
      map.addLayer({
        id: "region-boundary-line",
        type: "line",
        source: SOURCE_ID,
        paint: { "line-color": "#1c1917", "line-width": 2 },
      });
      setLoaded(true);
    });

    map.on("moveend", () => {
      const shown = shownKeyRef.current;
      if (shown)
        lastCameraByRegion.set(shown, {
          center: map.getCenter().toArray() as [number, number],
          zoom: map.getZoom(),
        });
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
  }, [hasBoundary, mapAvailable, theme, boundaryRef, regionKeyRef]);

  // A new region: swap the outline and glide the camera to it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !boundaryGeoJson || shownKeyRef.current === regionKey) return;
    shownKeyRef.current = regionKey;
    (map.getSource(SOURCE_ID) as GeoJSONSource | undefined)?.setData(boundaryGeoJson as never);
    const bounds = boundsOf(boundaryGeoJson as Boundary);
    if (!bounds.isEmpty()) map.fitBounds(bounds, FIT);
  }, [boundaryGeoJson, regionKey, loaded]);

  // The basemap is an opt-in download; with none (or still checking) the map takes no space.
  if (!boundaryGeoJson || !mapAvailable) return null;

  return <div ref={containerRef} className="h-80 w-full rounded-panel border border-line" />;
}
