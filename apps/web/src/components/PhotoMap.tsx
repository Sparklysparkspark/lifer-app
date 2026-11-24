import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Map as MapLibreMap,
  LngLatBounds,
  Marker,
  type GeoJSONSource,
  type ExpressionSpecification,
  type MapGeoJSONFeature,
  type StyleSpecification,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addMapCredits } from "./map/MapCredits";
import type { Point } from "geojson";
import { api, apiPath, type ApiResponse } from "../api/client";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { useLatest } from "../hooks/useLatest";
import { usePersistedState } from "../hooks/usePersistedState";
import { useSearchParamsKeepingState, useUrlParam } from "../hooks/useSearchParamsKeepingState";
import { useEscapeToClose } from "../hooks/useEscapeToClose";
import { isTypingTarget } from "../hooks/useKeyboardShortcuts";
import { useLocationJob, useUndoLocation } from "../hooks/useSavedSpots";
import { useToast } from "../hooks/useToast";
import { reliefAvailable } from "../lib/pmtilesAvailable";
import { ensurePmtilesProtocol, pmtilesStyle, tiltTerrain } from "../lib/pmtiles";
import { MAP_FONT, token } from "../lib/mapStyle";
import { REGION_MASK_LAYER } from "../lib/mapRegionLayers";
import { useRegionCamera } from "../hooks/useRegionCamera";
import { useCuratedTilt } from "../hooks/useCuratedTilt";
import { curatedPitch, markMove, openingBounds, regionFraming, TILT, type TiltMode } from "../lib/mapCamera";
import { zoomOnto } from "../lib/zoomOnto";
import {
  clusterRadius,
  MAX_MARK_RADIUS,
  pickNearest,
  pickSlop,
  pointRadius,
  ringRadius,
  SPOT_RADIUS,
  spotUnderMark,
  type PickCandidate,
  type PickKind,
} from "../lib/mapPick";
import { useRegions } from "../hooks/useRegions";
import RegionViewBar, { type RegionStep } from "./RegionViewBar";
import { countryBoundariesResource } from "../lib/countryBoundaries";
import { useApiResource } from "../lib/resource";
import { formatList, formatNumber } from "../lib/format";
import { formatCoordinates } from "../lib/coordinates";
import { errorMessage } from "../lib/errorMessage";
import { ignore } from "../lib/ignore";
import { matches } from "../lib/keymap";
import Button from "./Button";
import Panel from "./Panel";
import FormMessage from "./FormMessage";
import EmptyState from "./EmptyState";
import JobProgress from "./JobProgress";
import PlacePicker, { type FoundPlace } from "./PlacePicker";
import PlaceSuggestions from "./PlaceSuggestions";
import type { MenuAction } from "./Menu";
import { AddSpotModal, type SavedSpot } from "./SavedSpots";
import SegmentedControl from "./SegmentedControl";
import Lightbox, { type LightboxSlide } from "./Lightbox";
import MapHoverCard from "./map/MapHoverCard";
import { gallerySlide } from "./map/gallerySlide";
import { useSpeciesName } from "../lib/speciesName";
import { TAXA_GROUPS } from "../lib/taxaColour";
import { CLUSTER_SUMS, MAP_MAX_ZOOM, PHOTO_CLUSTERING, photoFeatures } from "../lib/mapPhotos";
import type { Box } from "../lib/cardPlacement";
import { Spinner } from "./LoadingScreen";
import MapSidePanel from "./map/MapSidePanel";
import MapPhotoPanel from "./map/MapPhotoPanel";
import NeedsPlacingTray, { type PlaceSource } from "./map/NeedsPlacingTray";
import { SPECIES_DOWNLOADS_PATH } from "../lib/speciesDownloads";

type MapData = ApiResponse<"/gallery/map">;
type PointGeometry = Point & { coordinates: [number, number] };
type Selection =
  | { kind: "region"; id: string; regionOnly: boolean }
  | { kind: "area"; bbox: string; single: boolean }
  | { kind: "spot"; id: string };
type Side = { kind: "tray" } | { kind: "photos"; selection: Selection };
/** Photos being placed: picked in the Gallery, or the photos at a dot being moved. */
export interface Placing {
  captureIds: string[];
  /** The ones that already have coordinates, which are kept unless the user picks Replace all. */
  located: ReadonlySet<string>;
}
// `found`: an online result's name and locality, to prefill saving it as a place.
type Pending = { lat: number; lon: number; spot: SavedSpot | null; found?: { name: string; locality: string | null } };
type Hover = {
  x: number;
  y: number;
  /** The mark's radius, which the card keeps clear of. */
  r: number;
  title: string;
  line: string;
  photoIds: string[];
  /** The Gallery query for the mark's photos, and the panel Show all opens; null for an area. */
  query: URLSearchParams | null;
  side: Side | null;
  /** The map's box and the controls over it, for keeping the card inside and clear of them. */
  within?: Box;
  obstacles?: Box[];
};
// After leaving a mark, this long to reach its card before it closes.
const CARD_GRACE_MS = 200;

const COUNTRIES = "photo-map-countries";
const PHOTOS = "photo-map-photos";
const COUNTRY_FILL = "photo-map-country-fill";
const REGION_RINGS = "photo-map-region-bubbles";
const CLUSTERS = "photo-map-clusters";
const POINTS = "photo-map-points";
const SPOTS = "photo-map-spots";
const SPOT_MARKERS = "photo-map-spot-markers";
const SPOT_AREAS = "photo-map-spot-areas";
const SPOT_LABELS = "photo-map-spot-labels";
const CLUSTER_COUNTS = "photo-map-cluster-counts";
const HOLLOW_CLUSTERS = "photo-map-hollow-clusters";
const POINT_COUNTS = "photo-map-point-counts";
const RING_COUNTS = "photo-map-ring-counts";
const PROVINCES = "photo-map-provinces";
const PROVINCE_FILL = "photo-map-province-fill";
const HALO = "photo-map-hover-halo";
/** Past this many photos a placement runs as a background job (the API's SYNC_PLACE_MAX). */
const SYNC_PLACE_MAX = 5000;
const WORLD_VIEW = { center: [10, 25] as [number, number], zoom: 1 };
const LIST_PREVIEW = 8;
const HOVER_DELAY_MS = 250;
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
// How long a move onto a mark waits for the panel's resize before going anyway: the resize
// normally comes within a frame or two; this only covers a panel that never opens.
const PANEL_RESIZE_WAIT_MS = 1000;
// A click this soon after a pan or zoom ends is its tail, not a click.
const GESTURE_GRACE_MS = 250;
// How far past a framing's zoom a click on land still changes the region level.
const NEAR_FRAMING_ZOOM = 0.75;
const LONG_PRESS_MS = 500;

const groupColours = () => TAXA_GROUPS.flatMap((g) => [g, token(`--color-taxa-${g}`)]);

// A cluster takes the colour of the group with the most photos in it.
function clusterColour(): never {
  const colours = Object.fromEntries(TAXA_GROUPS.map((g) => [g, token(`--color-taxa-${g}`)]));
  const [last, ...rest] = [...TAXA_GROUPS].reverse();
  const expr: unknown[] = ["case"];
  for (const g of rest.reverse())
    expr.push(["all", ...TAXA_GROUPS.filter((o) => o !== g).map((o) => [">=", ["get", g], ["get", o]])], colours[g]);
  expr.push(colours[last]);
  return expr as never;
}

// --- Look: basemap and photo layer paint ---

function plainStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {},
    layers: [{ id: "background", type: "background", paint: { "background-color": token("--color-map-water") } }],
  };
}

function mapStyle(available: boolean, theme: string): StyleSpecification {
  return available ? pmtilesStyle(theme === "dark" ? "dark" : "light", { strongRelief: true }) : plainStyle();
}

// "1,204" fits a disc up to four digits; past that "12k". A ring has its own count.
const countLabel = (count: string) =>
  [
    "case",
    [">=", ["get", count], 10000],
    ["concat", ["to-string", ["round", ["/", ["get", count], 1000]]], "k"],
    ["number-format", ["get", count], { locale: "en" }],
  ] as never;
const CLUSTER_LABEL = countLabel("total");
const RING_LABEL = ["case", ["has", "point_count"], countLabel("total"), countLabel("count")] as never;

/** The photo map's sources and layers, bottom to top. Countries aren't shaded by count (the list
 *  and the hover carry counts); the ones with photos get a firmer outline. */
