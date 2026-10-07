import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";
import { useLatest } from "../hooks/useLatest";
import { useTranslation } from "react-i18next";

export interface CountryBoundary {
  id: string;
  name: string;
  parentId: string | null;
  boundaryGeoJson: { type: "Feature"; geometry: { type: string; coordinates: unknown } };
}

const SOURCE_ID = "packs-countries";
const FILL_LAYER_ID = "packs-countries-fill";
const LINE_LAYER_ID = "packs-countries-line";

function extendBoundsFromCoordinates(bounds: LngLatBounds, coords: unknown, maxLng?: number): void {
  if (Array.isArray(coords) && typeof coords[0] === "number") {
    const [lng] = coords as [number, number];
    if (maxLng === undefined || lng <= maxLng) bounds.extend(coords as [number, number]);
  } else if (Array.isArray(coords)) {
    coords.forEach((c) => extendBoundsFromCoordinates(bounds, c, maxLng));
  }
}

// Russia's polygon reaches the Pacific, so fitting "Europe" would include Siberia. Bounds are
// clamped just past the Urals (for fitting only, not the drawn outline).
const RUSSIA_EUROPE_MAX_LNG = 60;

// Every country as one clickable layer; a click toggles it in `selectedIds`. Selection restyles
// via feature-state instead of rebuilding the ~250-country source per click.
export default function PacksMap({
  countries,
  selectedIds,
  onToggleCountry,
  focusCountryIds,
  openCountryIds,
  onDeselectAll,
}: {
  countries: CountryBoundary[];
  selectedIds: Set<string>;
  onToggleCountry: (id: string) => void;
  // Clicking empty water clears the selection.
  onDeselectAll?: () => void;
  // A new array reference triggers a fly-to, so only build one when a fit is wanted.
  focusCountryIds?: string[];
  // Countries of an open continent group, drawn as an outline so they don't read as selected.
  openCountryIds?: Set<string>;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapAvailable = useMapAvailable();
  const [loaded, setLoaded] = useState(false);
  const { theme } = useTheme();
  const onToggleCountryRef = useLatest(onToggleCountry);
  const onDeselectAllRef = useLatest(onDeselectAll);

  // One map instance per mount; data and selection are pushed into it, never re-created.
  useEffect(() => {
    if (!containerRef.current || !mapAvailable) return;
    ensurePmtilesProtocol();

    const map = new MapLibreMap({
      container: containerRef.current,
      center: [10, 30],
      zoom: 1.2,
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
      // Compact attribution, as in RegionMap.
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      // promoteId: without it the GeoJSON source replaces string ids with numeric ones and
      // setFeatureState matches nothing.
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      // continentOpen (when not selected): a stronger outline and faint fill.
      map.addLayer({
        id: FILL_LAYER_ID,
        type: "fill",
        source: SOURCE_ID,
        paint: {
          "fill-color": ["case", ["boolean", ["feature-state", "selected"], false], "#748069", "#1c1917"],
          "fill-opacity": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            0.65,
            ["boolean", ["feature-state", "continentOpen"], false],
            0.16,
            0.08,
          ],
        },
      });
      map.addLayer({
        id: LINE_LAYER_ID,
        type: "line",
        source: SOURCE_ID,
        paint: {
          "line-color": ["case", ["boolean", ["feature-state", "selected"], false], "#4b5540", "#1c1917"],
          "line-width": [
            "case",
            ["boolean", ["feature-state", "selected"], false],
            2.5,
            ["boolean", ["feature-state", "continentOpen"], false],
            2,
            1,
          ],
        },
      });
      map.on("click", FILL_LAYER_ID, (e) => {
        const id = e.features?.[0]?.properties?.id as string | undefined;
        if (id) onToggleCountryRef.current(id);
      });
      // Fires for every click; only a click that hit no country clears the selection.
      map.on("click", (e) => {
        const hits = map.queryRenderedFeatures(e.point, { layers: [FILL_LAYER_ID] });
        if (hits.length === 0) onDeselectAllRef.current?.();
      });
      map.on("mouseenter", FILL_LAYER_ID, () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", FILL_LAYER_ID, () => (map.getCanvas().style.cursor = ""));
      setLoaded(true);
    });

    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
    };
  }, [mapAvailable, theme, onToggleCountryRef, onDeselectAllRef]);

  // Country geometry, set on load and whenever the list changes.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    const source = map.getSource(SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData({
      type: "FeatureCollection",
      features: countries.map((c) => ({
        type: "Feature",
        id: c.id,
        properties: { id: c.id, name: c.name },
        geometry: c.boundaryGeoJson.geometry,
      })),
    } as GeoJSON.FeatureCollection);
  }, [countries, loaded]);

  // Every country's feature-state reset and re-applied per selection change (cheap next to a
  // geometry re-parse).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const c of countries) {
      map.setFeatureState({ source: SOURCE_ID, id: c.id }, { selected: selectedIds.has(c.id) });
    }
  }, [selectedIds, countries, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    for (const c of countries) {
      map.setFeatureState({ source: SOURCE_ID, id: c.id }, { continentOpen: openCountryIds?.has(c.id) ?? false });
    }
  }, [openCountryIds, countries, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !focusCountryIds || focusCountryIds.length === 0) return;
    const bounds = new LngLatBounds();
    for (const id of focusCountryIds) {
      const country = countries.find((c) => c.id === id);
      if (!country) continue;
      const maxLng = /^Russia/.test(country.name) ? RUSSIA_EUROPE_MAX_LNG : undefined;
      extendBoundsFromCoordinates(bounds, country.boundaryGeoJson.geometry.coordinates, maxLng);
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 32, maxZoom: 5 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusCountryIds is only a fly-to trigger
  }, [focusCountryIds, loaded]);

  if (mapAvailable === false) {
    return (
      <div className="flex h-80 w-full items-center justify-center rounded-lg border border-line bg-surface-muted text-sm text-muted">
        {t("offlinePacks.map.notDownloaded")}
      </div>
    );
  }

  return <div ref={containerRef} className="h-80 w-full rounded-lg border border-line" />;
}
