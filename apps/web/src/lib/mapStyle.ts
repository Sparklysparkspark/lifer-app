import { layers, namedFlavor } from "@protomaps/basemaps";
import type { ExpressionSpecification, LayerSpecification, StyleSpecification } from "maplibre-gl";

// Lifer's calm basemap: paper land, a soft water hue, a hint of landcover, crisp borders and a few
// labels. No roads, buildings, POIs or icons (they only clutter a map of wildlife photos). The colours
// are the --color-map-* tokens, read once per map because map paint can't use CSS variables.
const KEEP = new Set(["background", "earth", "landcover", "landuse_park", "water", "boundaries_country", "boundaries"]);

/** A theme token's value: map paint can't read CSS variables. */
export function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "gray";
}

/** The one bundled font (Noto Sans, Latin ranges only, see lib/pmtiles.ts). Photo layers that add
 *  text (cluster numerals) use it too. */
export const MAP_FONT = ["Noto Sans Regular"];
// Landcover stops at zoom 7 in the archive: a second source capped there overzooms it instead of
// dropping the tint at zoom 8.
export const LANDCOVER_SOURCE_ID = "protomaps-landcover";
const NATURE = ["national_park", "protected_area", "nature_reserve", "forest", "wood"];
const OPEN = ["grassland", "grass", "scrub", "farmland"];

export const PMTILES_SOURCE_ID = "protomaps";
export const RELIEF_SOURCE_ID = "relief";

const CREDITS_PAGE = "https://sparklysparkspark.github.io/lifer-app/credits#maps-and-regions";
/** The bundled map's licence credit (OpenStreetMap under ODbL, Natural Earth at world zoom). */
export const BASEMAP_ATTRIBUTION =
  '<a href="https://protomaps.com" target="_blank" rel="noopener">Protomaps</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors, Natural Earth';
// The Terrain Tiles providers' required list is long, so the map line links to it in the credits.
const TERRAIN_ATTRIBUTION = `<a href="${CREDITS_PAGE}" target="_blank" rel="noopener">Terrain Tiles and its sources</a>`;

export function quietLayers(source: string, theme: "light" | "dark"): LayerSpecification[] {
  const land = token("--color-map-land");
  const forest = token("--color-map-forest");
  const scrub = token("--color-map-scrub");
  const ice = token("--color-map-ice");
  const flavor = {
    ...namedFlavor(theme),
    background: token("--color-map-water"),
    earth: land,
    water: token("--color-map-water"),
  };
  const paint: Record<string, LayerSpecification["paint"]> = {
    landcover: {
      "fill-color": ["match", ["get", "kind"], "forest", forest, OPEN, scrub, "glacier", ice, land],
    },
    // Reserves and woods sharpen the landcover once a region fills the map.
    landuse_park: {
      "fill-color": ["match", ["get", "kind"], NATURE, forest, OPEN, scrub, "glacier", ice, land],
      "fill-opacity": ["interpolate", ["linear"], ["zoom"], 6, 0, 8, 1],
    },
    boundaries_country: { "line-color": token("--color-map-line"), "line-width": 0.8 },
    boundaries: {
      "line-color": token("--color-map-line-province"),
      "line-width": 0.7,
      "line-dasharray": [3, 2],
      "line-opacity": ["interpolate", ["linear"], ["zoom"], 3.5, 0, 4.5, 1],
    },
  };
  const base = layers(source, flavor, { lang: "en" })
    .filter((l) => KEEP.has(l.id))
    .map((l) => {
      const styled = { ...l, paint: paint[l.id] ?? l.paint } as LayerSpecification;
      if (l.id === "landuse_park")
        return { ...styled, filter: ["in", ["get", "kind"], ["literal", [...NATURE, ...OPEN, "glacier"]]] };
      if (l.id === "landcover") return { ...styled, source: LANDCOVER_SOURCE_ID };
      if (l.id === "boundaries") return { ...styled, minzoom: 3.5 };
      return styled;
    }) as LayerSpecification[];
  return [...base, ...labelLayers(source, land)];
}

