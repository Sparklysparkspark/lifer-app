// The Collection map's species pins: one dot per species per place, in the species' taxa colour,
// clustering as you zoom out. The paint and the numerals use the photo map's tokens, so the pairs
// contrast.test.ts checks hold here too.
import type { Map as MapLibreMap } from "maplibre-gl";
import { markMove } from "./mapCamera";
import { zoomOnto } from "./zoomOnto";
import { MAP_FONT, token } from "./mapStyle";
import { TAXA_GROUPS, taxaGroup } from "./taxaColour";
import { MAP_MAX_ZOOM } from "./mapPhotos";

export const PIN_SOURCE = "species-pins";
export const PIN_CLUSTERS = "species-pin-clusters";
export const PIN_COUNTS = "species-pin-counts";
export const PIN_POINTS = "species-pin-points";
export const PIN_HIGHLIGHT = "species-pin-highlight";
const LAYERS = [PIN_HIGHLIGHT, PIN_CLUSTERS, PIN_COUNTS, PIN_POINTS];
/** The layers a pointer can pick, top first. */
export const PICKABLE = [PIN_POINTS, PIN_CLUSTERS];

export interface SpeciesPin {
  speciesId: string;
  commonName: string | null;
  scientificName: string;
  taxonClass: string | null;
  iconicTaxon: string | null;
  lat: number;
  lon: number;
  count: number;
  photoId: string;
}

/** A pin's drawn radius in pixels. */
export const PIN_RADIUS = 6;
/** A cluster's drawn radius for `pins` pins, matching the paint below. */
export const pinClusterRadius = (pins: number) => {
  const s = Math.sqrt(pins);
  return s <= 1 ? 10 : s >= 30 ? 22 : 10 + ((s - 1) / 29) * 12;
};

/** `i` indexes the pins array, so a hover finds its pin without parsing properties. */
export function pinFeatures(pins: readonly SpeciesPin[]) {
  return {
    type: "FeatureCollection" as const,
    features: pins.map((p, i) => ({
      type: "Feature" as const,
      properties: { i, speciesId: p.speciesId, count: p.count, group: taxaGroup(p.taxonClass, p.iconicTaxon) },
      geometry: { type: "Point" as const, coordinates: [p.lon, p.lat] },
    })),
  };
}

/** The source's cluster sums: photos, and pins per taxa group for the colour. */
export const PIN_CLUSTER_SUMS = {
  photos: ["+", ["get", "count"]],
  ...Object.fromEntries(TAXA_GROUPS.map((g) => [g, ["+", ["case", ["==", ["get", "group"], g], 1, 0]]])),
};

// A cluster takes the colour of the group with the most pins in it.
function clusterColour(): never {
  const colours = Object.fromEntries(TAXA_GROUPS.map((g) => [g, token(`--color-taxa-${g}`)]));
  const [last, ...rest] = [...TAXA_GROUPS].reverse();
  const expr: unknown[] = ["case"];
  for (const g of rest.reverse())
    expr.push(["all", ...TAXA_GROUPS.filter((o) => o !== g).map((o) => [">=", ["get", g], ["get", o]])], colours[g]);
  expr.push(colours[last]);
  return expr as never;
}

const isCluster = ["has", "point_count"] as never;

/** Adds the empty pin source and its layers, above the region outline. */
export function addPinLayers(map: MapLibreMap, dark: boolean): void {
  const surface = token("--color-surface");
  map.addSource(PIN_SOURCE, {
    type: "geojson",
    data: pinFeatures([]),
    cluster: true,
    clusterRadius: 36,
    // To the deepest zoom, so two species at one point stay one cluster (its card lists both)
    // instead of stacking as pins where one hides the other.
    clusterMaxZoom: MAP_MAX_ZOOM,
    clusterProperties: PIN_CLUSTER_SUMS as never,
  });
  map.addLayer({
    id: PIN_HIGHLIGHT,
    type: "circle",
    source: PIN_SOURCE,
    filter: ["==", ["get", "speciesId"], ""],
    paint: {
      "circle-radius": PIN_RADIUS + 5,
      "circle-color": surface,
      "circle-opacity": 0,
      "circle-stroke-color": token("--color-link"),
      "circle-stroke-width": 2.5,
    },
  });
  map.addLayer({
    id: PIN_CLUSTERS,
    type: "circle",
    source: PIN_SOURCE,
    filter: isCluster,
    paint: {
      "circle-color": clusterColour(),
      "circle-opacity": 0.92,
      "circle-stroke-color": surface,
      "circle-stroke-width": 2,
      "circle-radius": ["interpolate", ["linear"], ["sqrt", ["get", "point_count"]], 1, 10, 30, 22] as never,
    },
  });
  // White on the dark light-mode discs; canvas on the light dark-mode ones (contrast.test.ts).
  map.addLayer({
    id: PIN_COUNTS,
    type: "symbol",
    source: PIN_SOURCE,
    filter: isCluster,
    layout: {
      "text-field": ["number-format", ["get", "point_count"], { locale: "en" }] as never,
      "text-font": MAP_FONT,
      "text-size": 11,
      "text-allow-overlap": true,
    },
    paint: { "text-color": token(dark ? "--color-canvas" : "--color-accent-fg") },
  });
  map.addLayer({
    id: PIN_POINTS,
    type: "circle",
    source: PIN_SOURCE,
    filter: ["!", isCluster],
    paint: {
      "circle-color": [
        "match",
        ["get", "group"],
        ...TAXA_GROUPS.flatMap((g) => [g, token(`--color-taxa-${g}`)]),
        token("--color-accent"),
      ] as never,
      "circle-stroke-color": surface,
      "circle-stroke-width": 2,
      "circle-radius": PIN_RADIUS,
    },
  });
}

/** Shows or hides every pin layer. */
export function showPins(map: MapLibreMap, visible: boolean): void {
  for (const id of LAYERS) if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
}

/** Rings the pins of one species (none for null). */
export function highlightSpecies(map: MapLibreMap, speciesId: string | null): void {
  if (map.getLayer(PIN_HIGHLIGHT)) map.setFilter(PIN_HIGHLIGHT, ["==", ["get", "speciesId"], speciesId ?? ""]);
}

/** Distinct species among a cluster's pins, the pins themselves (what its disc counts), and their photos. */
export function clusterSummary(leaves: ReadonlyArray<{ speciesId: string; count: number }>) {
  return { species: new Set(leaves.map((l) => l.speciesId)).size, pins: leaves.length, photos: leaves.reduce((n, l) => n + l.count, 0) };
}

// A click zooms in at most this far; a cluster still whole there (one point) is read from its card.
const CLUSTER_ZOOM_CAP = 14;

/** One eased move onto a clicked cluster, ending centred on it, north up, never zooming out, with
 *  the cluster on screen and heading straight for the centre throughout (zoomOnto, which also
 *  lifts the pan limit for the move); the zoom-out stop (minZoom) stays as it is. */
export function zoomOntoCluster(
  map: MapLibreMap,
  center: [number, number],
  expansionZoom: number | null,
  reducedMotion: boolean,
): void {
  zoomOnto(map, center, markMove({ zoom: map.getZoom(), expansionZoom, maxZoom: CLUSTER_ZOOM_CAP, reducedMotion }));
}
