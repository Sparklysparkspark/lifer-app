import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Map as MapLibreMap, LngLatBounds } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { addMapCredits } from "./map/MapCredits";
import { useTheme } from "../hooks/useTheme";
import { useMapAvailable } from "../hooks/useMapAvailable";
import { useLatest } from "../hooks/useLatest";
import { ensurePmtilesProtocol, pmtilesStyle } from "../lib/pmtiles";
import { easeOut, FLY_MS, holdableView, regionFraming, startFraming, viewAround } from "../lib/mapCamera";
import { useApiResource } from "../lib/resource";
import { showRegionOutline } from "../lib/mapRegionLayers";
import { useMapControlSlot } from "../lib/mapControlSlot";
import Button from "./Button";
import SpeciesPins from "./map/SpeciesPins";
import AreaOutlines, { type AreaOutlinesProps } from "./map/AreaOutlines";

// Capped at the archive's max zoom.
const FIT = { padding: 24, maxZoom: 8 };
const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

// The curated framing (far-flung islands left out, the antimeridian handled), north up and flat:
// the starting view, which zooming and panning stay inside.
function framedBounds(boundary: Boundary, code: string | null | undefined): LngLatBounds {
  const f = regionFraming(boundary, code);
  if (!f) return boundsOf(boundary);
  const [w, s, e, n] = f.bounds;
  return new LngLatBounds([w, s], [e, n]);
}

type Boundary = { type: "Feature"; geometry: { coordinates: unknown } };

// The first view: the framing with a tall country's stretched far north cropped, but never a pin.
function startBounds(boundary: Boundary, code: string | null | undefined, pinLats: readonly number[]) {
  const full = framedBounds(boundary, code);
  if (full.isEmpty()) return full;
  const [[w, s], [e, n]] = full.toArray();
  const [sw, ss, se, sn] = startFraming(boundary, [w, s, e, n], pinLats);
  return new LngLatBounds([sw, ss], [se, sn]);
}

function boundsOf(boundary: Boundary): LngLatBounds {
  const bounds = new LngLatBounds();
  const extend = (coords: unknown): void => {
    if (Array.isArray(coords) && typeof coords[0] === "number") bounds.extend(coords as [number, number]);
    else if (Array.isArray(coords)) coords.forEach(extend);
  };
  extend(boundary.geometry.coordinates);
  return bounds;
}

// The map kept when the Collection page goes away: building one (a WebGL context, shaders and the
// basemap) costs a few hundred milliseconds, so coming back reuses it instead.
type ParkedMap = {
  el: HTMLDivElement;
  map: MapLibreMap;
  theme: string;
  shownBoundary: unknown;
  ready: boolean;
  onReady: (() => void) | null;
  /** The starting view's zoom and centre: away from them, Reset view shows and the wheel zooms. */
  homeZoom: number;
  homeCenter: [number, number];
};

// Moved off the starting view: zoomed in, or panned more than a nudge.
function movedFromHome(entry: ParkedMap): boolean {
  const map = entry.map;
  if (map.getZoom() > entry.homeZoom + 0.05) return true;
  const home = map.project(entry.homeCenter);
  const box = map.getContainer();
  return Math.hypot(home.x - box.clientWidth / 2, home.y - box.clientHeight / 2) > 24;
}

// Panning and zooming stay inside the view of the whole region (`full`, which the first view may
// crop at the top), so the map can't be lost but all of the region stays reachable. A view wider
// than the world can't be a pan limit (MapLibre would snap the camera elsewhere), so then only
// the zoom-out stop holds.
function lockToView(entry: ParkedMap, full: LngLatBounds): void {
  const map = entry.map;
  const [[w, s], [e, n]] = map.getBounds().toArray();
  entry.homeZoom = map.getZoom();
  const c = map.getCenter();
  entry.homeCenter = [c.lng, c.lat];
  // At the starting view the wheel scrolls the page.
  map.scrollZoom.disable();
  const whole = full.isEmpty() ? null : map.cameraForBounds(full, FIT);
  let reach: [number, number, number, number] = [w, s, e, n];
  let floor = entry.homeZoom;
  if (whole?.zoom !== undefined && whole.center) {
    const c = whole.center as { lng: number; lat: number };
    const box = map.getContainer();
    const [vw, vs, ve, vn] = viewAround([c.lng, c.lat], whole.zoom, box.clientWidth, box.clientHeight);
    reach = [Math.min(w, vw), Math.min(s, vs), Math.max(e, ve), Math.max(n, vn)];
    floor = Math.min(floor, whole.zoom);
  }
  const view = holdableView(reach);
  map.setMaxBounds(null);
  if (view)
    map.setMaxBounds([
      [view[0], view[1]],
      [view[2], view[3]],
    ]);
  map.setMinZoom(floor);
}
let parked: ParkedMap | null = null;

