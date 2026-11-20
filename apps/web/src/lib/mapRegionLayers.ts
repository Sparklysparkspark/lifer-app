import type { GeoJSONSource, Map as MapLibreMap } from "maplibre-gl";
import { outsideMask } from "./mapCamera";
import { isBasemapSource, token } from "./mapStyle";

const MASK_SOURCE = "region-view-mask";
const OUTLINE_SOURCE = "region-view-outline";
/** The dimmed world outside the region: a click on it means "go up a level". */
export const REGION_MASK_LAYER = "region-view-mask";
const OUTLINE_LAYER = "region-view-outline";

/** Dims everything outside `outline` and draws its edge, over the basemap (labels included) and
 *  under the photo layers. Updates in place when already shown. */
export function showRegionOutline(map: MapLibreMap, region: unknown): void {
  const mask = outsideMask(region);
  // Only the shape goes to MapLibre: a hub's properties carry every country's outline again.
  const geometry = (region as { geometry?: unknown }).geometry;
  const outline = geometry ? { type: "Feature", properties: {}, geometry } : region;
  const existing = map.getSource(MASK_SOURCE) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(mask);
    (map.getSource(OUTLINE_SOURCE) as GeoJSONSource).setData(outline as never);
    return;
  }
  const overlays = map
    .getStyle()
    .layers.filter((l) => l.type !== "background" && !isBasemapSource((l as { source?: string }).source));
  const firstOverlay = overlays[0]?.id;
  // The edge goes over a map's own area outlines, under its marks.
  const firstMark = overlays.find((l) => l.type === "circle" || l.type === "symbol")?.id;
  map.addSource(MASK_SOURCE, { type: "geojson", data: mask });
  map.addSource(OUTLINE_SOURCE, { type: "geojson", data: outline as never });
  map.addLayer(
    {
      id: REGION_MASK_LAYER,
      type: "fill",
      source: MASK_SOURCE,
      // Away from the land colour: lighter in light mode, darker in dark. No antialiasing, or the
      // world ring's edge shows as a line at the antimeridian.
      paint: {
        "fill-color": token(document.documentElement.classList.contains("dark") ? "--color-canvas" : "--color-surface"),
        "fill-opacity": 0.55,
        "fill-antialias": false,
      },
    },
    firstOverlay,
  );
  // The link sage: the accent itself is under 3:1 on dark land.
  map.addLayer(
    {
      id: OUTLINE_LAYER,
      type: "line",
      source: OUTLINE_SOURCE,
      paint: { "line-color": token("--color-link"), "line-width": 1.5 },
    },
    firstMark,
  );
}

export function hideRegionOutline(map: MapLibreMap): void {
  for (const id of [OUTLINE_LAYER, REGION_MASK_LAYER]) if (map.getLayer(id)) map.removeLayer(id);
  for (const id of [OUTLINE_SOURCE, MASK_SOURCE]) if (map.getSource(id)) map.removeSource(id);
}