/** Country names at world zoom; province names and towns over 50,000 people once a region fills
 *  the map. English names only: the bundled glyphs are Latin. Under the photo layers, so they yield. */
function labelLayers(source: string, halo: string): LayerSpecification[] {
  const label = token("--color-map-label");
  const common = {
    type: "symbol" as const,
    source,
    "source-layer": "places",
    paint: { "text-color": label, "text-halo-color": halo, "text-halo-width": 1.25, "text-halo-blur": 0.5 },
  };
  const layout = {
    "text-field": ["get", "name:en"] as ExpressionSpecification,
    "text-font": MAP_FONT,
    "text-max-width": 8,
    "symbol-sort-key": ["coalesce", ["get", "sort_key"], ["get", "min_zoom"]] as ExpressionSpecification,
  };
  return [
    {
      ...common,
      id: "label-country",
      minzoom: 1,
      maxzoom: 7,
      filter: ["all", ["==", ["get", "kind"], "country"], ["has", "name:en"]],
      layout: {
        ...layout,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.08,
        "text-size": ["interpolate", ["linear"], ["zoom"], 2, 10, 6, 13],
      },
    },
    {
      ...common,
      id: "label-province",
      minzoom: 4,
      filter: ["all", ["==", ["get", "kind"], "region"], ["has", "name:en"]],
      layout: {
        ...layout,
        "text-transform": "uppercase",
        "text-letter-spacing": 0.06,
        "text-size": ["interpolate", ["linear"], ["zoom"], 4, 10, 8, 12],
      },
    },
    {
      ...common,
      id: "label-town",
      minzoom: 5,
      filter: [
        "all",
        ["==", ["get", "kind"], "locality"],
        [">=", ["coalesce", ["get", "population"], 0], 50000],
        ["has", "name:en"],
      ],
      layout: { ...layout, "text-size": ["interpolate", ["linear"], ["zoom"], 5, 11, 10, 13] },
    },
  ] as LayerSpecification[];
}

export const RELIEF_LAYER_ID = "relief-hillshade";
export const ELEVATION_TINT_LAYER_ID = "relief-elevation";
// A north-west sun plus fainter fill lights, so slopes facing away from it still read.
const LIGHTS = [315, 270, 0, 225];
// Each light's strength as a hex alpha suffix on the token colour.
const SHADOW_ALPHA = ["ff", "80", "80", "40"];
const HIGHLIGHT_ALPHA = ["ff", "00", "00", "00"];

/** Shaded relief from the offline elevation archive (terrarium tiles). `strong` is the relief look
 *  (photo map): lit from several sides and tinted by elevation. */
export function reliefStyleParts(
  url: string,
  strong = false,
): Pick<StyleSpecification, "sources"> & {
  hillshade: LayerSpecification;
  tint?: LayerSpecification;
} {
  const dem = {
    type: "raster-dem" as const,
    url: `pmtiles://${url}`,
    encoding: "terrarium" as const,
    tileSize: 256,
    maxzoom: 5,
  };
  return {
    sources: { [RELIEF_SOURCE_ID]: { ...dem, attribution: TERRAIN_ATTRIBUTION } },
    hillshade: {
      id: RELIEF_LAYER_ID,
      type: "hillshade",
      source: RELIEF_SOURCE_ID,
      paint: strong ? strongShade() : quietShade(),
    },
    ...(strong && { tint: elevationTint() }),
  };
}

type ShadePaint = Extract<LayerSpecification, { type: "hillshade" }>["paint"];

function quietShade(): ShadePaint {
  return {
    "hillshade-shadow-color": token("--color-map-relief"),
    "hillshade-highlight-color": token("--color-map-relief-highlight"),
    "hillshade-accent-color": token("--color-map-relief"),
    // Stronger once a region fills the map, lit from the north-west whatever the bearing.
    "hillshade-exaggeration": ["interpolate", ["linear"], ["zoom"], 3, 0.6, 5, 0.75],
    "hillshade-illumination-direction": 315,
    "hillshade-illumination-anchor": "map",
  };
}