// Glides to the region's starting view, then keeps the map inside it again.
function goHome(
  entry: ParkedMap | null,
  boundary: Boundary,
  code: string | null | undefined,
  done: () => void,
  pinLats: readonly number[] = [],
) {
  const bounds = startBounds(boundary, code, pinLats);
  if (!entry || bounds.isEmpty()) return;
  // The last region's limits would clamp the flight to it.
  entry.map.setMaxBounds(null);
  entry.map.setMinZoom(null);
  entry.map.once("moveend", () => {
    lockToView(entry, framedBounds(boundary, code));
    done();
  });
  const duration = reducedMotion() ? 0 : FLY_MS;
  entry.map.fitBounds(bounds, { ...FIT, bearing: 0, pitch: 0, duration, easing: easeOut });
}

// Built inside `host`, so the camera fits the region at the map's real size.
function buildMap(
  host: HTMLElement,
  boundary: Boundary,
  code: string | null | undefined,
  theme: string,
  outline: () => Boundary,
): ParkedMap {
  ensurePmtilesProtocol();
  const el = document.createElement("div");
  el.className = "h-full w-full";
  host.appendChild(el);
  const bounds = startBounds(boundary, code, []);
  const map = new MapLibreMap({
    container: el,
    ...(bounds.isEmpty() ? {} : { bounds, fitBoundsOptions: FIT }),
    style: pmtilesStyle(theme === "dark" ? "dark" : "light"),
    // North up and flat. At the starting view the wheel scrolls the page (the wheel zoom is off
    // until the map has moved; see the region effect), so the map never traps the page.
    scrollZoom: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    // Our own credits line (addMapCredits): short, always shown, full citations one click away.
    attributionControl: false,
  });
  addMapCredits(map, { satellite: true });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation();
  // A trackpad pinch (a wheel with Ctrl) zooms even at the starting view, where the wheel zoom
  // is still off; after that MapLibre's own wheel zoom takes over.
  map.getCanvasContainer().addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey || map.scrollZoom.isEnabled()) return;
      e.preventDefault();
      const box = map.getCanvasContainer().getBoundingClientRect();
      const around = map.unproject([e.clientX - box.left, e.clientY - box.top]);
      map.easeTo({ zoom: map.getZoom() - e.deltaY / 100, around, duration: 0 });
    },
    { passive: false },
  );
  const entry: ParkedMap = {
    el,
    map,
    theme,
    shownBoundary: boundary,
    ready: false,
    onReady: null,
    homeZoom: 0,
    homeCenter: [0, 0],
  };
  map.on("load", () => {
    showRegionOutline(map, outline());
    lockToView(entry, framedBounds(boundary, code));
    entry.ready = true;
    entry.onReady?.();
  });
  // Test hook (e2e/visual): where the camera settled, on whichever page holds the map now.
  map.on("idle", () => {
    const host = el.parentElement;
    if (host) host.dataset.viewBounds = map.getBounds().toArray().flat().join(",");
  });
  return entry;
}

/** `regionCode` (the eBird code) picks a hand-tuned framing when the region has one. With a
 *  `regionId`, the species photographed there show as pins; with `areas`, its areas' outlines. */
