import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";
import { buildInaturalistObservationsUrl } from "../lib/inaturalist";
import SearchInput from "./SearchInput";
import Select from "./Select";

export interface SpeciesHotspot {
  centroidLat: number;
  centroidLon: number;
  pointCount: number;
  bboxDiagonalKm: number;
  lastSeenYear: number | null;
  distinctYears: number | null;
  recordShare: number;
  isReliable: boolean;
  isSensitive: boolean;
}

type YearFilter = "all" | "last1" | "last3" | "last5";
const YEAR_FILTER_LABEL: Record<YearFilter, string> = {
  all: "All years",
  last1: "Last year only",
  last3: "Last 3 years",
  last5: "Last 5 years",
};

// Raw points aren't kept per cluster, so a click zooms in proportion to the cluster's extent
// (bboxDiagonalKm).
function zoomForClusterExtent(bboxDiagonalKm: number): number {
  const km = Math.max(bboxDiagonalKm, 0.3);
  return Math.min(15, Math.max(8, 14 - Math.log2(km)));
}

function cutoffYearFor(filter: YearFilter, currentYear: number): number | null {
  if (filter === "all") return null;
  if (filter === "last1") return currentYear - 1;
  if (filter === "last3") return currentYear - 3;
  return currentYear - 5;
}

