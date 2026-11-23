import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { REGION_OUTLINE_LAYER } from "./mapRegionLayers";
import { token } from "./mapStyle";
import { createStore } from "./resource";

export const AREA_SOURCE = "region-view-areas";
export const AREA_FILL = "region-view-area-fill";
const AREA_LINE = "region-view-area-line";
const AREA_HOVER_LINE = "region-view-area-hover-line";

/** The area pill or outline being pointed at, so each highlights the other. */
export const highlightedArea = createStore<string | null>(null);

type Boundary = { id: string; parentId: string | null; boundaryGeoJson: { geometry?: unknown } | null };

/** One feature per outline, tagged with the pill it belongs to (`area`, the id the pill opens).
 *  The boundaries come from `?parentId=regionId`: the region's children, plus the children of a
 *  child without an outline, which stand for that child. Outlines with no pill are left out. */
export function areaOutlineFeatures(
  boundaries: readonly Boundary[],
  regionId: string,
  areas: ReadonlyArray<{ id: string; name: string }>,
  target: (id: string) => string,
) {
  const names = new Map(areas.map((a) => [a.id, a.name]));
  const features = [];
  for (const b of boundaries) {
    const area = target(b.parentId === regionId ? b.id : (b.parentId ?? b.id));
    const name = names.get(area);
    if (name === undefined || !b.boundaryGeoJson?.geometry) continue;
    features.push({ type: "Feature" as const, properties: { area, name }, geometry: b.boundaryGeoJson.geometry });
  }
  return { type: "FeatureCollection" as const, features };
}

/** The empty area source and its layers, under the region's own edge (and so under the pins). */
export function addAreaOutlineLayers(map: MapLibreMap): void {
  const hovered = ["boolean", ["feature-state", "hover"], false] as never;
  const highlight = token("--color-link");
  const before = map.getLayer(REGION_OUTLINE_LAYER) ? REGION_OUTLINE_LAYER : undefined;
  map.addSource(AREA_SOURCE, {
    type: "geojson",
    data: areaOutlineFeatures([], "", [], String) as never,
    promoteId: "area",
  });
  // Invisible but for the hover tint: there so a pointer anywhere inside an area finds it.
  map.addLayer(
    {
      id: AREA_FILL,
      type: "fill",
      source: AREA_SOURCE,
      paint: { "fill-color": highlight, "fill-opacity": ["case", hovered, 0.15, 0] as never },
    },
    before,
  );
  // Dashed and muted, so the areas never read as the region's own solid edge or the basemap's borders.
  map.addLayer(
    {
      id: AREA_LINE,
      type: "line",
      source: AREA_SOURCE,
      paint: { "line-color": token("--color-muted"), "line-width": 1, "line-opacity": 0.8, "line-dasharray": [3, 2] },
    },
    before,
  );
  map.addLayer(
    {
      id: AREA_HOVER_LINE,
      type: "line",
      source: AREA_SOURCE,
      paint: { "line-color": highlight, "line-width": 2, "line-opacity": ["case", hovered, 1, 0] as never },
    },
    before,
  );
}

export function setAreaOutlines(map: MapLibreMap, data: ReturnType<typeof areaOutlineFeatures>): void {
  (map.getSource(AREA_SOURCE) as GeoJSONSource | undefined)?.setData(data as never);
}
