import { useEffect, useRef } from "react";
import { Map as MapLibreMap, LngLatBounds, addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";
import { layers, namedFlavor } from "@protomaps/basemaps";
import "maplibre-gl/dist/maplibre-gl.css";

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

export default function RegionMap({ boundaryGeoJson }: { boundaryGeoJson: unknown }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!containerRef.current || !boundaryGeoJson) return;
    ensurePmtilesProtocol();

    const absolutePmtilesUrl = new URL(PMTILES_URL, window.location.origin).toString();
    const map = new MapLibreMap({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          [PMTILES_SOURCE_ID]: { type: "vector", url: `pmtiles://${absolutePmtilesUrl}` },
        },
        layers: layers(PMTILES_SOURCE_ID, namedFlavor("light"), { lang: "en" }),
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
      map.fitBounds(bounds, { padding: 24 });
    });

    return () => map.remove();
  }, [boundaryGeoJson]);

  if (!boundaryGeoJson) return null;

  return <div ref={containerRef} className="h-64 w-full rounded-lg border border-stone-200" />;
}