// Historical GBIF record clusters for one species in one region, sized and colored by share of
// records. Collapsed by default so a long list doesn't render a map per entry.
export default function SpeciesHotspotMap({
  boundaryGeoJson,
  hotspots,
  scientificName,
}: {
  boundaryGeoJson: unknown;
  hotspots: SpeciesHotspot[];
  scientificName: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [yearFilter, setYearFilter] = useState<YearFilter>("all");
  const [search, setSearch] = useState("");
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const mapAvailable = useMapAvailable();
  const { theme } = useTheme();

  // The bundled data is a snapshot from the last pack build; iNaturalist's map for this region's
  // bounding box shows anything more recent.
  const inaturalistUrl = useMemo(
    () => buildInaturalistObservationsUrl(boundaryGeoJson, scientificName),
    [boundaryGeoJson, scientificName],
  );

  // A cluster hit across 3+ separate years is a real recurring spot, called out first.
  const bestBet = useMemo(() => {
    const reliable = hotspots.filter((h) => h.isReliable);
    if (reliable.length === 0) return undefined;
    return [...reliable].sort((a, b) => (b.distinctYears ?? 0) - (a.distinctYears ?? 0) || b.recordShare - a.recordShare)[0];
  }, [hotspots]);

  // eBird Sensitive species are blurred to a coarse 20x20km area; say why it looks vague.
  const hasSensitiveHotspot = hotspots.some((h) => h.isSensitive);

  const currentYear = new Date().getFullYear();
  const mostRecentYear = useMemo(
    () => hotspots.reduce<number | null>((max, h) => (h.lastSeenYear != null && (max == null || h.lastSeenYear > max) ? h.lastSeenYear : max), null),
    [hotspots],
  );

  const filteredHotspots = useMemo(() => {
    const cutoff = cutoffYearFor(yearFilter, currentYear);
    const byYear = cutoff == null ? hotspots : hotspots.filter((h) => h.lastSeenYear != null && h.lastSeenYear >= cutoff);
    const query = search.trim().toLowerCase();
    if (!query) return byYear;
    // Clusters have no name, so coordinates are searchable.
    return byYear.filter((h) => `${h.centroidLat.toFixed(2)}, ${h.centroidLon.toFixed(2)}`.includes(query));
  }, [hotspots, yearFilter, search, currentYear]);

  useEffect(() => {
    if (!expanded || !containerRef.current || !boundaryGeoJson || filteredHotspots.length === 0 || !mapAvailable) return;
    ensurePmtilesProtocol();

    const map = new MapLibreMap({
      container: containerRef.current,
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
      // Compact attribution, as in RegionMap.
      attributionControl: { compact: true },
    });
    mapRef.current = map;

    map.on("load", () => {
      const feature = boundaryGeoJson as { type: "Feature"; geometry: { coordinates: unknown } };
      map.addSource("hotspot-region-boundary", { type: "geojson", data: feature } as Parameters<typeof map.addSource>[1] as never);
      map.addLayer({
        id: "hotspot-region-boundary-fill",
        type: "fill",
        source: "hotspot-region-boundary",
        paint: { "fill-color": "#1c1917", "fill-opacity": 0.08 },
      });
      map.addLayer({
        id: "hotspot-region-boundary-line",
        type: "line",
        source: "hotspot-region-boundary",
        paint: { "line-color": "#1c1917", "line-width": 2 },
      });

      const pointsGeoJson = {
        type: "FeatureCollection" as const,
        features: filteredHotspots.map((h, idx) => ({
          type: "Feature" as const,
          properties: {
            idx,
            pointCount: h.pointCount,
            recordShare: h.recordShare,
            lastSeenYear: h.lastSeenYear,
            distinctYears: h.distinctYears,
            isReliable: h.isReliable,
            isSensitive: h.isSensitive,
            centroidLat: h.centroidLat,
            centroidLon: h.centroidLon,
            bboxDiagonalKm: h.bboxDiagonalKm,
          },
          geometry: { type: "Point" as const, coordinates: [h.centroidLon, h.centroidLat] },
        })),
      };
      map.addSource("hotspot-points", { type: "geojson", data: pointsGeoJson });
      map.addLayer({
        id: "hotspot-points-circle",
        type: "circle",
        source: "hotspot-points",
        paint: {
          // A bigger share of the region's records gives a bigger, more saturated dot.
          "circle-radius": ["interpolate", ["linear"], ["get", "recordShare"], 0, 6, 1, 22],
          "circle-color": "#b45309",
          "circle-opacity": ["interpolate", ["linear"], ["get", "recordShare"], 0, 0.35, 1, 0.8],
          // A cluster seen in 3+ separate years gets a green ring instead of brown.
          "circle-stroke-width": ["case", ["get", "isReliable"], 3, 1.5],
          "circle-stroke-color": ["case", ["get", "isReliable"], "#15803d", "#78350f"],
        },
      });

      map.on("mouseenter", "hotspot-points-circle", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "hotspot-points-circle", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", "hotspot-points-circle", (e) => {
        const f = e.features?.[0];
        if (!f || f.geometry.type !== "Point") return;
        const { idx, pointCount, recordShare, lastSeenYear, distinctYears, isReliable, isSensitive, centroidLat, centroidLon, bboxDiagonalKm } =
          f.properties as {
            idx: number;
            pointCount: number;
            recordShare: number;
            lastSeenYear: number | null;
            distinctYears: number | null;
            isReliable: boolean;
            isSensitive: boolean;
            centroidLat: number;
            centroidLon: number;
            bboxDiagonalKm: number;
          };
        setSelectedIdx(idx);
        // No individual sightings to show, so zoom to the cluster's own extent.
        map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), zoomForClusterExtent(bboxDiagonalKm)) });
        const recencyLine =
          lastSeenYear != null
            ? `Last seen ${lastSeenYear}${distinctYears != null && distinctYears > 1 ? ` (seen across ${distinctYears} different years)` : ""}`
            : "";
        // The centroid averages a grid cell, so it's framed as an area (plus or minus a radius).
        const areaRadiusKm = Math.max(bboxDiagonalKm / 2, 0.5).toFixed(1);
        new Popup({ closeButton: false })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(
            `<div style="font-size:12px;line-height:1.4">${
              isReliable ? '<div style="font-weight:600;color:#15803d">Good chance of finding it here</div>' : ""
            }${
              isSensitive
                ? '<div style="font-weight:600;color:#b45309">eBird Sensitive Species, exact location withheld</div>'
                : ""
            }${Math.round(recordShare * 100)}% of records (${pointCount})${recencyLine ? `<br/>${recencyLine}` : ""}<br/><span style="color:#78716c">~${centroidLat.toFixed(3)}, ${centroidLon.toFixed(3)} (±${areaRadiusKm}km area, not an exact spot)</span></div>`,
          )
          .addTo(map);
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
      map.fitBounds(bounds, { padding: 24, maxZoom: 8 });
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [expanded, boundaryGeoJson, filteredHotspots, mapAvailable, theme]);

  if (!boundaryGeoJson || hotspots.length === 0 || !mapAvailable) return null;

  function flyToHotspot(idx: number) {
    setSelectedIdx(idx);
    const h = filteredHotspots[idx];
    const map = mapRef.current;
    if (!map || !h) return;
    map.flyTo({ center: [h.centroidLon, h.centroidLat], zoom: Math.max(map.getZoom(), zoomForClusterExtent(h.bboxDiagonalKm)) });
  }

  return (
    <div className="rounded-lg border border-line bg-surface">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between rounded-lg px-3 py-2.5 text-left text-sm text-ink hover:bg-surface-muted"
      >
        <span className="font-medium">
          Locality map{" "}
          <span className="font-normal text-muted">
            ({hotspots.length} location{hotspots.length === 1 ? "" : "s"}
            {mostRecentYear != null ? `, last seen ${mostRecentYear}` : ""})
          </span>
        </span>
        <span className="rounded-md border border-line px-2 py-0.5 text-xs text-muted">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded && (
        <div className="border-t border-line p-3">
          {hasSensitiveHotspot && (
            <p className="mb-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1.5 text-xs text-amber-900">
              This is an eBird Sensitive Species (or sensitive in this region/season). Its exact
              location can't be shown, the marked area is deliberately widened to protect it from
              targeted disturbance, capture, or hunting, matching eBird's own sensitive-species list.
            </p>
          )}
          {bestBet && (
            <p className="mb-2 text-sm text-ink">
              <span className="font-medium text-green-700">Good chance of finding it here</span>
              <span className="text-muted"> (seen across {bestBet.distinctYears} different years)</span>
            </p>
          )}
          {inaturalistUrl && (
            <a
              href={inaturalistUrl}
              target="_blank"
              rel="noreferrer"
              className="mb-2 inline-block text-xs text-accent hover:underline"
            >
              See more recent sightings on iNaturalist ↗
            </a>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Select value={yearFilter} onChange={(e) => setYearFilter(e.target.value as YearFilter)}>
              {(Object.keys(YEAR_FILTER_LABEL) as YearFilter[]).map((f) => (
                <option key={f} value={f}>
                  {YEAR_FILTER_LABEL[f]}
                </option>
              ))}
            </Select>
            <SearchInput value={search} onChange={setSearch} placeholder="Search coordinates…" className="min-w-0 flex-1" />
          </div>
          {filteredHotspots.length === 0 ? (
            <p className="text-xs text-muted">No locations match this filter.</p>
          ) : (
            <>
              <div ref={containerRef} className="h-64 w-full rounded-lg border border-line" />
              <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-xs">
                {filteredHotspots.map((h, idx) => (
                  <li key={idx}>
                    <button
                      type="button"
                      onClick={() => flyToHotspot(idx)}
                      className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-surface-muted ${
                        selectedIdx === idx ? "bg-surface-muted" : ""
                      }`}
                    >
                      <span className="text-ink">
                        ~{h.centroidLat.toFixed(3)}, {h.centroidLon.toFixed(3)}{" "}
                        <span className="text-muted">(±{Math.max(h.bboxDiagonalKm / 2, 0.5).toFixed(1)}km)</span>
                        {h.isReliable && <span className="ml-1.5 text-green-700">●</span>}
                        {h.isSensitive && (
                          <span className="ml-1.5 text-amber-700" title="eBird Sensitive Species, exact location withheld">
                            ⚠ sensitive
                          </span>
                        )}
                      </span>
                      <span className="text-muted">
                        {Math.round(h.recordShare * 100)}%{h.lastSeenYear != null ? ` · ${h.lastSeenYear}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
