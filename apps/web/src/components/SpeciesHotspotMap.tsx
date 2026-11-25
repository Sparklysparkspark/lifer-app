import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Map as MapLibreMap, LngLatBounds, Popup } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addMapCredits } from "./map/MapCredits";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";
import { showRegionOutline } from "../lib/mapRegionLayers";
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
  all: "hotspotMap.years.all",
  last1: "hotspotMap.years.last1",
  last3: "hotspotMap.years.last3",
  last5: "hotspotMap.years.last5",
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
  regionName,
}: {
  regionName?: string | null;
  boundaryGeoJson: unknown;
  hotspots: SpeciesHotspot[];
  scientificName: string;
}) {
  const { t } = useTranslation();
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
    return [...reliable].sort(
      (a, b) => (b.distinctYears ?? 0) - (a.distinctYears ?? 0) || b.recordShare - a.recordShare,
    )[0];
  }, [hotspots]);

  // eBird Sensitive species are blurred to a coarse 20x20km area; say why it looks vague.
  const hasSensitiveHotspot = hotspots.some((h) => h.isSensitive);

  const currentYear = new Date().getFullYear();
  const mostRecentYear = useMemo(
    () =>
      hotspots.reduce<number | null>(
        (max, h) => (h.lastSeenYear != null && (max == null || h.lastSeenYear > max) ? h.lastSeenYear : max),
        null,
      ),
    [hotspots],
  );

  const filteredHotspots = useMemo(() => {
    const cutoff = cutoffYearFor(yearFilter, currentYear);
    const byYear =
      cutoff == null ? hotspots : hotspots.filter((h) => h.lastSeenYear != null && h.lastSeenYear >= cutoff);
    const query = search.trim().toLowerCase();
    if (!query) return byYear;
    // Clusters have no name, so coordinates are searchable.
    return byYear.filter((h) => `${h.centroidLat.toFixed(2)}, ${h.centroidLon.toFixed(2)}`.includes(query));
  }, [hotspots, yearFilter, search, currentYear]);

  useEffect(() => {
    if (!expanded || !containerRef.current || !boundaryGeoJson || filteredHotspots.length === 0 || !mapAvailable)
      return;
    ensurePmtilesProtocol();

    const map = new MapLibreMap({
      container: containerRef.current,
      style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
      interactive: true,
      // Our own credits line (addMapCredits), as in RegionMap.
      attributionControl: false,
    });
    addMapCredits(map);
    mapRef.current = map;

    map.on("load", () => {
      const feature = boundaryGeoJson as { type: "Feature"; geometry: { coordinates: unknown } };
      showRegionOutline(map, feature);

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
        const {
          idx,
          pointCount,
          recordShare,
          lastSeenYear,
          distinctYears,
          isReliable,
          isSensitive,
          centroidLat,
          centroidLon,
          bboxDiagonalKm,
        } = f.properties as {
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
        map.easeTo({
          center: f.geometry.coordinates as [number, number],
          zoom: Math.max(map.getZoom(), zoomForClusterExtent(bboxDiagonalKm)),
        });
        const recencyLine =
          lastSeenYear != null
            ? distinctYears != null && distinctYears > 1
              ? t("hotspotMap.lastSeenAcross", { year: String(lastSeenYear), years: distinctYears })
              : t("hotspotMap.lastSeen", { year: String(lastSeenYear) })
            : "";
        // The centroid averages a grid cell, so it's framed as an area (plus or minus a radius).
        const areaRadiusKm = Math.max(bboxDiagonalKm / 2, 0.5).toFixed(1);
        new Popup({ closeButton: false })
          .setLngLat(f.geometry.coordinates as [number, number])
          .setHTML(
            `<div style="font-size:12px;line-height:1.4">${
              isReliable ? `<div class="font-semibold text-ink">${t("hotspotMap.goodChance")}</div>` : ""
            }${
              isSensitive ? `<div class="font-semibold text-ink">${t("hotspotMap.sensitiveWithheld")}</div>` : ""
            }${t("hotspotMap.recordShare", { percent: Math.round(recordShare * 100), count: pointCount })}${recencyLine ? `<br/>${recencyLine}` : ""}<br/><span class="text-muted">~${centroidLat.toFixed(3)}, ${centroidLon.toFixed(3)} ${t("hotspotMap.areaRadius", { radius: areaRadiusKm })}</span></div>`,
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
  }, [expanded, boundaryGeoJson, filteredHotspots, mapAvailable, theme, t]);

  if (!boundaryGeoJson || hotspots.length === 0 || !mapAvailable) return null;

  function flyToHotspot(idx: number) {
    setSelectedIdx(idx);
    const h = filteredHotspots[idx];
    const map = mapRef.current;
    if (!map || !h) return;
    map.flyTo({
      center: [h.centroidLon, h.centroidLat],
      zoom: Math.max(map.getZoom(), zoomForClusterExtent(h.bboxDiagonalKm)),
    });
  }

  return (
    // Sits inside the species panel, so no frame of its own: a plain row that opens the map.
    <div>
      {/* raw-control: the whole row is the map's disclosure. */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-baseline justify-between gap-3 text-left text-callout text-ink"
      >
        <span className="font-medium">
          {regionName ? t("hotspotMap.titleIn", { region: regionName }) : t("hotspotMap.title")}{" "}
          <span className="font-normal text-muted">
            {/* With a year or search filter on, the count says how many of them show. */}
            {filteredHotspots.length !== hotspots.length
              ? t("hotspotMap.locationsOf", { shown: filteredHotspots.length, count: hotspots.length })
              : mostRecentYear != null
                ? t("hotspotMap.locationsLastSeen", { count: hotspots.length, year: String(mostRecentYear) })
                : t("hotspotMap.locations", { count: hotspots.length })}
          </span>
        </span>
        <span className="text-footnote text-muted hover:text-ink hover:underline">
          {expanded ? t("hotspotMap.hide") : t("hotspotMap.show")}
        </span>
      </button>
      {expanded && (
        <div className="mt-3">
          {hasSensitiveHotspot && (
            <p className="mb-2 text-footnote text-amber-800 dark:text-amber-300">{t("hotspotMap.sensitiveNote")}</p>
          )}
          {bestBet && (
            <p className="mb-2 text-callout text-ink">
              <span className="font-medium text-green-700">{t("hotspotMap.goodChance")}</span>
              <span className="text-muted"> {t("hotspotMap.seenAcross", { years: bestBet.distinctYears })}</span>
            </p>
          )}
          {inaturalistUrl && (
            <a
              href={inaturalistUrl}
              // eslint-disable-next-line no-restricted-syntax -- baseline, migrate to openExternal() or a shared link component
              target="_blank"
              rel="noreferrer"
              className="mb-2 inline-block text-footnote text-accent hover:underline"
            >
              {t("hotspotMap.moreOnInaturalist")}
            </a>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Select
              aria-label={t("hotspotMap.sightingYears")}
              value={yearFilter}
              onChange={(e) => setYearFilter(e.target.value as YearFilter)}
            >
              {(Object.keys(YEAR_FILTER_LABEL) as YearFilter[]).map((f) => (
                <option key={f} value={f}>
                  {t(YEAR_FILTER_LABEL[f])}
                </option>
              ))}
            </Select>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t("hotspotMap.searchPlaceholder")}
              className="min-w-0 flex-1"
            />
          </div>
          {filteredHotspots.length === 0 ? (
            <p className="text-footnote text-muted">{t("hotspotMap.noMatch")}</p>
          ) : (
            <>
              <div ref={containerRef} className="h-64 w-full rounded-panel border border-line" />
              <ul className="mt-2 max-h-40 space-y-0.5 overflow-y-auto text-footnote">
                {filteredHotspots.map((h, idx) => (
                  <li key={idx}>
                    {/* raw-control: a row of the hotspot list. */}
                    <button
                      type="button"
                      onClick={() => flyToHotspot(idx)}
                      className={`flex w-full items-center justify-between rounded-control px-2 py-1 text-left hover:bg-surface-muted ${
                        selectedIdx === idx ? "bg-surface-muted" : ""
                      }`}
                    >
                      <span className="text-ink">
                        ~{h.centroidLat.toFixed(3)}, {h.centroidLon.toFixed(3)}{" "}
                        <span className="text-muted">
                          {t("hotspotMap.radius", { radius: Math.max(h.bboxDiagonalKm / 2, 0.5).toFixed(1) })}
                        </span>
                        {h.isReliable && <span className="ml-1.5 text-green-700">●</span>}
                        {h.isSensitive && (
                          <span className="ml-1.5 text-amber-700" title={t("hotspotMap.sensitiveWithheld")}>
                            {t("hotspotMap.sensitiveBadge")}
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
