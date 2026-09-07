import { useEffect, useMemo, useRef, useState } from "react";
import { Map as MapLibreMap, LngLatBounds, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useTheme } from "../hooks/useTheme";
import { ensurePmtilesProtocol, pmtilesStyle, checkPmtilesAvailable } from "../lib/pmtiles";

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

// Individual raw points within a cluster were never kept past this cluster's own centroid/
// spread (compute-provinces-bulk.ts drops them deliberately — holding every point for a
// country with Australia's occurrence volume is what OOM-crashed it at an 8GB heap; see that
// file's own comment). So a click can't reveal individual sightings inside a cluster, but it
// CAN zoom proportionally to that cluster's own real extent (bboxDiagonalKm) instead of a flat
// zoom level — a tight, few-km cluster zooms in close; a loose, province-spanning one doesn't
// zoom in past what actually makes sense for it.
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

// Historical GBIF record clusters for one species within one region — "where has this
// actually been found," not a live sightings feed. Reuses the same PMTiles basemap and
// theme/availability plumbing as RegionMap.tsx; the only real difference is a second source/
// layer for the hotspot points themselves, sized and colored by each cluster's share of the
// species' total records in this region so the dominant location reads at a glance.
//
// Collapsed by default (see `expanded` below) — a photographer scanning a long species list
// doesn't need a live map render for every single entry, just the option to open one.
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
  const [mapAvailable, setMapAvailable] = useState<boolean | null>(null);
  const { theme } = useTheme();

  useEffect(() => {
    checkPmtilesAvailable().then(setMapAvailable);
  }, []);

  // The bundled hotspot data is a snapshot from whenever this pack was last built — real,
  // but not live. iNaturalist's own map view, scoped to this exact region's bounding box plus
  // this species, is the fastest way to check what's actually been seen more recently than that.
  const inaturalistUrl = useMemo(() => {
    const bbox = (boundaryGeoJson as { bbox?: [number, number, number, number] } | null)?.bbox;
    if (!bbox) return null;
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const params = new URLSearchParams({
      taxon_name: scientificName,
      swlat: String(minLat),
      swlng: String(minLon),
      nelat: String(maxLat),
      nelng: String(maxLon),
      subview: "map",
    });
    return `https://www.inaturalist.org/observations?${params.toString()}`;
  }, [boundaryGeoJson, scientificName]);

  // Highlight the single strongest repeat location, if there is one — a cluster hit across 3+
  // separate years is a real recurring pattern (not a one-off/vagrant record), worth calling
  // out ahead of the full list rather than making the reader scan for it themselves.
  const bestBet = useMemo(() => {
    const reliable = hotspots.filter((h) => h.isReliable);
    if (reliable.length === 0) return undefined;
    return [...reliable].sort((a, b) => (b.distinctYears ?? 0) - (a.distinctYears ?? 0) || b.recordShare - a.recordShare)[0];
  }, [hotspots]);

  // eBird designates certain species (or one region/season of an otherwise-common species — see
  // sensitive-species.ts's own comment) as Sensitive to protect them from targeted capture,
  // hunting, or disturbance. A cluster this app deliberately blurred for that reason still shows
  // up on the map (a coarse 20x20km area, not hidden entirely), but the reader needs to know
  // *why* it looks unusually vague compared to every other cluster, not just see a suspiciously
  // round area with no explanation.
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
    // Coordinates are the only real "name" a cluster has — searching them lets someone jump
    // to a location they already know the rough coordinates of (e.g. from a field guide or a
    // previous visit) without scrolling the whole list.
    return byYear.filter((h) => `${h.centroidLat.toFixed(2)}, ${h.centroidLon.toFixed(2)}`.includes(query));
  }, [hotspots, yearFilter, search, currentYear]);

  useEffect(() => {
    if (!expanded || !containerRef.current || !boundaryGeoJson || filteredHotspots.length === 0 || !mapAvailable) return;
    ensurePmtilesProtocol();

    const map = new MapLibreMap({
      container: containerRef.current,
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
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
          // Bigger share of a species' total regional records -> a bigger, more saturated dot,
          // so the dominant location is visually obvious rather than every cluster looking
          // equally important regardless of how few records actually back it.
          "circle-radius": ["interpolate", ["linear"], ["get", "recordShare"], 0, 6, 1, 22],
          "circle-color": "#b45309",
          "circle-opacity": ["interpolate", ["linear"], ["get", "recordShare"], 0, 0.35, 1, 0.8],
          // A cluster hit across 3+ separate years (see the API's RELIABLE_MIN_DISTINCT_YEARS)
          // gets a bolder green ring instead of the default brown one, so the "good bet"
          // location is visually distinct on the map, not just called out in the text list.
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
        // Individual sightings within a cluster were never kept (see zoomForClusterExtent's own
        // comment) — this zooms proportionally to how tight or loose the cluster actually is
        // instead, the closest available substitute for "show me more detail here."
        map.easeTo({ center: f.geometry.coordinates as [number, number], zoom: Math.max(map.getZoom(), zoomForClusterExtent(bboxDiagonalKm)) });
        const recencyLine =
          lastSeenYear != null
            ? `Last seen ${lastSeenYear}${distinctYears != null && distinctYears > 1 ? ` (seen across ${distinctYears} different years)` : ""}`
            : "";
        // The centroid is an average over every point that fell in this grid cell, not a
        // literal "stand right here" pin — framed as an area (±radius), not bare coordinates,
        // so it doesn't read as more precise than the underlying data actually is.
        const areaRadiusKm = Math.max(bboxDiagonalKm / 2, 0.5).toFixed(1);
        new Popup({ closeButton: false })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(
            `<div style="font-size:12px;line-height:1.4">${
              isReliable ? '<div style="font-weight:600;color:#15803d">Good chance of finding it here</div>' : ""
            }${
              isSensitive
                ? '<div style="font-weight:600;color:#b45309">eBird Sensitive Species — exact location withheld</div>'
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
    <div className="rounded-lg border border-line">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-ink hover:bg-surface-muted"
      >
        <span className="font-medium">
          Locality map{" "}
          <span className="font-normal text-muted">
            ({hotspots.length} location{hotspots.length === 1 ? "" : "s"}
            {mostRecentYear != null ? `, last seen ${mostRecentYear}` : ""})
          </span>
        </span>
        <span className="text-muted">{expanded ? "▲ Hide" : "▼ Show"}</span>
      </button>
      {expanded && (
        <div className="border-t border-line p-3">
          {hasSensitiveHotspot && (
            <p className="mb-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              This is an eBird Sensitive Species (or sensitive in this region/season). Its exact
              location can't be shown — the marked area is deliberately widened to protect it from
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
            <select
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value as YearFilter)}
              className="rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink"
            >
              {(Object.keys(YEAR_FILTER_LABEL) as YearFilter[]).map((f) => (
                <option key={f} value={f}>
                  {YEAR_FILTER_LABEL[f]}
                </option>
              ))}
            </select>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search coordinates…"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink placeholder:text-muted"
            />
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
                          <span className="ml-1.5 text-amber-700" title="eBird Sensitive Species — exact location withheld">
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