export default function RegionMap({
  boundaryGeoJson,
  regionCode,
  regionId,
  regionName,
  areas,
}: {
  boundaryGeoJson: unknown;
  regionCode?: string | null;
  regionId?: string | null;
  regionName?: string;
  areas?: AreaOutlinesProps | null;
}) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const entryRef = useRef<ParkedMap | null>(null);
  const [zoomedIn, setZoomedIn] = useState(false);
  // The outline the map draws, compared by identity: a new region's key arrives before its
  // outline does, so following the key would frame the old outline and skip the new one.
  const shownBoundaryRef = useRef<unknown>(null);
  // The map once its style has loaded, for the pins.
  const [readyMap, setReadyMap] = useState<MapLibreMap | null>(null);
  // The map's top-right control row, where Reset view sits beside the layers button.
  const controlSlot = useMapControlSlot(readyMap);
  const loaded = readyMap !== null;
  const mapAvailable = useMapAvailable();
  // The basemap flavor follows the app theme; the light flavor is unreadable in dark mode.
  const { theme } = useTheme();
  const boundaryRef = useLatest(boundaryGeoJson as Boundary | null);
  const codeRef = useLatest(regionCode);
  // The species pins' points (the request SpeciesPins makes), so the first view never crops one.
  const pinData = useApiResource<{ pins: Array<{ lat: number }> }>(
    regionId ? `/collection/map?regionId=${regionId}` : null,
  ).data;
  const pinLatsRef = useLatest((pinData?.pins ?? []).map((p) => p.lat));
  const hasBoundary = !!boundaryGeoJson;

  // One map for as long as the page shows one, and kept while it doesn't: drilling from a country
  // to a province (or back), or leaving the page and returning, moves its camera instead.
  useEffect(() => {
    const host = containerRef.current;
    const boundary = boundaryRef.current;
    if (!host || !boundary || !mapAvailable) return;

    if (parked && parked.theme !== theme) {
      parked.map.remove();
      parked = null;
    }
    const reused = parked;
    parked = null;
    const entry = reused ?? buildMap(host, boundary, codeRef.current, theme, () => boundaryRef.current ?? boundary);
    if (reused) {
      host.appendChild(entry.el);
      entry.map.resize();
    }
    mapRef.current = entry.map;
    entryRef.current = entry;
    shownBoundaryRef.current = entry.shownBoundary;
    // Off the starting view the wheel zooms and Reset view shows; back on it, the wheel scrolls
    // the page again.
    const onZoom = () => {
      const moved = entry.ready && movedFromHome(entry);
      if (moved) entry.map.scrollZoom.enable();
      else entry.map.scrollZoom.disable();
      setZoomedIn(moved);
    };
    entry.map.on("moveend", onZoom);
    onZoom();
    entry.onReady = () => setReadyMap(entry.map);
    if (entry.ready) setReadyMap(entry.map);

    return () => {
      entry.map.off("moveend", onZoom);
      entry.onReady = null;
      entry.shownBoundary = shownBoundaryRef.current;
      entry.el.remove();
      parked?.map.remove();
      parked = entry;
      mapRef.current = null;
      entryRef.current = null;
      setReadyMap(null);
    };
  }, [hasBoundary, mapAvailable, theme, boundaryRef, codeRef]);

  // A new region: swap the outline and glide the camera to it.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !boundaryGeoJson || shownBoundaryRef.current === boundaryGeoJson) return;
    shownBoundaryRef.current = boundaryGeoJson;
    delete containerRef.current?.dataset.viewBounds;
    showRegionOutline(map, boundaryGeoJson);
    goHome(
      entryRef.current,
      boundaryGeoJson as Boundary,
      codeRef.current,
      () => setZoomedIn(false),
      pinLatsRef.current,
    );
  }, [boundaryGeoJson, loaded, codeRef, pinLatsRef]);

  // Pins arriving above the cropped top of the first view: frame them too, unless the user has
  // already moved in.
  useEffect(() => {
    const entry = entryRef.current;
    if (!entry || !loaded || !boundaryGeoJson || zoomedIn || !pinData) return;
    const top = entry.map.getBounds().toArray()[1][1];
    if (!pinData.pins.some((p) => p.lat > top)) return;
    goHome(entry, boundaryGeoJson as Boundary, codeRef.current, () => setZoomedIn(false), pinLatsRef.current);
    // Only when the pins arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinData, loaded]);

  // The basemap is an opt-in download; with none (or still checking) the map takes no space.
  if (!boundaryGeoJson || !mapAvailable) return null;

  // data-outline-*: test hooks (e2e/visual) for the outline being drawn.
  const geometry = (boundaryGeoJson as { geometry: { type: string; coordinates: unknown[] } }).geometry;
  return (
    <div className="relative">
      <div
        ref={containerRef}
        className="h-80 w-full overflow-hidden rounded-panel border border-line"
        data-testid="region-map"
        data-outline-polygons={geometry.type === "MultiPolygon" ? geometry.coordinates.length : 1}
        data-outline-bounds={boundsOf(boundaryGeoJson as Boundary)
          .toArray()
          .flat()
          .join(",")}
      />
      {areas && <AreaOutlines map={readyMap} {...areas} />}
      {regionId && <SpeciesPins map={readyMap} regionId={regionId} regionName={regionName} dark={theme === "dark"} />}
      {zoomedIn &&
        controlSlot &&
        createPortal(
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              goHome(
                entryRef.current,
                boundaryGeoJson as Boundary,
                codeRef.current,
                () => setZoomedIn(false),
                pinLatsRef.current,
              )
            }
          >
            {t("collection.map.resetView")}
          </Button>,
          controlSlot,
        )}
    </div>
  );
}