function addPhotoLayers(map: MapLibreMap, { dark, plain }: { dark: boolean; plain: boolean }): void {
  const ink = token("--color-ink");
  const accent = token("--color-accent");
  const surface = token("--color-surface");
  const empty = { type: "FeatureCollection" as const, features: [] };
  map.addSource(COUNTRIES, { type: "geojson", data: empty, promoteId: "id" });
  // Grid cells of placed photos and rings of region-only ones, so both merge as you zoom out; a
  // cluster sums the total, the placed and the region-only photos.
  map.addSource(PHOTOS, {
    type: "geojson",
    data: empty,
    ...PHOTO_CLUSTERING,
    clusterProperties: {
      ...CLUSTER_SUMS,
      ...Object.fromEntries(
        TAXA_GROUPS.map((g) => [g, ["+", ["case", ["==", ["get", "group"], g], ["get", "count"], 0]]]),
      ),
    },
  });
  map.addSource(SPOTS, { type: "geojson", data: empty });
  map.addSource(PROVINCES, { type: "geojson", data: empty, promoteId: "id" });
  map.addSource(HALO, { type: "geojson", data: empty });
  const hasPhotos = [">", ["coalesce", ["feature-state", "count"], 0], 0] as never;
  const hovered = ["boolean", ["feature-state", "hover"], false] as never;
  const highlight = token("--color-link");
  // Over the basemap it's invisible but for the hover tint, there so a click knows the country;
  // without the basemap it is the land.
  map.addLayer({
    id: COUNTRY_FILL,
    type: "fill",
    source: COUNTRIES,
    paint: plain
      ? { "fill-color": token("--color-map-land"), "fill-opacity": 1 }
      : { "fill-color": highlight, "fill-opacity": ["case", hovered, 0.2, 0] as never },
  });
  // A framed country's provinces, from Lifer's own outlines so a click files under the same ids.
  map.addLayer({
    id: PROVINCE_FILL,
    type: "fill",
    source: PROVINCES,
    paint: { "fill-color": highlight, "fill-opacity": ["case", hovered, 0.2, 0] as never },
  });
  map.addLayer({
    id: "photo-map-province-line",
    type: "line",
    source: PROVINCES,
    paint: { "line-color": highlight, "line-width": 1.5, "line-opacity": ["case", hovered, 1, 0] as never },
  });
  map.addLayer({
    id: "photo-map-country-line",
    type: "line",
    source: COUNTRIES,
    paint: {
      "line-color": [
        "case",
        hovered,
        highlight,
        hasPhotos,
        token("--color-map-line-province"),
        token("--color-map-line"),
      ] as never,
      "line-width": ["case", hovered, 1.5, hasPhotos, 1.2, 0.8] as never,
      "line-opacity": ["case", hovered, 1, hasPhotos, 1, plain ? 1 : 0] as never,
    },
  });
  // Saved spots sit under every photo mark and its count: a spot never hides a number.
  // The area a spot covers (its radius), drawn to scale.
  map.addLayer({
    id: SPOT_AREAS,
    type: "circle",
    source: SPOTS,
    paint: {
      "circle-color": accent,
      "circle-opacity": 0.08,
      "circle-radius": [
        "interpolate",
        ["exponential", 2],
        ["zoom"],
        0,
        ["get", "r0"],
        22,
        ["*", ["get", "r0"], 2 ** 22],
      ],
      "circle-stroke-color": accent,
      "circle-stroke-opacity": 0.5,
      "circle-stroke-width": 1,
    },
  });
  // A ring, so a spot reads apart from the photos' filled dots.
  map.addLayer({
    id: SPOT_MARKERS,
    type: "circle",
    source: SPOTS,
    paint: {
      "circle-color": surface,
      // A place's photos are this one mark (the API leaves them out of the dots), sized like a cluster.
      "circle-radius": [
        "case",
        [">", ["get", "count"], 0],
        ["interpolate", ["linear"], ["sqrt", ["get", "count"]], 1, 11, 30, 22, 300, 36],
        6,
      ] as never,
      "circle-stroke-color": accent,
      "circle-stroke-width": 3,
    },
  });
  // Its count inside, and its name under it where there's room.
  map.addLayer({
    id: SPOT_LABELS,
    type: "symbol",
    source: SPOTS,
    filter: [">", ["get", "count"], 0],
    layout: {
      "text-field": ["format", ["get", "countLabel"], {}, "\n", {}, ["get", "name"], { "font-scale": 0.9 }] as never,
      "text-font": MAP_FONT,
      "text-size": 11,
      "text-line-height": 2.6,
      "text-max-width": 12,
      "text-optional": true,
    },
    paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.5 },
  });
  // Hollow: photos with only a region are approximate, so they never read as placed. A ring, or
  // a cluster of rings only, is an outline with its count; any placed photo makes a cluster solid,
  // and a solid one with region-only photos in it keeps an outline ring around it.
  const sized = (count: string) =>
    ["interpolate", ["linear"], ["sqrt", ["get", count]], 1, 11, 30, 22, 300, 36] as never;
  const isCluster = ["has", "point_count"] as ExpressionSpecification;
  const hollow = {
    "circle-color": surface,
    "circle-opacity": 0.01,
    "circle-stroke-color": ink,
    "circle-stroke-opacity": 0.7,
    "circle-stroke-width": 1.5,
  };
  map.addLayer({
    id: REGION_RINGS,
    type: "circle",
    source: PHOTOS,
    filter: ["all", ["!", isCluster], ["==", ["get", "ring"], true]],
    paint: { ...hollow, "circle-radius": sized("count") },
  });
  map.addLayer({
    id: HOLLOW_CLUSTERS,
    type: "circle",
    source: PHOTOS,
    filter: ["all", isCluster, ["==", ["get", "placed"], 0]],
    paint: { ...hollow, "circle-radius": sized("total") },
  });
  map.addLayer({
    id: CLUSTERS,
    type: "circle",
    source: PHOTOS,
    filter: ["all", isCluster, [">", ["get", "placed"], 0]],
    paint: {
      "circle-color": clusterColour(),
      "circle-opacity": 0.9,
      "circle-stroke-color": ["case", [">", ["get", "regionOnly"], 0], ink, surface] as never,
      "circle-stroke-width": ["case", [">", ["get", "regionOnly"], 0], 2.5, 2] as never,
      "circle-radius": sized("total"),
    },
  });
  // White on the dark light-mode discs; canvas on the light dark-mode ones (contrast.test.ts).
  map.addLayer({
    id: CLUSTER_COUNTS,
    type: "symbol",
    source: PHOTOS,
    filter: ["all", isCluster, [">", ["get", "placed"], 0]],
    layout: { "text-field": CLUSTER_LABEL, "text-font": MAP_FONT, "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": token(dark ? "--color-canvas" : "--color-accent-fg") },
  });
  // A hollow mark's count sits on the map itself: ink, haloed in the surface colour.
  map.addLayer({
    id: RING_COUNTS,
    type: "symbol",
    source: PHOTOS,
    filter: [
      "any",
      ["all", isCluster, ["==", ["get", "placed"], 0]],
      ["all", ["!", isCluster], ["==", ["get", "ring"], true]],
    ],
    layout: {
      "text-field": RING_LABEL,
      "text-font": MAP_FONT,
      "text-size": 11,
      "text-allow-overlap": true,
    },
    paint: { "text-color": ink, "text-halo-color": surface, "text-halo-width": 1.5 },
  });
  map.addLayer({
    id: POINTS,
    type: "circle",
    source: PHOTOS,
    filter: ["all", ["!", isCluster], ["!=", ["get", "ring"], true]],
    paint: {
      "circle-color": ["match", ["get", "group"], ...groupColours(), accent] as never,
      "circle-stroke-color": surface,
      // Several photos at one point read as a cluster, with its size and count, never a lone dot.
      "circle-stroke-width": ["case", [">", ["get", "count"], 1], 2, 1.5] as never,
      "circle-opacity": ["case", [">", ["get", "count"], 1], 0.9, 1] as never,
      "circle-radius": ["case", [">", ["get", "count"], 1], sized("count"), 5] as never,
    },
  });
  map.addLayer({
    id: POINT_COUNTS,
    type: "symbol",
    source: PHOTOS,
    filter: ["all", ["!", isCluster], ["!=", ["get", "ring"], true], [">", ["get", "count"], 1]],
    layout: { "text-field": countLabel("count"), "text-font": MAP_FONT, "text-size": 11, "text-allow-overlap": true },
    paint: { "text-color": token(dark ? "--color-canvas" : "--color-accent-fg") },
  });
  // Around the mark a click would take, so a forgiving hit is visible before it lands.
  map.addLayer({
    id: HALO,
    type: "circle",
    source: HALO,
    paint: {
      "circle-color": surface,
      "circle-opacity": 0,
      "circle-radius": ["get", "r"] as never,
      "circle-stroke-color": highlight,
      "circle-stroke-width": 2,
    },
  });
}

// --- Camera (MAP-15 wires the curated region framing in here) ---

/** Frames the filtered photos: at once for a new filter set, gliding when leaving a region
 *  (MapLibre skips the glide with reduced motion). */
function frameView(map: MapLibreMap, bounds: LngLatBounds, glide = false): void {
  if (bounds.isEmpty()) map.easeTo({ ...WORLD_VIEW, pitch: 0, bearing: 0, duration: glide ? 900 : 0 });
  else map.fitBounds(bounds, { padding: 48, maxZoom: 10, pitch: 0, bearing: 0, ...(glide ? {} : { duration: 0 }) });
}

/** A search result: a region framed whole, a point closer in. */
function flyToPlace(map: MapLibreMap, place: FoundPlace): void {
  if (place.bbox) {
    const [w, s, e, n] = place.bbox;
    map.fitBounds(
      [
        [w, s],
        [e, n],
      ],
      { padding: 48, maxZoom: 12 },
    );
  } else map.flyTo({ center: [place.lon, place.lat], zoom: 14 });
}

type Feature = MapGeoJSONFeature;

// The map's box on screen and what sits over it: its own controls (credits, zoom) and the
// switches laid over it (3D or Flat, layers), for a card to keep clear of.
function mapRoom(container: HTMLElement | null): { within?: Box; obstacles?: Box[] } {
  if (!container) return {};
  const box = (el: Element) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  };
  const over = [
    ...Array.from(container.parentElement?.children ?? []).filter((el) => el !== container),
    ...Array.from(container.querySelectorAll(".maplibregl-ctrl")),
  ];
  return { within: box(container), obstacles: over.map(box).filter((b) => b.width > 0 && b.height > 0) };
}

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

// MapMouseEvent's own event: a pointer event where the browser sends one, else a touch or a mouse.
function pointerTypeOf(ev?: Event): string {
  if (ev && "pointerType" in ev && (ev as PointerEvent).pointerType) return (ev as PointerEvent).pointerType;
  return ev?.type.startsWith("touch") ? "touch" : "mouse";
}

// The copy of a point (the world repeats sideways) nearest the pointer, on screen.
function projectNear(map: MapLibreMap, [lon, lat]: [number, number], to: { x: number; y: number }) {
  const copies = [lon - 360, lon, lon + 360].map((l) => map.project([l, lat]));
  return copies.reduce((a, b) => (Math.hypot(b.x - to.x, b.y - to.y) < Math.hypot(a.x - to.x, a.y - to.y) ? b : a));
}

