import { useEffect, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds, type GeoJSONSource } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { ensurePmtilesProtocol, pmtilesStyle, checkPmtilesAvailable } from "../lib/pmtiles";

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

// Russia's own polygon stretches to the Pacific — fine for the map's rendered outline, but
// fitting a continent's bounds around its FULL extent (e.g. picking "Europe") drags the fit out
// to cover Siberia too, leaving Europe itself a small sliver in the middle of a mostly-empty
// view. Clamping to just past the Urals for bounds purposes only keeps the fit centered on
// Europe, with just the western edge of Russia included, matching what "Europe" visually means
// here even though the country itself continues well past this line.
const RUSSIA_EUROPE_MAX_LNG = 60;

// Renders every country as one clickable layer (unlike RegionMap.tsx, which only ever shows a
// single region's own boundary) — clicking toggles that country in/out of `selectedIds`, whose
// current membership drives the fill color via setPaintProperty rather than by re-adding the
// source/layers on every selection change (cheap enough to update every render; rebuilding the
// whole GeoJSON source on each click would re-parse ~250 countries' polygons for one toggle).
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
  // Clicking open water/unclaimed area — nothing else on the map to select — clears the whole
  // selection instead of doing nothing, the same "click empty space to deselect" convention as
  // most map/canvas UIs.
  onDeselectAll?: () => void;
  // Passing a NEW array reference (even with the same ids) re-triggers the fit — callers should
  // only construct a fresh array when they actually want a fly-to (a continent pill click or a
  // search result pick), not on every render.
  focusCountryIds?: string[];
  // Every country belonging to a currently-open (but not necessarily selected) continent pill
  // group — outlined on the map as a weaker, distinct visual from `selected`, so "here's all of
  // Europe" reads as an outline, not as every European country having been picked.
  openCountryIds?: Set<string>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapAvailable, setMapAvailable] = useState<boolean | null>(null);
  const [loaded, setLoaded] = useState(false);
  const { theme } = useTheme();
  const onToggleCountryRef = useRef(onToggleCountry);
  onToggleCountryRef.current = onToggleCountry;
  const onDeselectAllRef = useRef(onDeselectAll);
  onDeselectAllRef.current = onDeselectAll;

  useEffect(() => {
    checkPmtilesAvailable().then(setMapAvailable);
  }, []);

  // Map instance created once (not re-created per theme/country-list change) — country data and
  // selection state are pushed into the existing instance via setData/setPaintProperty instead,
  // the same reasoning RegionMap.tsx's own single-instance-per-mount comment gives for avoiding
  // a full re-create/re-animate on every prop change.
  useEffect(() => {
    if (!containerRef.current || !mapAvailable) return;
    ensurePmtilesProtocol();

    const map = new MapLibreMap({
      container: containerRef.current,
      center: [10, 30],
      zoom: 1.2,
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
    });
    mapRef.current = map;

    map.on("load", () => {
      // promoteId is required for setFeatureState to actually apply: a GeoJSON source's
      // internal tiling step silently discards arbitrary string Feature.id values and
      // substitutes its own auto-generated numeric ids unless told to promote a property
      // instead (confirmed live — without this, setFeatureState below matched zero real
      // features, so a click updated selection state but the highlight never rendered).
      map.addSource(SOURCE_ID, {
        type: "geojson",
        data: { type: "FeatureCollection", features: [] },
        promoteId: "id",
      });
      // continentOpen is a weaker, distinct visual from selected — an outline (stronger line,
      // barely-there fill) so "here's all of Europe" reads as "available to pick from," never
      // as "every European country got selected." Only applies when NOT already selected.
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
      // A plain (layer-unfiltered) click handler fires for EVERY map click, including the
      // country-fill one above — queryRenderedFeatures at the click point is what actually
      // distinguishes "hit a country" from "hit open ocean/an unclaimed area": only clear
      // selection in the latter case, so this never fights with the per-country toggle.
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
  }, [mapAvailable, theme]);

  // Country geometry — set once per map instance load, or whenever the country list itself
  // changes (it only ever grows once, from the initial fetch, but this stays reactive rather
  // than assuming that).
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

  // Selection state — feature-state is the cheap, per-feature way to restyle without touching
  // the source data or re-adding layers; every country's state is reset then re-applied each
  // time selectedIds changes (a full pass over ~250 features is negligible compared to a
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- focusCountryIds is intentionally
    // only a fly-to trigger, not a full-dependency comparison (see prop's own doc comment).
  }, [focusCountryIds, loaded]);

  if (mapAvailable === false) {
    return (
      <div className="flex h-80 w-full items-center justify-center rounded-lg border border-line bg-surface-muted text-sm text-muted">
        The offline world map isn't downloaded yet. See Settings to enable it, or use the search box below instead.
      </div>
    );
  }

  return <div ref={containerRef} className="h-80 w-full rounded-lg border border-line" />;
}
