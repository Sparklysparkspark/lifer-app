import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Map as MapLibreMap, Marker } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addMapCredits } from "./map/MapCredits";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { useLatest } from "../hooks/useLatest";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";

const WORLD_VIEW = { center: [10, 25] as [number, number], zoom: 1 };
/** About a town across: close enough to place a pin on a pond. */
const POINT_ZOOM = 11;

/** A map to click or drag a pin on, for placing photos. It needs the basemap pack to show anything
 *  but a plain background, so the typed coordinates stay the way in without it. */
export default function PointPickerMap({
  point,
  onPick,
}: {
  point: { lat: number; lon: number } | null;
  onPick: (lat: number, lon: number) => void;
}) {
  const { t } = useTranslation();
  const { theme } = useTheme();
  const mapAvailable = useMapAvailable();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markerRef = useRef<Marker | null>(null);
  const onPickRef = useLatest(onPick);
  const pointRef = useLatest(point);

  useEffect(() => {
    if (!containerRef.current || mapAvailable === null) return;
    if (mapAvailable) ensurePmtilesProtocol();
    const start = pointRef.current;
    const map = new MapLibreMap({
      container: containerRef.current,
      ...(start ? { center: [start.lon, start.lat] as [number, number], zoom: POINT_ZOOM } : WORLD_VIEW),
      style: mapAvailable ? pmtilesStyle(theme === "dark" ? "dark" : "light") : { version: 8, sources: {}, layers: [] },
      attributionControl: false,
    });
    addMapCredits(map, { satellite: true, placeSearch: true });
    map.on("click", (e) => {
      const at = e.lngLat.wrap();
      onPickRef.current(at.lat, at.lng);
    });
    mapRef.current = map;
    return () => {
      markerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, [mapAvailable, theme, onPickRef, pointRef]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!point) {
      markerRef.current?.remove();
      markerRef.current = null;
      return;
    }
    if (!markerRef.current) {
      const marker = new Marker({ draggable: true }).setLngLat([point.lon, point.lat]).addTo(map);
      marker.on("dragend", () => {
        const at = marker.getLngLat().wrap();
        onPickRef.current(at.lat, at.lng);
      });
      markerRef.current = marker;
    } else markerRef.current.setLngLat([point.lon, point.lat]);
    // A point set from outside (a picked town, typed coordinates) the view can't see: go there.
    // A click or drag on the map is always in view, so it never moves the map.
    if (!map.getBounds().contains([point.lon, point.lat]))
      map.easeTo({ center: [point.lon, point.lat], zoom: Math.max(map.getZoom(), POINT_ZOOM) });
  }, [point, mapAvailable, theme, onPickRef]);

  return (
    <div
      ref={containerRef}
      role="region"
      aria-label={t("coordinates.mapLabel")}
      data-testid="point-picker-map"
      className="h-60 w-full overflow-hidden rounded-panel border border-line bg-surface-muted"
    />
  );
}