function strongShade(): ShadePaint {
  const weighted = (c: string, alpha: string[]) => alpha.map((a) => (/^#[0-9a-f]{6}$/i.test(c) ? c + a : c));
  return {
    "hillshade-method": "multidirectional",
    "hillshade-illumination-direction": LIGHTS,
    "hillshade-illumination-altitude": LIGHTS.map(() => 35),
    "hillshade-shadow-color": weighted(token("--color-map-relief"), SHADOW_ALPHA),
    "hillshade-highlight-color": weighted(token("--color-map-relief-highlight"), HIGHLIGHT_ALPHA),
    "hillshade-exaggeration": ["interpolate", ["linear"], ["zoom"], 2, 0.4, 5, 0.7],
    "hillshade-illumination-anchor": "map",
  };
}

/** Lowlands stay clear so landcover shows; uplands go tan, brown, then snow. Faded in by region
 *  zoom so the world view stays calm under the pins. */
function elevationTint(): LayerSpecification {
  return {
    id: ELEVATION_TINT_LAYER_ID,
    type: "color-relief",
    source: RELIEF_SOURCE_ID,
    paint: {
      "color-relief-color": [
        "interpolate",
        ["linear"],
        ["elevation"],
        300,
        token("--color-map-elevation-low"),
        1200,
        token("--color-map-elevation-mid"),
        2800,
        token("--color-map-elevation-high"),
        4500,
        token("--color-map-elevation-peak"),
      ],
      "color-relief-opacity": ["interpolate", ["linear"], ["zoom"], 2, 0.3, 5, 0.85],
    },
  };
}

// --- Online relief (Mapterhorn, docs/plans/refined-feel.md RF-M2) ---

export const ONLINE_RELIEF_SOURCE_ID = "online-relief";
export const ONLINE_RELIEF_LAYER_ID = "online-relief-hillshade";
/** Past the bundled archive's zoom 5 its relief goes soft, so sharper tiles take over from here. */
export const ONLINE_RELIEF_FROM = 6;
export const MAPTERHORN = {
  name: "Mapterhorn",
  // Key-free terrarium tiles; the planet set stops at 12 (deeper ones are regional only).
  tiles: "https://tiles.mapterhorn.com/{z}/{x}/{y}.webp",
  maxzoom: 12,
  attribution: '<a href="https://mapterhorn.com/attribution" target="_blank" rel="noopener">© Mapterhorn</a>',
} as const;

export function onlineReliefSource(): StyleSpecification["sources"][string] {
  return {
    type: "raster-dem",
    tiles: [MAPTERHORN.tiles],
    encoding: "terrarium",
    tileSize: 512,
    maxzoom: MAPTERHORN.maxzoom,
    attribution: MAPTERHORN.attribution,
  };
}

// --- Online detail and satellite (docs/plans/map-detail-and-satellite.md) ---

/** Online sources, added at runtime only once the user turns Online detail on. */
export const DETAIL_SOURCE_ID = "online-detail";
export const SATELLITE_SOURCE_ID = "online-satellite";
/** Every basemap source, bundled or online: overlays (region mask, photos) go above all of them. */
export const BASEMAP_SOURCE_IDS: ReadonlySet<string> = new Set([
  PMTILES_SOURCE_ID,
  LANDCOVER_SOURCE_ID,
  RELIEF_SOURCE_ID,
  ONLINE_RELIEF_SOURCE_ID,
  DETAIL_SOURCE_ID,
  SATELLITE_SOURCE_ID,
]);
/** Downloaded detailed maps get one source each: this prefix plus the country code. */
export const OFFLINE_DETAIL_PREFIX = "offline-detail-";
/** Whether a source is part of the basemap (bundled, downloaded or online), not an overlay. */
export const isBasemapSource = (id: string | undefined): boolean =>
  !!id && (BASEMAP_SOURCE_IDS.has(id) || id.startsWith(OFFLINE_DETAIL_PREFIX));
/** The bundled archive's max zoom: past it online detail takes over, rather than enlarging its tiles. */
export const OFFLINE_DETAIL_ZOOM = 8;
// Online detail shows (and so is requested) only from here; below it the bundled map is enough.
const DETAIL_FROM = OFFLINE_DETAIL_ZOOM;

export const ONLINE_PROVIDERS = {
  // Key-free OpenMapTiles vector tiles to zoom 14 (vectors stay sharp past it).
  detail: {
    name: "OpenFreeMap",
    tilejson: "https://tiles.openfreemap.org/planet",
    maxZoom: 18,
    attribution:
      '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  },
  // Sentinel-2 cloudless, about 10 m: tiles past 14 are only upscaled, so MapLibre enlarges instead.
  satellite: {
    name: "EOxCloudless",
    tiles: "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2025_3857/default/g/{z}/{y}/{x}.jpg",
    tileMaxZoom: 14,
    maxZoom: 16,
    attribution:
      '<a href="https://cloudless.eox.at" target="_blank" rel="noopener">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2025)',
  },
} as const;
/** A user's own imagery URL, e.g. a keyed provider: their tiles usually go deeper. */
export const CUSTOM_SATELLITE_MAX_ZOOM = 19;

/** An https XYZ template with {z}, {x} and {y}, or null. */
export function customSatelliteUrl(raw: string): string | null {
  const url = raw.trim();
  if (!/^https:\/\/[^\s/]+\//.test(url) || !["{z}", "{x}", "{y}"].every((p) => url.includes(p))) return null;
  return url;
}

const hostOf = (template: string) => new URL(template.replace(/[{}]/g, "")).host;

/** Who the tiles come from, for the consent line. */
export function providerNames(satelliteUrl: string): { detail: string; relief: string; imagery: string } {
  const custom = customSatelliteUrl(satelliteUrl);
  return {
    detail: ONLINE_PROVIDERS.detail.name,
    relief: MAPTERHORN.name,
    imagery: custom ? hostOf(custom) : ONLINE_PROVIDERS.satellite.name,
  };
}

export type OnlineMode = "detail" | "satellite";

/** The online sources for a mode; the detail source also labels the satellite view. */
export function onlineSources(mode: OnlineMode, customUrl: string | null): StyleSpecification["sources"] {
  const detail = {
    type: "vector" as const,
    url: ONLINE_PROVIDERS.detail.tilejson,
    attribution: ONLINE_PROVIDERS.detail.attribution,
  };
  if (mode === "detail") return { [DETAIL_SOURCE_ID]: detail };
  const sat = ONLINE_PROVIDERS.satellite;
  return {
    [DETAIL_SOURCE_ID]: detail,
    [SATELLITE_SOURCE_ID]: customUrl
      ? {
          type: "raster",
          tiles: [customUrl],
          tileSize: 256,
          maxzoom: CUSTOM_SATELLITE_MAX_ZOOM,
          attribution: hostOf(customUrl),
        }
      : { type: "raster", tiles: [sat.tiles], tileSize: 256, maxzoom: sat.tileMaxZoom, attribution: sat.attribution },
  };
}

export function onlineMaxZoom(mode: OnlineMode, customUrl: string | null): number {
  if (mode === "detail") return ONLINE_PROVIDERS.detail.maxZoom;
  return customUrl ? CUSTOM_SATELLITE_MAX_ZOOM : ONLINE_PROVIDERS.satellite.maxZoom;
}

/** Where a layer goes: under the relief (fills), under the bundled borders (lines), or on top of
 *  the basemap under the photo layers (labels, imagery). */
export type OnlineSlot = "fill" | "line" | "top";
const slot = (s: OnlineSlot) => ({ metadata: { "lifer:slot": s } });
export const slotOf = (l: LayerSpecification): OnlineSlot =>
  ((l.metadata as Record<string, unknown> | undefined)?.["lifer:slot"] as OnlineSlot | undefined) ?? "top";

const NAME = ["coalesce", ["get", "name:latin"], ["get", "name"]] as ExpressionSpecification;

/** The calm look from zoom 8 on, from OpenMapTiles: the same tokens as the bundled style, plus quiet
 *  roads and trails for placing photos. No buildings, POIs or icons. */
export function detailLayers(): LayerSpecification[] {
  const water = token("--color-map-water");
  const land = token("--color-map-land");
  const forest = token("--color-map-forest");
  const scrub = token("--color-map-scrub");
  const ice = token("--color-map-ice");
  const road = token("--color-map-line-province");
  const base = { source: DETAIL_SOURCE_ID, minzoom: DETAIL_FROM };
  return [
    {
      ...base,
      ...slot("fill"),
      id: "detail-landcover",
      type: "fill",
      "source-layer": "landcover",
      filter: ["in", ["get", "class"], ["literal", ["wood", "grass", "wetland", "ice", "farmland"]]],
      paint: {
        "fill-color": ["match", ["get", "class"], "wood", forest, "ice", ice, scrub],
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], DETAIL_FROM, 0, DETAIL_FROM + 1, 1],
      },
    },
    {
      ...base,
      ...slot("fill"),
      id: "detail-park",
      type: "fill",
      "source-layer": "park",
      paint: {
        "fill-color": forest,
        "fill-opacity": ["interpolate", ["linear"], ["zoom"], DETAIL_FROM, 0, DETAIL_FROM + 1, 0.6],
      },
    },
    {
      ...base,
      ...slot("line"),
      id: "detail-water",
      type: "fill",
      "source-layer": "water",
      paint: { "fill-color": water },
    },
    {
      ...base,
      ...slot("line"),
      id: "detail-waterway",
      type: "line",
      "source-layer": "waterway",
      paint: { "line-color": water, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 16, 3] },
    },
    {
      ...base,
      ...slot("line"),
      id: "detail-road",
      type: "line",
      "source-layer": "transportation",
      minzoom: 10,
      filter: ["in", ["get", "class"], ["literal", ["motorway", "trunk", "primary", "secondary", "tertiary", "minor"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": road, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3] },
    },
    {
      ...base,
      ...slot("line"),
      id: "detail-trail",
      type: "line",
      "source-layer": "transportation",
      minzoom: 12,
      filter: ["in", ["get", "class"], ["literal", ["path", "track"]]],
      paint: { "line-color": road, "line-width": 1, "line-dasharray": [2, 2] },
    },
    ...detailLabels(token("--color-map-label"), land, DETAIL_FROM),
  ] as LayerSpecification[];
}

/** Imagery, with light names over it: a map with no names is hard to find your way on. */
export function satelliteLayers(): LayerSpecification[] {
  return [
    { ...slot("top"), id: "satellite-imagery", type: "raster", source: SATELLITE_SOURCE_ID },
    ...detailLabels(token("--color-accent-fg"), token("--color-surround"), 0),
  ] as LayerSpecification[];
}

function detailLabels(color: string, halo: string, minzoom: number): LayerSpecification[] {
  const common = {
    ...slot("top"),
    type: "symbol" as const,
    source: DETAIL_SOURCE_ID,
    paint: { "text-color": color, "text-halo-color": halo, "text-halo-width": 1.25, "text-halo-blur": 0.5 },
  };
  const layout = { "text-field": NAME, "text-font": MAP_FONT, "text-max-width": 8 };
  const placeId = minzoom === 0 ? "satellite-label-place" : "detail-label-place";
  return [
    {
      ...common,
      id: placeId.replace("place", "water"),
      "source-layer": "water_name",
      minzoom: Math.max(minzoom, 9),
      // Lakes only: seas, bays and straits carry a label point per tile, so their names repeat.
      filter: ["all", ["==", ["geometry-type"], "Point"], ["==", ["get", "class"], "lake"]],
      layout: { ...layout, "text-size": 11, "symbol-placement": "point" },
    },
    {
      ...common,
      id: placeId,
      "source-layer": "place",
      minzoom,
      // Satellite has no bundled labels above it, so it shows countries and provinces too.
      filter:
        minzoom === 0
          ? ["has", "name"]
          : ["in", ["get", "class"], ["literal", ["city", "town", "village", "hamlet", "suburb", "island"]]],
      layout: {
        ...layout,
        "text-size": ["match", ["get", "class"], ["country", "state", "city"], 13, ["town", "island"], 12, 11],
        "symbol-sort-key": ["coalesce", ["get", "rank"], 99],
      },
    },
  ] as LayerSpecification[];
}

/** A downloaded country map (Protomaps schema, zoom 9 on): the calm look plus quiet roads, trails and
 *  towns. `fills` go right above the world map's water, so the extract's coastline wins; `labels` on top. */
export function offlineDetailLayers(code: string): { fills: LayerSpecification[]; labels: LayerSpecification[] } {
  const water = token("--color-map-water");
  const land = token("--color-map-land");
  const forest = token("--color-map-forest");
  const scrub = token("--color-map-scrub");
  const ice = token("--color-map-ice");
  const road = token("--color-map-line-province");
  const source = `${OFFLINE_DETAIL_PREFIX}${code}`;
  const id = (name: string) => `${source}-${name}`;
  const polygons = ["==", ["geometry-type"], "Polygon"] as ExpressionSpecification;
  const fills = [
    { id: id("earth"), type: "fill", source, "source-layer": "earth", paint: { "fill-color": land } },
    {
      id: id("landuse"),
      type: "fill",
      source,
      "source-layer": "landuse",
      filter: ["in", ["get", "kind"], ["literal", [...NATURE, ...OPEN, "glacier"]]],
      paint: { "fill-color": ["match", ["get", "kind"], NATURE, forest, OPEN, scrub, "glacier", ice, land] },
    },
    {
      id: id("water"),
      type: "fill",
      source,
      "source-layer": "water",
      filter: polygons,
      paint: { "fill-color": water },
    },
    {
      id: id("waterway"),
      type: "line",
      source,
      "source-layer": "water",
      filter: ["==", ["geometry-type"], "LineString"],
      paint: { "line-color": water, "line-width": ["interpolate", ["linear"], ["zoom"], 9, 0.5, 16, 3] },
    },
    {
      id: id("road"),
      type: "line",
      source,
      "source-layer": "roads",
      minzoom: 10,
      filter: ["in", ["get", "kind"], ["literal", ["highway", "major_road", "minor_road"]]],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": road, "line-width": ["interpolate", ["linear"], ["zoom"], 10, 0.5, 16, 3] },
    },
    {
      id: id("trail"),
      type: "line",
      source,
      "source-layer": "roads",
      minzoom: 12,
      filter: ["==", ["get", "kind"], "path"],
      paint: { "line-color": road, "line-width": 1, "line-dasharray": [2, 2] },
    },
  ];
  const labels = [
    {
      id: id("label-place"),
      type: "symbol",
      source,
      "source-layer": "places",
      filter: ["in", ["get", "kind"], ["literal", ["locality", "neighbourhood"]]],
      layout: {
        "text-field": ["coalesce", ["get", "name:en"], ["get", "name"]],
        "text-font": MAP_FONT,
        "text-max-width": 8,
        "text-size": ["match", ["get", "kind_detail"], "city", 13, "town", 12, 11],
        "symbol-sort-key": ["coalesce", ["get", "sort_key"], ["get", "min_zoom"]],
      },
      paint: {
        "text-color": token("--color-map-label"),
        "text-halo-color": land,
        "text-halo-width": 1.25,
        "text-halo-blur": 0.5,
      },
    },
  ];
  return { fills: fills as LayerSpecification[], labels: labels as LayerSpecification[] };
}