function markRadius(kind: PickKind, props: Record<string, unknown>): number {
  if (kind === "cluster") return clusterRadius(Number(props.total));
  if (kind === "point") return Number(props.count) > 1 ? clusterRadius(Number(props.count)) : pointRadius(1);
  if (kind === "ring") return ringRadius(Number(props.count));
  return SPOT_RADIUS;
}

// A country's provinces (or what Lifer has under it), once per country per launch.
const provinceCache = new Map<string, Promise<Array<{ id: string; name: string; geometry: unknown }>>>();
function provincesOf(countryId: string) {
  let list = provinceCache.get(countryId);
  if (!list) {
    list = api
      .get(apiPath("/regions/boundaries", {}, new URLSearchParams({ parentId: countryId })))
      .then((res) =>
        (
          res as { regions: Array<{ id: string; name: string; boundaryGeoJson: { geometry?: unknown } | null }> }
        ).regions
          .filter((r) => r.boundaryGeoJson?.geometry)
          .map((r) => ({ id: r.id, name: r.name, geometry: r.boundaryGeoJson!.geometry })),
      );
    list.catch(() => provinceCache.delete(countryId));
    provinceCache.set(countryId, list);
  }
  return list;
}

const round = (v: number) => Math.round(v * 1e5) / 1e5;
const bboxText = (w: number, s: number, e: number, n: number) => [w, s, e, n].map(round).join(",");

// The side column lives in the URL (?at=), so reload and Back keep it.
function parseAt(at: string): Side | null {
  if (at === "tray") return { kind: "tray" };
  const [kind, value] = [at.slice(0, at.indexOf(":")), at.slice(at.indexOf(":") + 1)];
  if (!value) return null;
  if (kind === "area" || kind === "point")
    return { kind: "photos", selection: { kind: "area", bbox: value, single: kind === "point" } };
  if (kind === "region" || kind === "ring")
    return { kind: "photos", selection: { kind: "region", id: value, regionOnly: kind === "ring" } };
  if (kind === "spot") return { kind: "photos", selection: { kind: "spot", id: value } };
  return null;
}
function atFor(side: Side | null): string {
  if (!side) return "";
  if (side.kind === "tray") return "tray";
  const s = side.selection;
  if (s.kind === "area") return `${s.single ? "point" : "area"}:${s.bbox}`;
  if (s.kind === "region") return `${s.regionOnly ? "ring" : "region"}:${s.id}`;
  return `spot:${s.id}`;
}

/** The status line: "1,204 of 1,556 photos placed." Placed means it has coordinates. */
function placedStatus(t: (key: string, o?: Record<string, unknown>) => string, total: number, unplaced: number) {
  const placed = total - unplaced;
  if (placed === 0) return t("gallery.map.status.none", { count: total });
  if (unplaced === 0) return t("gallery.map.status.all", { count: total, formatted: formatNumber(total) });
  return t("gallery.map.status.some", { count: total, formatted: formatNumber(total), placed: formatNumber(placed) });
}

/** Where the Gallery's filtered photos are, and the place to set where the rest were taken:
 *  dots for placed photos, hollow rings for photos with only a region, and a side column with a
 *  clicked dot's photos or the photos that still need placing. Nothing here leaves the map unless
 *  the user picks Open in Gallery. */
export default function PhotoMap({
  queryString,
  onOpenRegion,
  onOpenArea,
  onOpenPlace,
  onShowUnlocated,
  placing = null,
  onPlacingChange,
  onChanged,
}: {
  /** The Gallery's filters as the API's query string (galleryParams). */
  queryString: string;
  onOpenRegion: (regionId: string) => void;
  /** A map area, "west,south,east,north". */
  onOpenArea: (bbox: string) => void;
  /** The photos filed under a saved spot's name. */
  onOpenPlace?: (name: string) => void;
  /** The filtered photos without coordinates, as a grid. */
  onShowUnlocated?: () => void;
  placing?: Placing | null;
  /** Placing is offered only when set. */
  onPlacingChange?: (next: Placing | null) => void;
  /** Photos were placed or put back, so loaded photo lists are stale. */
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const { data, error, reload } = useApiResource<MapData>(`/gallery/map?${queryString}`);
  const spotsResource = useApiResource<{ spots: SavedSpot[] }>("/saved-spots");
  const spots = useMemo(() => spotsResource.data?.spots ?? [], [spotsResource.data]);
  const spotsRef = useLatest(spots);
  const [at, setAt] = useUrlParam("at");
  // A Gallery selection being placed always shows in the tray.
  const side = placing ? ({ kind: "tray" } as const) : parseAt(at);
  const [sideWidth, setSideWidth] = usePersistedState("photo-map-side-width", 360);
  const [pending, setPending] = useState<Pending | null>(null);
  const [outside, setOutside] = useState<ReadonlySet<string>>(new Set());
  const [replaceAll, setReplaceAll] = useState(false);
  // A new place being named: its point when known (else it's picked in the dialog), and a name or
  // town to start from (typed in the list, or an online result's).
  const [namingSpot, setNamingSpot] = useState<{
    point: { lat: number; lon: number } | null;
    name: string;
    locality: string | null;
  } | null>(null);
  const nameAt = (at: Pending | null, name?: string) =>
    setNamingSpot({
      point: at && { lat: at.lat, lon: at.lon },
      name: name ?? at?.found?.name ?? "",
      locality: at?.found?.locality ?? null,
    });
  const [placeError, setPlaceError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [trayKey, setTrayKey] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const dragSource = useRef<PlaceSource | null>(null);
  // A new set of photos to place starts over: no pin, and keep what's already placed.
  const [placingFor, setPlacingFor] = useState(placing);
  if (placingFor !== placing) {
    setPlacingFor(placing);
    setPending(null);
    setPlaceError(null);
    setReplaceAll(!!placing && placing.located.size === placing.captureIds.length);
  }
  const canPlace = !!onPlacingChange;
  // A pin can go down while the tray is open; elsewhere a click opens the photos under it.
  const pinning = canPlace && side?.kind === "tray";
  const pinningRef = useLatest(pinning);
  const pickRef = useLatest((next: Pending) => {
    setPending(next);
    setPlaceError(null);
  });
  const refresh = useCallback(() => {
    void reload();
    void spotsResource.reload();
    setTrayKey((k) => k + 1);
    onChanged?.();
  }, [reload, spotsResource, onChanged]);
  const job = useLocationJob(refresh);
  const undo = useUndoLocation(refresh);
  const countries = countryBoundariesResource.use().data;
  const mapAvailable = useMapAvailable();
  // 3D is the one curated angle once zoomed in (Auto), or never (Flat); remembered per user.
  const [tiltMode, setTiltMode] = usePersistedState<TiltMode>("photo-map-tilt", "auto");
  const hasRelief = mapAvailable === true && reliefAvailable();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  // The same map as state, for the region camera.
  const [mapObj, setMapObj] = useState<MapLibreMap | null>(null);
  // The side column sits beside the map, so the map's own size already leaves it out.
  const region = useRegionCamera(mapObj, {
    tiltAt: (zoom) => curatedPitch(zoom, false, tiltMode, hasRelief) > 0,
    padding: 48,
    onRelease: () => releaseRef.current(),
  });
  // Set when a region is left by zooming out past it, so the next level comes without a flight.
  const stillRef = useRef(false);
  useCuratedTilt(mapObj, tiltMode, hasRelief);
  const { enter: enterCamera, leave: leaveCamera } = region;
  const { regions: regionList } = useRegions();
  const regionById = useMemo(() => new Map((regionList ?? []).map((r) => [r.id, r])), [regionList]);
  const regionByIdRef = useLatest(regionById);
  // The framed region lives in the URL (?region=, and ?part= for a far part), pushed so Back
  // returns to it.
  const [params, setParams] = useSearchParamsKeepingState();
  const regionId = params.get("region") ?? "";
  const partIndex = params.get("part") ? Number(params.get("part")) : null;
  const regionCode = regionById.get(regionId)?.ebirdRegionCode ?? null;
  const [regionTarget, setRegionTarget] = useState<{ id: string; outline: unknown; code: string | null } | null>(null);
  const framedRef = useRef<string | null>(null);
  // Set when leaving a region shouldn't move the camera (a search result flies elsewhere).
  const keepCameraRef = useRef(false);
  // What the filtered photos fill, for the way back out of a region.
  const homeBounds = useRef<LngLatBounds | null>(null);
  // The filter set the camera last framed.
  const fittedFor = useRef<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showAllRegions, setShowAllRegions] = useState(false);
  const dataRef = useLatest(data);
  const countryCounts = useMemo(
    () => new Map((data?.regions ?? []).filter((r) => r.kind === "country").map((r) => [r.id, r])),
    [data],
  );
  const countryCountsRef = useLatest(countryCounts);
  const openSide = useCallback((next: Side | null) => setAt(atFor(next)), [setAt]);
  const openSideRef = useLatest(openSide);
  const sideOpenRef = useLatest(!!side);
  // The map is built once per theme; a ref keeps it off the translation's identity.
  const tRef = useLatest(t);
  const queryRef = useLatest(queryString);
  // The hover card's pointer handlers, set by the map's own hover logic.
  const cardRef = useRef({ enter: () => {}, leave: () => {}, close: () => {} });
  const speciesName = useSpeciesName();
  const [viewer, setViewer] = useState<{ slides: LightboxSlide[]; index: number } | null>(null);
  // The map fills the window under the toolbar; in a narrow window, where the panel goes under
  // it, most of it.
  const rowRef = useRef<HTMLDivElement>(null);
  const [mapHeight, setMapHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const measure = () => {
      const free = window.innerHeight - Math.max(0, row.getBoundingClientRect().top) - 24;
      setMapHeight(Math.max(288, Math.round(window.innerWidth >= 900 ? free : free * 0.6)));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (row.parentElement?.firstElementChild) observer?.observe(row.parentElement.firstElementChild);
    return () => {
      window.removeEventListener("resize", measure);
      observer?.disconnect();
    };
  }, []);

  // The path down to a region, country first; World and the continents aren't steps.
  function pathTo(id: string): RegionStep[] {
    const steps: RegionStep[] = [];
    for (let r = regionById.get(id); r?.hasScopedChecklist; r = r.parentId ? regionById.get(r.parentId) : undefined)
      steps.unshift({ id: r.id, name: r.name });
    if (steps.length > 0) return steps;
    const name = data?.regions.find((r) => r.id === id)?.name ?? countries?.find((c) => c.id === id)?.name;
    return [{ id, name: name ?? t("gallery.map.thisArea") }];
  }
  const shownTarget = regionTarget?.id === regionId ? regionTarget : null;
  const parts = useMemo(
    () => (shownTarget ? (regionFraming(shownTarget.outline, shownTarget.code)?.parts ?? []) : []),
    [shownTarget],
  );
  const partNames = parts.map(
    (p) => p.name ?? formatCoordinates((p.bounds[1] + p.bounds[3]) / 2, wrapLon((p.bounds[0] + p.bounds[2]) / 2)),
  );
  const basePath = regionId ? pathTo(regionId) : [];
  const regionPath =
    partIndex !== null && partNames[partIndex]
      ? [...basePath, { id: `${regionId}:part`, name: partNames[partIndex] }]
      : basePath;

  /** Frames a region (or one of its far parts) through the URL, with the side panel in the same
   *  history entry. */
  function showRegion(id: string | null, side?: Side | null, part: number | null = null, replace = false) {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (id) next.set("region", id);
        else next.delete("region");
        if (part !== null) next.set("part", String(part));
        else next.delete("part");
        if (side !== undefined) {
          const a = atFor(side);
          if (a) next.set("at", a);
          else next.delete("at");
        }
        return next;
      },
      { replace },
    );
  }

  // Zoomed out past the framing: up one level in place, replacing the history entry so Back
  // doesn't step back into the region just left.
  const releaseRef = useLatest(() => {
    stillRef.current = true;
    if (partIndex !== null) return showRegion(regionId, undefined, null, true);
    const parent = basePath.at(-2);
    if (parent) return showRegion(parent.id, undefined, null, true);
    keepCameraRef.current = true;
    showRegion(null, undefined, null, true);
  });

  /** A click on a country or province. The second click of a double-click is the same region,
   *  so it only keeps the panel. */
  function enterRegion(id: string, side?: Side | null) {
    if (regionId === id && partIndex === null) {
      if (side !== undefined) openSide(side);
      return;
    }
    showRegion(id, side);
  }

  function goUp() {
    if (partIndex !== null) return showRegion(regionId);
    showRegion(basePath.at(-2)?.id ?? null);
  }

  function resetView() {
    if (partIndex !== null) showRegion(regionId);
    else region.reset();
  }

  const regionNavRef = useLatest({
    active: !!regionId,
    path: basePath.map((r) => r.id),
    enter: enterRegion,
    up: goUp,
    framedZoom: region.framedZoom,
  });
  // The photos' own framing zoom: clicks change the region level only near it or a region's.
  const homeZoomRef = useRef<number | null>(null);

  // The framed region's outline: a country's from the shared outlines, a province's fetched.
  useEffect(() => {
    if (!regionId || (regionTarget?.id === regionId && regionTarget.code === regionCode)) return;
    let live = true;
    const country = countries?.find((c) => c.id === regionId)?.boundaryGeoJson;
    const outline = country
      ? Promise.resolve(country as unknown)
      : api
          .get(apiPath("/regions/boundaries", {}, new URLSearchParams({ id: regionId })))
          .then((res) => (res as { regions: Array<{ boundaryGeoJson: unknown }> }).regions[0]?.boundaryGeoJson);
    outline
      .then((o) => live && o && setRegionTarget({ id: regionId, outline: o, code: regionCode }))
      .catch((err) => toast.error(errorMessage(err, t("gallery.map.loadFailed"))));
    return () => {
      live = false;
    };
  }, [regionId, regionCode, regionTarget, countries, toast, t]);

  // After the render that opened the side panel, so the framing fits the map's new size; leaving
  // goes back to the photos' own framing.
  useEffect(() => {
    if (!mapObj) return;
    if (!regionId) {
      if (framedRef.current === null) return;
      framedRef.current = null;
      leaveCamera();
      if (!keepCameraRef.current && homeBounds.current) frameView(mapObj, homeBounds.current, true);
      keepCameraRef.current = false;
      stillRef.current = false;
      return;
    }
    if (!shownTarget) return;
    mapObj.resize();
    enterCamera(shownTarget.outline, shownTarget.code, partIndex, { still: stillRef.current });
    stillRef.current = false;
    framedRef.current = regionId;
  }, [mapObj, regionId, shownTarget, partIndex, enterCamera, leaveCamera]);

  // The framed country's provinces, clickable; fetched once per country.
  const countryId = basePath[0]?.id ?? "";
  useEffect(() => {
    const source = mapObj?.getSource(PROVINCES) as GeoJSONSource | undefined;
    if (!source) return;
    if (!countryId) return void source.setData({ type: "FeatureCollection", features: [] });
    let live = true;
    provincesOf(countryId)
      .then((list) => {
        if (!live) return;
        source.setData({
          type: "FeatureCollection",
          features: list.map((r) => ({
            type: "Feature",
            properties: { id: r.id, name: r.name },
            geometry: r.geometry as never,
          })),
        });
      })
      .catch(ignore("Couldn't load the provinces"));
    return () => {
      live = false;
    };
  }, [mapObj, countryId]);

  const closeSide = () => {
    setPending(null);
    if (placing) onPlacingChange?.(null);
    openSide(null);
  };
  // Esc lifts the pin first, then closes the panel; the Lightbox and dialogs sit above both.
  useEscapeToClose(
    () => (hover ? cardRef.current.close() : pending ? setPending(null) : closeSide()),
    !!hover || !!pending || !!side,
  );

  // Mod+Z on the map walks back the location history.
  const undoRef = useLatest(undo);
  useEffect(() => {
    if (!canPlace) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.isComposing || isTypingTarget(e.target) || !matches(e, "undoLocation")) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      void undoRef.current();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canPlace, undoRef]);

  // One map per theme and basemap state; data is pushed into its sources.
  useEffect(() => {
    if (!containerRef.current || mapAvailable === null) return;
    if (mapAvailable) ensurePmtilesProtocol();
    const map = new MapLibreMap({
      container: containerRef.current,
      ...WORLD_VIEW,
      style: mapStyle(mapAvailable, theme),
      maxZoom: MAP_MAX_ZOOM,
      attributionControl: false,
      // Always north up: the only tilt is the curated one (useCuratedTilt).
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: TILT.pitch,
    });
    addMapCredits(map, { placeSearch: true, satellite: true });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // Terrain shows only while tilted.
    tiltTerrain(map, () => true);
    mapRef.current = map;
    fittedFor.current = null;
    map.on("load", () => {
      addPhotoLayers(map, { dark: theme === "dark", plain: !mapAvailable });
      const KIND: Record<string, PickKind> = {
        [SPOT_MARKERS]: "spot",
        [CLUSTERS]: "cluster",
        [HOLLOW_CLUSTERS]: "cluster",
        [POINTS]: "point",
        [REGION_RINGS]: "ring",
        [PROVINCE_FILL]: "province",
        [COUNTRY_FILL]: "country",
      };
      const marks = [SPOT_MARKERS, CLUSTERS, HOLLOW_CLUSTERS, POINTS, REGION_RINGS];
      const idleCursor = () => (pinningRef.current ? "crosshair" : "");
      // The mark the pointer means: the nearest within reach (projected, so tilt doesn't matter),
      // else the province or country under it.
      const pickAt = (point: { x: number; y: number }, pointerType: string): Feature | null => {
        const slop = pickSlop(pointerType, map.getZoom());
        const r = MAX_MARK_RADIUS + slop;
        const near = map.queryRenderedFeatures(
          [
            [point.x - r, point.y - r],
            [point.x + r, point.y + r],
          ],
          { layers: marks },
        );
        const under = map.queryRenderedFeatures([point.x, point.y], { layers: [PROVINCE_FILL, COUNTRY_FILL] });
        const candidates = [...near, ...under].map((f): PickCandidate<Feature> => {
          const kind = KIND[f.layer.id];
          if (kind === "province" || kind === "country") return { kind, x: point.x, y: point.y, radius: 0, data: f };
          const at = projectNear(map, (f.geometry as PointGeometry).coordinates, point);
          return { kind, x: at.x, y: at.y, radius: markRadius(kind, f.properties ?? {}), data: f };
        });
        return pickNearest(candidates, point.x, point.y, slop)?.data ?? null;
      };
      const half = () => (dataRef.current?.gridDegrees ?? 0) / 2;
      const photos = (n: number) => tRef.current("gallery.map.photoCount", { count: n, formatted: formatNumber(n) });
      // The preview for whatever the pointer means; local data only, so sweeping costs nothing.
      let hoverTimer: ReturnType<typeof setTimeout> | undefined;
      // The card for whatever the pointer means, beside the mark (projected, so tilt doesn't
      // matter); local data, plus one cached request for a mark's best photos when it opens.
      const preview = async (hit: Feature, pointer: { x: number; y: number }) => {
        const props = hit.properties ?? {};
        const kind = KIND[hit.layer.id];
        const box = containerRef.current?.getBoundingClientRect();
        const mark =
          kind === "province" || kind === "country"
            ? { ...pointer, r: 10 }
            : {
                ...projectNear(map, (hit.geometry as PointGeometry).coordinates, pointer),
                r: markRadius(kind, props) + 4,
              };
        const at = {
          x: (box?.left ?? 0) + mark.x,
          y: (box?.top ?? 0) + mark.y,
          r: mark.r,
          ...mapRoom(containerRef.current),
        };
        const t = tRef.current;
        const query = (set: Record<string, string>) => {
          const q = new URLSearchParams(queryRef.current);
          for (const [k, v] of Object.entries(set)) q.set(k, v);
          return q;
        };
        const photosOf = (selection: Selection): Side => ({ kind: "photos", selection });
        const h = half();
        // Saved spots folded under this photo mark: the card is titled with their names.
        const markTitle = () => {
          const names = spotsRef.current
            .filter((spot) => spotUnderMark(projectNear(map, [spot.lon, spot.lat], mark), { ...mark, radius: mark.r }))
            .map((spot) => spot.name);
          if (names.length === 0) return t("gallery.map.thisArea");
          if (names.length <= 2) return formatList(names);
          return t("gallery.map.card.spotsMore", { names: formatList(names.slice(0, 2)), count: names.length - 2 });
        };
        if (hit.layer.id === SPOT_MARKERS) {
          const spot = spotsRef.current.find((s) => s.id === props.id);
          if (spot)
            setHover({
              ...at,
              title: spot.name,
              line: photos(Number(props.count) || 0),
              photoIds: [],
              query: query({ spotId: spot.id }),
              side: photosOf({ kind: "spot", id: spot.id }),
            });
        } else if (hit.layer.id === REGION_RINGS) {
          const n = Number(props.count);
          setHover({
            ...at,
            title: String(props.name),
            line: t("gallery.map.card.ringLine", { count: n, formatted: formatNumber(n), region: String(props.name) }),
            photoIds: [],
            query: query({ regionId: String(props.id), missingCoordinates: "1" }),
            side: photosOf({ kind: "region", id: props.id, regionOnly: true }),
          });
        } else if (hit.layer.id === POINTS) {
          const [lon, lat] = (hit.geometry as PointGeometry).coordinates;
          const bbox = bboxText(lon - h, lat - h, lon + h, lat + h);
          setHover({
            ...at,
            title: markTitle(),
            line: photos(props.count),
            photoIds: [props.photoId],
            query: query({ bbox }),
            side: photosOf({ kind: "area", bbox, single: true }),
          });
        } else if (hit.layer.id === CLUSTERS || hit.layer.id === HOLLOW_CLUSTERS) {
          // The cluster's own points are local; only its best photos are asked for.
          const leaves = await (map.getSource(PHOTOS) as GeoJSONSource).getClusterLeaves(props.cluster_id, Infinity, 0);
          const b = new LngLatBounds();
          for (const leaf of leaves) b.extend((leaf.geometry as PointGeometry).coordinates);
          const bbox = bboxText(b.getWest() - h, b.getSouth() - h, b.getEast() + h, b.getNorth() + h);
          const ringIds = leaves.map((l) => l.properties as { ring?: boolean; id?: string }).filter((p) => p.ring);
          const top = leaves
            .map((l) => l.properties as { count: number; photoId?: string })
            .filter((p) => p.photoId)
            .sort((a, b) => b.count - a.count)
            .slice(0, 6)
            .map((p) => p.photoId!);
          setHover({
            ...at,
            title: markTitle(),
            line:
              props.regionOnly > 0
                ? t("gallery.map.card.breakdown", {
                    placed: formatNumber(props.placed),
                    regionOnly: formatNumber(props.regionOnly),
                  })
                : photos(props.total),
            photoIds: top,
            query: (() => {
              const q = query({ bbox });
              for (const r of ringIds) q.append("orRegionOnly", String(r.id));
              return q;
            })(),
            side: photosOf({ kind: "area", bbox, single: false }),
          });
        } else {
          // A country or province: its name and the photos already counted for it.
          const region = dataRef.current?.regions.find((r) => r.id === props.id);
          const name = region?.name ?? (props.name as string | undefined);
          if (name)
            setHover({ ...at, title: name, line: photos(region?.count ?? 0), photoIds: [], query: null, side: null });
        }
      };
      // The hovered area's tint, through feature-state so nothing is re-parsed.
      let tinted: { source: string; id: string } | null = null;
      const tint = (hit: Feature | null) => {
        const area =
          hit?.layer.id === PROVINCE_FILL
            ? { source: PROVINCES, id: String(hit.properties?.id) }
            : hit?.layer.id === COUNTRY_FILL && !regionNavRef.current.path.includes(hit.properties?.id)
              ? { source: COUNTRIES, id: String(hit.properties?.id) }
              : null;
        if (tinted && (tinted.source !== area?.source || tinted.id !== area?.id))
          map.setFeatureState(tinted, { hover: false });
        if (area) map.setFeatureState(area, { hover: true });
        tinted = area;
      };
      const haloAt = (hit: Feature | null) => {
        const kind = hit ? KIND[hit.layer.id] : null;
        const point = kind && kind !== "province" && kind !== "country";
        (map.getSource(HALO) as GeoJSONSource | undefined)?.setData({
          type: "FeatureCollection",
          features: point
            ? [
                {
                  type: "Feature",
                  properties: { r: markRadius(kind, hit!.properties ?? {}) + 4 },
                  geometry: hit!.geometry as never,
                },
              ]
            : [],
        });
      };
      let shownKey = "";
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      let overCard = false;
      const hide = () => {
        clearTimeout(hoverTimer);
        clearTimeout(closeTimer);
        shownKey = "";
        overCard = false;
        setHover(null);
        haloAt(null);
        tint(null);
      };
      // Leaving a mark keeps its card a moment, so the pointer can move into it.
      const closeSoon = () => {
        clearTimeout(closeTimer);
        closeTimer = setTimeout(() => !overCard && hide(), CARD_GRACE_MS);
      };
      cardRef.current = {
        enter: () => {
          overCard = true;
          clearTimeout(closeTimer);
        },
        leave: () => {
          overCard = false;
          closeSoon();
        },
        close: hide,
      };
      const hoverAt = (point: { x: number; y: number }, pointerType: string, delay: number) => {
        const hit = pickAt(point, pointerType);
        const pin = pinningRef.current;
        // While placing, only a spot takes a click; anywhere else drops the pin.
        const target = pin && hit?.layer.id !== SPOT_MARKERS ? null : hit;
        map.getCanvas().style.cursor = target ? "pointer" : idleCursor();
        haloAt(target);
        tint(pin ? null : target);
        const key = target
          ? `${target.layer.id}:${target.properties?.id ?? target.properties?.cluster_id ?? JSON.stringify((target.geometry as PointGeometry).coordinates)}`
          : "";
        if (key === shownKey) return clearTimeout(closeTimer);
        shownKey = key;
        clearTimeout(hoverTimer);
        if (!target) return closeSoon();
        hoverTimer = setTimeout(() => {
          clearTimeout(closeTimer);
          void preview(target, point).catch(() => setHover(null));
        }, delay);
      };
      // A drag, pan, pinch, scroll-zoom or double-click is never a click (MapLibre still sends one
      // after a small drag): the pointer must stay put, the camera still, and no gesture just ended.
      let down: { x: number; y: number; touch: boolean } | null = null;
      let gestureEnded = 0;
      const canvas = map.getCanvas();
      canvas.addEventListener?.("pointerdown", (ev: PointerEvent) => {
        const box = canvas.getBoundingClientRect();
        down = { x: ev.clientX - box.left, y: ev.clientY - box.top, touch: ev.pointerType !== "mouse" };
      });
      map.on("moveend", (e) => {
        if ((e as { originalEvent?: Event }).originalEvent) gestureEnded = performance.now();
      });
      const isClick = (point: { x: number; y: number }) =>
        !map.isMoving() &&
        performance.now() - gestureEnded > GESTURE_GRACE_MS &&
        (!down || Math.hypot(point.x - down.x, point.y - down.y) <= (down.touch ? 10 : 4));
      // Only near a framing (a region's, or the photos' own) does a click change the region level;
      // zoomed in past it, a click on land is probably the end of a look around.
      const nearFraming = () => {
        const framed = regionNavRef.current.framedZoom();
        const zoom = map.getZoom();
        return zoom <= (framed ?? Math.max(homeZoomRef.current ?? 2, 2)) + NEAR_FRAMING_ZOOM;
      };
      map.on("mousemove", (e) => {
        // No halo or preview while a button is held (a drag) or the camera moves.
        if (map.isMoving() || ((e.originalEvent as MouseEvent | undefined)?.buttons ?? 0) > 0) return hide();
        hoverAt(e.point, pointerTypeOf(e.originalEvent), HOVER_DELAY_MS);
      });
      // Touch: a long press previews, lifting the finger hides it.
      map.on("touchstart", (e) => hoverAt(e.point, "touch", LONG_PRESS_MS));
      map.on("touchmove", hide);
      // Lifting the finger keeps a long-press card, so its photos can be tapped.
      map.on("touchend", () => clearTimeout(hoverTimer));
      map.on("movestart", hide);
      map.on("dragstart", hide);
      map.getCanvas().addEventListener?.("mouseleave", () => {
        clearTimeout(hoverTimer);
        shownKey = "";
        closeSoon();
      });
      map.on("click", (e) => {
        hide();
        if (!isClick(e.point)) return;
        const hit = pickAt(e.point, pointerTypeOf(e.originalEvent));
        const props = hit?.properties ?? {};
        const spot = hit?.layer.id === SPOT_MARKERS ? spotsRef.current.find((s) => s.id === props.id) : undefined;
        // With the tray open, a spot puts the pin on it and anywhere else drops the pin there.
        if (pinningRef.current) {
          const at = e.lngLat.wrap();
          pickRef.current(spot ? { lat: spot.lat, lon: spot.lon, spot } : { lat: at.lat, lon: at.lng, spot: null });
          return;
        }
        const nav = regionNavRef.current;
        const area = !hit || hit.layer.id === PROVINCE_FILL || hit.layer.id === COUNTRY_FILL;
        const levels = nearFraming();
        // In a region, the dimmed world around it goes up a level.
        if (
          area &&
          levels &&
          nav.active &&
          map.getLayer(REGION_MASK_LAYER) &&
          map.queryRenderedFeatures(e.point, { layers: [REGION_MASK_LAYER] }).length > 0
        ) {
          nav.up();
          return;
        }
        // A mark opens its photos and the map moves onto it in one eased move, never into a region.
        // The panel narrows the map, but MapLibre keeps the centre on a resize, so the mark stays
        // centred in what's left without a second move.
        const photosOf = (selection: Selection): Side => ({ kind: "photos", selection });
        const hasPhotos = (id: string) => (dataRef.current?.regions.find((r) => r.id === id)?.count ?? 0) > 0;
        // A resize in the middle of a move throws its end off, so when the panel is about to open
        // beside the map the move waits for that resize (about a frame). The resize keeps the map's
        // centre, which would shift everything left; the map is put back so every point stays where
        // it was on screen (no visible change), and the move starts from there.
        const focus = (coords: [number, number], expansionZoom?: number) => {
          const go = () => {
            // Flat geometry: the curated 3D angle, when the landing zoom gets it, eases in after,
            // tilting about the centre, so the mark stays centred.
            zoomOnto(map, coords, markMove({ zoom: map.getZoom(), expansionZoom, reducedMotion: reducedMotion() }));
          };
          if (sideOpenRef.current || window.innerWidth < 900) return go();
          const before = map.getContainer().clientWidth;
          let started = false;
          const start = () => {
            if (started) return;
            started = true;
            map.off("resize", start);
            clearTimeout(fallback);
            const box = map.getContainer();
            const narrower = before - box.clientWidth;
            if (narrower > 0)
              map.jumpTo({ center: map.unproject([box.clientWidth / 2 - narrower / 2, box.clientHeight / 2]) });
            go();
          };
          map.once("resize", start);
          const fallback = setTimeout(start, PANEL_RESIZE_WAIT_MS);
        };
        if (spot) {
          openSideRef.current(photosOf({ kind: "spot", id: spot.id }));
          focus([spot.lon, spot.lat]);
        } else if (hit?.layer.id === CLUSTERS || hit?.layer.id === HOLLOW_CLUSTERS) {
          const source = map.getSource(PHOTOS) as GeoJSONSource;
          void source
            .getClusterExpansionZoom(props.cluster_id)
            .then((zoom) => focus((hit.geometry as PointGeometry).coordinates, zoom))
            .catch(() => focus((hit.geometry as PointGeometry).coordinates));
          void source.getClusterLeaves(props.cluster_id, Infinity, 0).then((leaves) => {
            const b = new LngLatBounds();
            for (const leaf of leaves) b.extend((leaf.geometry as PointGeometry).coordinates);
            const h = half();
            openSideRef.current(
              photosOf({
                kind: "area",
                bbox: bboxText(b.getWest() - h, b.getSouth() - h, b.getEast() + h, b.getNorth() + h),
                single: false,
              }),
            );
          });
        } else if (hit?.layer.id === POINTS) {
          const [lon, lat] = (hit.geometry as PointGeometry).coordinates;
          const h = half();
          openSideRef.current(
            photosOf({ kind: "area", bbox: bboxText(lon - h, lat - h, lon + h, lat + h), single: true }),
          );
          focus([lon, lat]);
        } else if (hit?.layer.id === REGION_RINGS) {
          openSideRef.current(photosOf({ kind: "region", id: props.id, regionOnly: true }));
          focus((hit.geometry as PointGeometry).coordinates);
        } else if (!levels) {
          // Zoomed in: land does nothing; the breadcrumb, Reset view and Back change the level.
        } else if (hit?.layer.id === COUNTRY_FILL && nav.path.includes(props.id))
          // Inside the framed region (a province's country is under it too): that region's photos.
          openSideRef.current(photosOf({ kind: "region", id: nav.path.at(-1)!, regionOnly: false }));
        else if (hit && area) {
          // A country or province: framed, with its photos beside the map when it has any.
          const id = String(props.id);
          nav.enter(id, hasPhotos(id) ? photosOf({ kind: "region", id, regionOnly: false }) : undefined);
        }
      });
      setLoaded(true);
      setMapObj(map);
    });
    return () => {
      map.remove();
      mapRef.current = null;
      setLoaded(false);
      setMapObj(null);
    };
  }, [
    mapAvailable,
    theme,
    dataRef,
    countryCountsRef,
    pinningRef,
    pickRef,
    spotsRef,
    openSideRef,
    tRef,
    regionNavRef,
    queryRef,
    sideOpenRef,
  ]);

  // Photos inside each place by point, from the API: drawn as the place's own mark.
  const placeCounts = useMemo(() => new Map((data?.places ?? []).map((p) => [p.spotId, p.count])), [data]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    (map.getSource(SPOTS) as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: spots.map((s) => ({
        type: "Feature",
        // Pixels at zoom 0 for the radius; the layer doubles it per zoom level.
        properties: {
          id: s.id,
          r0: s.radiusM / (78271.517 * Math.cos((s.lat * Math.PI) / 180)),
          name: s.name,
          count: placeCounts.get(s.id) ?? 0,
          countLabel: formatNumber(placeCounts.get(s.id) ?? 0),
        },
        geometry: { type: "Point", coordinates: [s.lon, s.lat] },
      })),
    });
  }, [spots, loaded, placeCounts]);

  useEffect(() => {
    const map = mapRef.current;
    if (map && loaded) map.getCanvas().style.cursor = pinning ? "crosshair" : "";
  }, [pinning, loaded]);

  // The pin; dragging it moves the point off any spot it was on.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !pending) return;
    const marker = new Marker({ draggable: true, color: token("--color-accent") })
      .setLngLat([pending.lon, pending.lat])
      .addTo(map);
    marker.on("dragend", () => {
      const at = marker.getLngLat().wrap();
      pickRef.current({ lat: at.lat, lon: at.lng, spot: null });
    });
    return () => void marker.remove();
  }, [pending, loaded, pickRef]);

  // Which regions with region-only photos the pin is outside, for the tray's note.
  const ringRegionIds = useMemo(
    () => (data?.regions ?? []).filter((r) => r.regionOnlyCount > 0).map((r) => r.id),
    [data],
  );
  useEffect(() => {
    if (!pending || pending.spot || ringRegionIds.length === 0) return;
    const controller = new AbortController();
    const q = new URLSearchParams({ lat: String(pending.lat), lon: String(pending.lon) });
    for (const id of ringRegionIds.slice(0, 500)) q.append("within", id);
    api
      .get(apiPath("/regions/at", {}, q), { signal: controller.signal })
      .then((res) => setOutside(new Set(res.outside ?? [])))
      .catch(ignore("Couldn't check the pin's region"));
    return () => controller.abort();
  }, [pending, ringRegionIds]);

  // Country outlines, shaded through feature-state so a new filter doesn't re-parse them.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !countries) return;
    (map.getSource(COUNTRIES) as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: countries.map((c) => ({
        type: "Feature",
        properties: { id: c.id, name: c.name },
        geometry: c.boundaryGeoJson.geometry as never,
      })),
    });
  }, [countries, loaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !countries) return;
    for (const c of countries)
      map.setFeatureState({ source: COUNTRIES, id: c.id }, { count: countryCounts.get(c.id)?.count ?? 0 });
  }, [countries, countryCounts, loaded]);

  // The filtered photos: rings for region-only photos and grid cells, then a camera that frames them.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !data) return;
    // Only photos without coordinates are in a ring: a placed photo is its dot, never both.
    const rings = data.regions.filter((r) => r.regionOnlyCount > 0 && r.lat !== null);
    (map.getSource(PHOTOS) as GeoJSONSource).setData({
      type: "FeatureCollection",
      features: photoFeatures(data.cells, data.regions),
    });
    // Every photo's point, but never tighter than the whole of each country they're in.
    if (!countries && countryCounts.size > 0) return; // the countries' outlines are on their way
    const framings = (countries ?? [])
      .filter((c) => (countryCounts.get(c.id)?.count ?? 0) > 0)
      .map((c) => regionFraming(c.boundaryGeoJson, regionByIdRef.current.get(c.id)?.ebirdRegionCode ?? null)?.bounds)
      .filter((f): f is [number, number, number, number] => !!f);
    const points: Array<[number, number]> = [
      ...data.cells.map((c): [number, number] => [c.lon, c.lat]),
      ...rings.map((r): [number, number] => [r.lon!, r.lat!]),
    ];
    const box = openingBounds(points, framings);
    const bounds = box ? new LngLatBounds([box[0], box[1]], [box[2], box[3]]) : new LngLatBounds();
    homeBounds.current = bounds;
    // Framed once per filter set, so placing photos doesn't throw the view back out; a framed
    // region keeps its view.
    if (fittedFor.current === queryString) return;
    fittedFor.current = queryString;
    if (regionNavRef.current.active) return;
    frameView(map, bounds);
    homeZoomRef.current = map.getZoom();
  }, [data, loaded, countries, countryCounts, queryString, regionNavRef, regionByIdRef]);

  function onPickPlace(place: FoundPlace) {
    const map = mapRef.current;
    if (place.kind === "region" && !pinning) return enterRegion(place.id);
    // A spot or a pin may lie outside the framed region, whose limits would stop the flight.
    if (regionId) {
      keepCameraRef.current = true;
      leaveCamera();
      showRegion(null);
    }
    if (map) flyToPlace(map, place);
    if (!pinning) return;
    const spot = place.kind === "spot" ? spots.find((s) => s.id === place.id) : undefined;
    const found = place.kind === "online" ? { name: place.name, locality: place.region } : undefined;
    pickRef.current(
      spot ? { lat: spot.lat, lon: spot.lon, spot } : { lat: place.lat, lon: place.lon, spot: null, found },
    );
  }

  const mapCentre = () => {
    const c = mapRef.current?.getCenter();
    return c ? { lat: c.lat, lon: c.lng } : null;
  };

  /** Sets (or with null clears) the point of these photos: a spot files them under it. */
  async function setPoint(ids: string[], at: Pending | null): Promise<boolean> {
    if (ids.length === 0) return false;
    setPlaceError(null);
    if (at?.spot)
      return job.start(apiPath("/saved-spots/{id}/apply", { id: at.spot.id }), {
        captureIds: ids,
        // "Replace all" is the user's say-so to move camera GPS too; otherwise a photo keeps its own point.
        ...(replaceAll && { moveOwnPoints: true }),
      });
    const body = { captureIds: ids, lat: at?.lat ?? null, lon: at?.lon ?? null };
    // The API runs these in the background; the job's own toast says when they're done.
    if (ids.length > SYNC_PLACE_MAX) return job.start("/captures/coordinates", body);
    setSaving(true);
    try {
      const res = await api.post("/captures/coordinates", body);
      refresh();
      const n = { count: res.updated, formatted: formatNumber(res.updated) };
      toast.show(at ? t("gallery.map.placed", n) : t("gallery.map.removed", n), {
        tone: "success",
        actions: [{ label: t("gallery.map.undo"), onClick: () => void undo() }],
      });
      return true;
    } catch (err) {
      setPlaceError(errorMessage(err, t("coordinates.saveFailed")));
      return false;
    } finally {
      setSaving(false);
    }
  }

  // No pin yet: the first Place drops one in the middle of the map to drag where they belong.
  async function placeSource(source: PlaceSource, at: Pending | null = pending) {
    if (!at) {
      const c = mapRef.current?.getCenter();
      if (c) pickRef.current({ lat: c.lat, lon: c.lng, spot: null });
      return;
    }
    try {
      await setPoint(await source.ids(), at);
    } catch (err) {
      setPlaceError(errorMessage(err, t("gallery.map.loadFailed")));
    }
  }

  // A group dropped on the map is placed where it lands, on the spot under it if any.
  function onDrop(e: React.DragEvent) {
    const map = mapRef.current;
    const source = dragSource.current;
    dragSource.current = null;
    if (!map || !source || !containerRef.current) return;
    e.preventDefault();
    const box = containerRef.current.getBoundingClientRect();
    const point = { x: e.clientX - box.left, y: e.clientY - box.top };
    const hit = map.queryRenderedFeatures(point as never, { layers: [SPOT_MARKERS] })[0];
    const spot = hit ? spots.find((s) => s.id === hit.properties?.id) : undefined;
    const at = map.unproject([point.x, point.y]).wrap();
    void placeSource(source, spot ? { lat: spot.lat, lon: spot.lon, spot } : { lat: at.lat, lon: at.lng, spot: null });
  }

  function spotSaved(spot: SavedSpot, point: { lat: number; lon: number } | null) {
    // The pin follows the new place (it may have been moved while naming it), or goes down on it.
    if (point ? pending && pending.lat === point.lat && pending.lon === point.lon : pinning)
      setPending({ lat: spot.lat, lon: spot.lon, spot });
    setNamingSpot(null);
    void spotsResource.reload();
  }

  if (error && !data)
    return (
      <div className="flex items-center gap-3">
        <FormMessage error={t("gallery.map.loadFailed")} className="flex-1" />
        <Button variant="secondary" size="sm" onClick={() => void reload()}>
          {t("common.retry")}
        </Button>
      </div>
    );

  const unplaced = data?.withoutCoordinates ?? 0;
  const regionOnly = data?.regionOnly ?? 0;
  const countryList = (data?.regions ?? []).filter((r) => r.kind === "country");
  const listed = showAllRegions ? countryList : countryList.slice(0, LIST_PREVIEW);
  const busy = saving || job.starting || !!job.status?.running;
  const targets = placing
    ? replaceAll
      ? placing.captureIds
      : placing.captureIds.filter((id) => !placing.located.has(id))
    : [];
  const keptCount = placing ? placing.located.size : 0;
  const pinNote = (s: { count: number; regionId: string | null; regionName: string | null }) => {
    if (!pending || !s.regionId || !s.regionName) return null;
    const n = { count: s.count, formatted: formatNumber(s.count) };
    if (pending.spot)
      return pending.spot.regionId && pending.spot.regionName && pending.spot.regionId !== s.regionId
        ? t("gallery.map.tray.movesRegion", { ...n, from: s.regionName, to: pending.spot.regionName })
        : null;
    return outside.has(s.regionId) ? t("gallery.map.tray.outside", { region: s.regionName }) : null;
  };

  // The photos side panel: the Gallery's filters plus the selection's own.
  const selection = side?.kind === "photos" ? side.selection : null;
  const selectionRegion = selection?.kind === "region" ? data?.regions.find((r) => r.id === selection.id) : undefined;
  const selectionSpot = selection?.kind === "spot" ? spots.find((s) => s.id === selection.id) : undefined;
  // A cluster's rings: the photos in it that have only a region, listed with its placed photos.
  const ringsHere = (() => {
    if (selection?.kind !== "area") return [];
    const [w, s, e, n] = selection.bbox.split(",").map(Number);
    return (data?.regions ?? []).filter(
      (r) =>
        r.regionOnlyCount > 0 &&
        r.lat !== null &&
        r.lon !== null &&
        r.lat >= s &&
        r.lat <= n &&
        r.lon >= w &&
        r.lon <= e,
    );
  })();
  const ringsOnly = ringsHere.reduce((sum, r) => sum + r.regionOnlyCount, 0);
  const panelParams = (() => {
    if (!selection) return null;
    const p = new URLSearchParams(queryString);
    if (selection.kind === "area") {
      p.set("bbox", selection.bbox);
      for (const r of ringsHere) p.append("orRegionOnly", r.id);
    } else if (selection.kind === "spot") {
      if (!selectionSpot) return null;
      p.set("spotId", selectionSpot.id);
    } else {
      // A country holds the filtered regions already; a province ring narrows to itself.
      if (!(selectionRegion?.kind === "country" && p.has("regionId"))) {
        p.delete("regionId");
        p.set("regionId", selection.id);
      }
      if (selection.regionOnly) p.set("missingCoordinates", "1");
    }
    return p;
  })();
  const panelTitle =
    selection?.kind === "region"
      ? (selectionRegion?.name ?? t("gallery.map.thisArea"))
      : selection?.kind === "spot"
        ? (selectionSpot?.name ?? t("gallery.map.thisArea"))
        : t("gallery.map.thisArea");
  async function idsOf(p: URLSearchParams) {
    return api.get(apiPath("/gallery/ids", {}, p));
  }
  function placeRing(regionId: string) {
    const p = new URLSearchParams(queryString);
    p.delete("regionId");
    p.set("regionId", regionId);
    p.set("missingCoordinates", "1");
    void idsOf(p)
      .then((res) => onPlacingChange?.({ captureIds: res.captureIds, located: new Set(res.locatedCaptureIds) }))
      .catch((err) => toast.error(errorMessage(err, t("gallery.map.loadFailed"))));
  }
  const panelActions = (() => {
    if (!panelParams || !canPlace) return [];
    const actions: MenuAction[] = [
      {
        label: t("gallery.map.panel.move"),
        onSelect: () =>
          void idsOf(panelParams)
            .then((res) => onPlacingChange?.({ captureIds: res.captureIds, located: new Set(res.locatedCaptureIds) }))
            .catch((err) => toast.error(errorMessage(err, t("gallery.map.loadFailed")))),
      },
    ];
    if (selection?.kind === "area" && selection.single) {
      const [w, s, e, n] = selection.bbox.split(",").map(Number);
      actions.push({
        label: t("gallery.map.placing.saveSpot"),
        onSelect: () => nameAt({ lat: round((s + n) / 2), lon: round((w + e) / 2), spot: null }),
      });
    }
    for (const r of ringsHere)
      actions.push({ label: t("gallery.map.panel.placeRing", { region: r.name }), onSelect: () => placeRing(r.id) });
    if (!(selection?.kind === "region" && selection.regionOnly))
      actions.push({
        label: t("gallery.map.panel.removeLocation"),
        onSelect: () =>
          void idsOf(panelParams)
            .then((res) => setPoint(res.locatedCaptureIds, null))
            .catch((err) => toast.error(errorMessage(err, t("gallery.map.loadFailed")))),
      });
    return actions;
  })();
  const openSelectionInGallery = () => {
    if (!selection) return;
    setAt("");
    if (selection.kind === "region") onOpenRegion(selection.id);
    else if (selection.kind === "area") onOpenArea(selection.bbox);
    else if (selectionSpot) onOpenPlace?.(selectionSpot.name);
  };

  return (
    <div className="space-y-3">
      {mapAvailable === false && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-callout text-muted">
          <p className="min-w-0 flex-1">{t("gallery.map.noBasemap")}</p>
          <Button variant="secondary" size="sm" onClick={() => navigate(SPECIES_DOWNLOADS_PATH)}>
            {t("gallery.map.downloadBasemap")}
          </Button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="relative z-10 w-full max-w-md">
          <PlacePicker placeholder={t("gallery.map.searchPlaces")} onPick={onPickPlace} bias={mapCentre} overlay />
        </div>
        {/* Its own line in a narrow window, so the status line keeps its width. */}
        {regionPath.length > 0 && (
          <div
            // design-token: the plan's 900 px breakpoint, as for the side column
            className="w-full min-w-0 min-[900px]:w-auto"
          >
            <RegionViewBar
              path={regionPath}
              onPick={(id) => showRegion(id)}
              onReset={resetView}
              parts={partIndex === null ? partNames : []}
              partsOf={basePath.at(-1)?.name}
              onPart={(i) => showRegion(regionId, undefined, i)}
            />
          </div>
        )}
        {data && data.total > 0 && (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-2 text-footnote text-muted">
            <p className="min-w-0" data-testid="photo-map-status">
              {placedStatus(t, data.total, unplaced)}
              {data.truncated && ` ${t("gallery.map.grouped")}`}
            </p>
            {unplaced > 0 && canPlace && (
              <Button
                variant="secondary"
                size="sm"
                aria-pressed={side?.kind === "tray"}
                onClick={() => (side?.kind === "tray" ? closeSide() : openSide({ kind: "tray" }))}
              >
                {t("gallery.map.needPlacing", { count: unplaced, formatted: formatNumber(unplaced) })}
              </Button>
            )}
            {unplaced > 0 && onShowUnlocated && (
              <Button
                variant="link"
                size="sm"
                onClick={() => {
                  setAt("");
                  onShowUnlocated();
                }}
              >
                {t("gallery.map.showUnlocated")}
              </Button>
            )}
          </div>
        )}
      </div>
      <JobProgress
        status={job.status}
        fallbackLabel={t("gallery.map.placingProgress")}
        phases={{ photos: t("gallery.map.placingProgress"), files: t("gallery.map.placingFiles") }}
        onCancel={() => void job.cancel("/captures/location/cancel")}
        cancelling={job.cancelling}
        error={job.actionError}
        showCancelled={false}
      />
      {/* design-token: the plan's 900 px breakpoint, where the side column moves under the map */}
      <div
        ref={rowRef}
        // design-token: the plan's 900 px breakpoint, where the side column moves under the map
        className="flex flex-col gap-3 min-[900px]:flex-row"
        style={{ "--map-h": mapHeight ? `${mapHeight}px` : undefined } as React.CSSProperties}
      >
        <div className="relative min-w-0 flex-1">
          <div
            ref={containerRef}
            role="region"
            aria-label={pinning ? t("coordinates.mapLabel") : t("gallery.map.label")}
            data-testid="photo-map"
            data-region-count={data?.regions.length ?? ""}
            data-point-count={data?.cells.length ?? ""}
            data-photo-total={data?.total ?? ""}
            data-spot-count={spots.length}
            onDragOver={(e) => {
              if (!dragSource.current) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDrop={onDrop}
            className="h-[var(--map-h,36rem)] min-h-72 w-full overflow-hidden rounded-panel border border-line bg-surface-muted"
          />
          {/* 3D only once zoomed in, at one angle; Flat never tilts. Needs the relief download. */}
          {hasRelief && (
            <div className="absolute left-3 top-3 rounded-control border border-line bg-surface p-0.5">
              <SegmentedControl
                label={t("gallery.map.tilt.label")}
                value={tiltMode}
                onChange={setTiltMode}
                options={[
                  { value: "auto", label: t("gallery.map.tilt.auto") },
                  { value: "flat", label: t("gallery.map.tilt.flat") },
                ]}
              />
            </div>
          )}
          {region.overshoot > 0 && regionPath.length > 0 && (
            <p
              role="status"
              style={{ opacity: 0.4 + region.overshoot * 0.6 }}
              className="pointer-events-none absolute bottom-3 left-1/2 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-control border border-line bg-surface px-3 py-1.5 text-footnote text-ink shadow-lg"
            >
              {t("mapRegion.keepZooming", { region: regionPath.at(-1)!.name })}
            </p>
          )}
          {!data && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner />
            </div>
          )}
        </div>
        {side?.kind === "tray" && canPlace && (
          <MapSidePanel
            title={
              placing
                ? t("gallery.map.placing.title", {
                    count: placing.captureIds.length,
                    formatted: formatNumber(placing.captureIds.length),
                  })
                : t("gallery.map.tray.title")
            }
            width={sideWidth}
            onWidthChange={setSideWidth}
            onClose={closeSide}
          >
            <div className="space-y-3">
              <div className="space-y-2 border-b border-line pb-3" data-testid="photo-map-placing">
                <PlacePicker
                  placeholder={t("placePicker.placeholder")}
                  near={pending}
                  bias={mapCentre}
                  onPick={onPickPlace}
                  // With no pin yet, the new place's point is picked in its dialog.
                  onNewPlace={(name) => nameAt(pending, name)}
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className="min-w-0 flex-1 break-words text-callout text-ink tabular-nums">
                    {pending
                      ? (pending.spot?.name ?? formatCoordinates(pending.lat, pending.lon))
                      : t("gallery.map.pin.prompt")}
                  </p>
                  {pending && !pending.spot && (
                    <Button variant="secondary" size="sm" onClick={() => nameAt(pending)}>
                      {t("gallery.map.placing.saveSpot")}
                    </Button>
                  )}
                  {pending && (
                    <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
                      {t("gallery.map.pin.lift")}
                    </Button>
                  )}
                </div>
                <FormMessage error={placeError} />
              </div>
              {placing ? (
                <div className="space-y-2">
                  {keptCount > 0 && (
                    <>
                      <p className="text-footnote text-muted">
                        {keptCount === placing.captureIds.length
                          ? t("gallery.map.placing.allLocated", { count: keptCount })
                          : t("gallery.map.placing.someLocated", {
                              count: keptCount,
                              formatted: formatNumber(keptCount),
                            })}
                      </p>
                      <SegmentedControl
                        label={t("gallery.map.placing.modeLabel")}
                        value={replaceAll ? "all" : "missing"}
                        onChange={(v) => setReplaceAll(v === "all")}
                        options={[
                          { value: "missing", label: t("gallery.map.placing.onlyMissing") },
                          { value: "all", label: t("gallery.map.placing.replaceAll") },
                        ]}
                      />
                    </>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      loading={busy}
                      disabled={targets.length === 0}
                      onClick={() =>
                        void (pending
                          ? setPoint(targets, pending).then((ok) => ok && onPlacingChange?.(null))
                          : placeSource({
                              key: "",
                              count: targets.length,
                              regionId: null,
                              regionName: null,
                              ids: async () => targets,
                            }))
                      }
                    >
                      {pending
                        ? t("gallery.map.placing.place", {
                            count: targets.length,
                            formatted: formatNumber(targets.length),
                          })
                        : t("gallery.map.tray.place")}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => onPlacingChange?.(null)}>
                      {t("common.cancel")}
                    </Button>
                  </div>
                </div>
              ) : (
                <NeedsPlacingTray
                  queryString={queryString}
                  counts={{ all: unplaced, region: regionOnly, none: unplaced - regionOnly }}
                  pinDown={!!pending}
                  notes={pinNote}
                  refreshKey={trayKey}
                  busy={busy}
                  onPlace={(source) => void placeSource(source)}
                  onDragSource={(source) => (dragSource.current = source)}
                />
              )}
              <PlaceSuggestions reloadKey={spotsResource.data} onAdded={() => void spotsResource.reload()} />
            </div>
          </MapSidePanel>
        )}
        {selection && panelParams && (
          <MapSidePanel
            title={panelTitle}
            detail={
              selection.kind === "region" && selection.regionOnly
                ? t("gallery.map.panel.regionOnly")
                : ringsOnly > 0
                  ? t("gallery.map.card.noExactLocation", { count: ringsOnly, formatted: formatNumber(ringsOnly) })
                  : undefined
            }
            width={sideWidth}
            onWidthChange={setSideWidth}
            onClose={closeSide}
          >
            <MapPhotoPanel params={panelParams} actions={panelActions} onOpenInGallery={openSelectionInGallery} />
          </MapSidePanel>
        )}
      </div>
      {hover && (
        <MapHoverCard
          x={hover.x}
          y={hover.y}
          avoid={hover.r}
          within={hover.within}
          obstacles={hover.obstacles}
          title={hover.title}
          line={hover.line}
          query={hover.query}
          photoIds={hover.photoIds}
          onPointerEnter={() => cardRef.current.enter()}
          onPointerLeave={() => cardRef.current.leave()}
          onOpen={(items, index) => {
            cardRef.current.close();
            setViewer({
              slides: items.map((i) =>
                gallerySlide(i, speciesName, (rating) =>
                  api
                    .patch(apiPath("/captures/{id}/rating", { id: i.captureId }), { rating })
                    .catch((err) => toast.error(errorMessage(err, t("gallery.map.rateFailed")))),
                ),
              ),
              index,
            });
          }}
          onShowAll={
            hover.side
              ? () => {
                  const next = hover.side;
                  cardRef.current.close();
                  openSide(next);
                }
              : undefined
          }
        />
      )}
      {viewer && (
        <Lightbox
          slides={viewer.slides}
          index={viewer.index}
          onIndexChange={(index) => setViewer({ ...viewer, index })}
          onClose={() => setViewer(null)}
        />
      )}
      {namingSpot && (
        <AddSpotModal
          initialPoint={namingSpot.point}
          initialName={namingSpot.name}
          initialLocality={namingSpot.locality}
          onClose={() => setNamingSpot(null)}
          onAdded={(spot) => spotSaved(spot, namingSpot.point)}
        />
      )}
      {data && data.total === 0 && <EmptyState compact title={t("gallery.map.empty")} />}
      {/* The counts as a list too: the map itself can't be read by keyboard or screen reader. */}
      {countryList.length > 0 && (
        <Panel as="ul" grouped aria-label={t("gallery.map.regionsLabel")}>
          {listed.map((r) => (
            <li key={r.id}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => openSide({ kind: "photos", selection: { kind: "region", id: r.id, regionOnly: false } })}
                className="w-full justify-between! rounded-none! border-0! px-4!"
              >
                <span className="truncate">{r.name}</span>
                <span className="shrink-0 text-muted">{formatNumber(r.count)}</span>
              </Button>
            </li>
          ))}
          {countryList.length > LIST_PREVIEW && (
            <li className="px-3 py-1.5">
              <Button variant="link" size="sm" onClick={() => setShowAllRegions((v) => !v)}>
                {showAllRegions
                  ? t("gallery.map.showFewerRegions")
                  : t("gallery.map.showAllRegions", { count: countryList.length })}
              </Button>
            </li>
          )}
        </Panel>
      )}
    </div>
  );
}
