import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Map as MapLibreMap, MapSourceDataEvent } from "maplibre-gl";
import { useOnline } from "./useOnline";
import {
  isBasemapSource,
  customSatelliteUrl,
  DETAIL_SOURCE_ID,
  detailLayers,
  ELEVATION_TINT_LAYER_ID,
  OFFLINE_DETAIL_ZOOM,
  ONLINE_RELIEF_FROM,
  ONLINE_RELIEF_LAYER_ID,
  ONLINE_RELIEF_SOURCE_ID,
  onlineReliefSource,
  RELIEF_LAYER_ID,
  onlineMaxZoom,
  onlineSources,
  SATELLITE_SOURCE_ID,
  satelliteLayers,
  slotOf,
  type OnlineMode,
} from "../lib/mapStyle";

export type MapBase = "map" | "satellite";
export type DetailSetting = "auto" | "off";
/** The one choice Settings shows: Automatic, Off, or Satellite. */
export type OnlineMapChoice = DetailSetting | "satellite";

export interface OnlineMapPrefs {
  /** Automatic (the default) loads street detail when zoomed in and online; Off never does. */
  detail: DetailSetting;
  /** Satellite is picked on purpose, which is its consent. */
  base: MapBase;
  /** The user's own imagery URL (may hold their key), "" for the default provider. */
  satelliteUrl: string;
  choice: OnlineMapChoice;
  setDetail: (detail: DetailSetting) => void;
  setBase: (base: MapBase) => void;
  setChoice: (choice: OnlineMapChoice) => void;
  setSatelliteUrl: (url: string) => void;
}

const OLD_ONLINE_KEY = "lifer:photo-map-online";
const DETAIL_KEY = "lifer:photo-map-detail";

/** Moves the old opt-in switch over (only an explicit "off", written by a click, stays off) and
 *  returns the default. */
function detailDefault(): DetailSetting {
  try {
    const old = localStorage.getItem(OLD_ONLINE_KEY);
    if (old !== null) {
      if (localStorage.getItem(DETAIL_KEY) === null)
        localStorage.setItem(DETAIL_KEY, JSON.stringify(old === "false" ? "off" : "auto"));
      localStorage.removeItem(OLD_ONLINE_KEY);
    }
  } catch {
    // Storage disabled: the default applies.
  }
  return "auto";
}

// One copy of the choices for every map, panel and Settings row on the page (each map's controls
// render in their own React root), stored per browser like usePersistedState.
const memory = new Map<string, unknown>();
const prefListeners = new Set<() => void>();
let prefVersion = 0;
function readPref<T>(key: string, initial: T): T {
  if (memory.has(key)) return memory.get(key) as T;
  try {
    const raw = localStorage.getItem(`lifer:${key}`);
    return raw !== null ? (JSON.parse(raw) as T) : initial;
  } catch {
    return initial;
  }
}
function writePref(key: string, value: unknown) {
  memory.set(key, value);
  try {
    localStorage.setItem(`lifer:${key}`, JSON.stringify(value));
  } catch {
    // Storage disabled: the choice holds for this session only.
  }
  prefVersion++;
  for (const l of prefListeners) l();
}
const subscribePrefs = (l: () => void) => {
  prefListeners.add(l);
  return () => prefListeners.delete(l);
};
/** Test hook: forget the in-memory copy and re-read storage (the stored one is the test's). */
export function resetOnlineMapPrefs(): void {
  memory.clear();
  prefVersion++;
  for (const l of prefListeners) l();
}

/** Remembered per browser, and shared live by every map on the page. */
export function useOnlineMapPrefs(): OnlineMapPrefs {
  useSyncExternalStore(subscribePrefs, () => prefVersion);
  const detail = readPref<DetailSetting>("photo-map-detail", detailDefault());
  const base = readPref<MapBase>("photo-map-base", "map");
  const satelliteUrl = readPref("photo-map-satellite-url", "");
  const setDetail = (v: DetailSetting) => writePref("photo-map-detail", v);
  const setBase = (v: MapBase) => writePref("photo-map-base", v);
  const setSatelliteUrl = (v: string) => writePref("photo-map-satellite-url", v);
  return {
    detail,
    base,
    satelliteUrl,
    choice: base === "satellite" ? "satellite" : detail,
    setDetail,
    setBase,
    setChoice: (choice) => {
      if (choice === "satellite") return setBase("satellite");
      setBase("map");
      setDetail(choice);
    },
    setSatelliteUrl,
  };
}

/** What the map should load: nothing offline or with Off, detail only once zoomed past the offline
 *  map's detail, satellite whenever picked. */
export function onlineMode(
  prefs: Pick<OnlineMapPrefs, "detail" | "base">,
  { online, zoomedIn }: { online: boolean; zoomedIn: boolean },
): OnlineMode | null {
  if (!online) return null;
  if (prefs.base === "satellite") return "satellite";
  return prefs.detail === "auto" && zoomedIn ? "detail" : null;
}

const ONLINE_SOURCES = [DETAIL_SOURCE_ID, SATELLITE_SOURCE_ID];
// A weak connection is slow, not down: these decide when it counts as unavailable.
const HARD_ERRORS = 5;
const FAIL_AFTER_MS = 10_000;
const SLOW_HINT_MS = 5000;
const RETRY_START_MS = 5000;
const RETRY_MAX_MS = 60_000;
// MapLibre's own default, which the offline map keeps.
const DEFAULT_MAX_ZOOM = 22;
// Region rings are hollow on the calm map; over imagery they need a frosted fill to read.
const RINGS = "photo-map-region-bubbles";
const RING_PAINT = ["circle-opacity", "circle-stroke-opacity"] as const;
const RING_OVER_IMAGERY = [0.3, 0.9];

/** Adds or removes the online sources and layers in place (no style reload, so no flash), under the
 *  photo and region layers. Nothing online is added while `mode` is null. */
export function applyOnlineBasemap(map: MapLibreMap, mode: OnlineMode | null, customUrl: string | null): () => void {
  if (!mode) return () => {};
  const layers = mode === "detail" ? detailLayers() : satelliteLayers();
  const ids = map.getStyle().layers.map((l) => l.id);
  const firstOverlay = map
    .getStyle()
    .layers.find((l) => l.type !== "background" && !isBasemapSource((l as { source?: string }).source))?.id;
  // Fills go under the relief so hills still show through woods; lines under the bundled borders.
  const before = {
    fill: [ELEVATION_TINT_LAYER_ID, RELIEF_LAYER_ID, "water"].find((id) => ids.includes(id)) ?? firstOverlay,
    line: ids.includes("boundaries_country") ? "boundaries_country" : firstOverlay,
    top: firstOverlay,
  };
  for (const [id, source] of Object.entries(onlineSources(mode, customUrl))) map.addSource(id, source);
  for (const layer of layers) map.addLayer(layer, before[slotOf(layer)]);
  map.setMaxZoom(onlineMaxZoom(mode, customUrl));
  const ringPaint =
    mode === "satellite" && map.getLayer(RINGS) ? RING_PAINT.map((k) => map.getPaintProperty(RINGS, k)) : null;
  if (ringPaint) RING_PAINT.forEach((k, i) => map.setPaintProperty(RINGS, k, RING_OVER_IMAGERY[i]));
  return () => {
    try {
      for (const layer of layers) if (map.getLayer(layer.id)) map.removeLayer(layer.id);
      for (const id of ONLINE_SOURCES) if (map.getSource(id)) map.removeSource(id);
      map.setMaxZoom(DEFAULT_MAX_ZOOM);
      if (ringPaint && map.getLayer(RINGS)) RING_PAINT.forEach((k, i) => map.setPaintProperty(RINGS, k, ringPaint[i]));
    } catch {
      // The map was already removed (a theme change rebuilds it), taking these with it.
    }
  };
}

// Errors in a row, with no tile between, before online relief gives way to the bundled one.
const RELIEF_ERRORS = 4;

/** Sharper relief from Mapterhorn past the bundled archive's zoom, shaded like the bundled layer. The
 *  bundled shading steps back only once an online tile has arrived, and returns for good (silently)
 *  after a run of errors, so a dead or blocked connection never leaves the map flat. */
// shortcut: the elevation tint stays on the bundled zoom 5 data; move it to this source too if it
// looks soft next to the sharper shading.
export function applyOnlineRelief(map: MapLibreMap): () => void {
  const bundled = map.getStyle().layers.find((l) => l.id === RELIEF_LAYER_ID);
  if (!bundled || bundled.type !== "hillshade") return () => {};
  const { minzoom = 0, maxzoom = 24 } = bundled;
  const restore = () => map.setLayerZoomRange(RELIEF_LAYER_ID, minzoom, maxzoom);
  map.addSource(ONLINE_RELIEF_SOURCE_ID, onlineReliefSource());
  map.addLayer(
    { ...bundled, id: ONLINE_RELIEF_LAYER_ID, source: ONLINE_RELIEF_SOURCE_ID, minzoom: ONLINE_RELIEF_FROM },
    RELIEF_LAYER_ID,
  );
  let errors = 0;
  const onData = (e: MapSourceDataEvent) => {
    if (e.sourceId !== ONLINE_RELIEF_SOURCE_ID || !e.tile) return;
    errors = 0;
    map.setLayerZoomRange(RELIEF_LAYER_ID, minzoom, ONLINE_RELIEF_FROM);
  };
  const remove = () => {
    map.off("sourcedata", onData);
    map.off("error", onError);
    try {
      if (map.getLayer(ONLINE_RELIEF_LAYER_ID)) map.removeLayer(ONLINE_RELIEF_LAYER_ID);
      if (map.getSource(ONLINE_RELIEF_SOURCE_ID)) map.removeSource(ONLINE_RELIEF_SOURCE_ID);
      if (map.getLayer(RELIEF_LAYER_ID)) restore();
    } catch {
      // The map was already removed (a theme change rebuilds it), taking these with it.
    }
  };
  // Listening also keeps these expected failures out of the console.
  const onError = (e: object) => {
    if ((e as { sourceId?: string }).sourceId !== ONLINE_RELIEF_SOURCE_ID) return;
    if (++errors >= RELIEF_ERRORS) remove();
  };
  map.on("sourcedata", onData);
  map.on("error", onError);
  return remove;
}

/** Drives one map from the prefs; returns the mode in use and whether the online tiles failed (or
 *  are wanted while offline). */
export function useOnlineBasemap(map: MapLibreMap | null, prefs: OnlineMapPrefs) {
  const online = useOnline();
  // Latched per map: once detail is added it stays, and its layers' minzoom hides it (so nothing is
  // requested) when zoomed back out. Adding it lazily keeps even the TileJSON off the world view.
  const [zoomedInOn, setZoomedInOn] = useState<MapLibreMap | null>(null);
  const zoomedIn = !!map && zoomedInOn === map;
  const [pastDetail, setPastDetail] = useState(false);
  // Latched like detail: past the bundled relief's zoom, online and on Automatic (not satellite).
  const [reliefOn, setReliefOn] = useState<MapLibreMap | null>(null);
  const onlineRelief = !!map && reliefOn === map && online && prefs.detail === "auto" && prefs.base === "map";
  const mode = onlineMode(prefs, { online, zoomedIn });
  const customUrl = customSatelliteUrl(prefs.satelliteUrl);
  // Which setup failed or is slow, so a new mode or URL starts clean without resetting state in
  // the effect.
  const key = `${mode}|${customUrl}`;
  const [failedFor, setFailedFor] = useState<string | null>(null);
  const [slowFor, setSlowFor] = useState<string | null>(null);
  // Bumped to re-add the online layers after hard errors, so a weak connection gets another go.
  const [attempt, setAttempt] = useState(0);
  const backoff = useRef(RETRY_START_MS);
  // Hard errors since a tile last arrived, kept across retries (so a dead host still shows).
  const errors = useRef({ key: "", count: 0, first: 0 });

  useEffect(() => {
    if (!map) return;
    const onZoom = () => {
      const past = map.getZoom() >= OFFLINE_DETAIL_ZOOM;
      setPastDetail(past);
      if (past) setZoomedInOn(map);
      if (map.getZoom() >= ONLINE_RELIEF_FROM - 0.5) setReliefOn(map);
    };
    onZoom();
    map.on("zoom", onZoom);
    return () => {
      map.off("zoom", onZoom);
    };
  }, [map]);

  useEffect(() => {
    if (!map) return;
    const undo = applyOnlineBasemap(map, mode, customUrl);
    // Slow tiles just arrive later over the offline map. Only a run of hard errors with nothing
    // arriving, lasting a while, counts as unavailable; any tile that arrives clears it.
    if (errors.current.key !== key) errors.current = { key, count: 0, first: 0 };
    const run = errors.current;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const slowTimer = mode ? setTimeout(() => setSlowFor(key), SLOW_HINT_MS) : undefined;
    const onError = (e: object) => {
      const id = (e as { sourceId?: string }).sourceId;
      if (!id || !ONLINE_SOURCES.includes(id)) return;
      const now = Date.now();
      if (run.count === 0) run.first = now;
      run.count++;
      if (run.count >= HARD_ERRORS && now - run.first >= FAIL_AFTER_MS) setFailedFor(key);
      if (run.count >= 2 && !retry)
        retry = setTimeout(() => {
          backoff.current = Math.min(backoff.current * 2, RETRY_MAX_MS);
          setAttempt((a) => a + 1);
        }, backoff.current);
    };
    const onData = (e: MapSourceDataEvent) => {
      if (!ONLINE_SOURCES.includes(e.sourceId) || !e.tile) return;
      run.count = 0;
      clearTimeout(retry);
      retry = undefined;
      clearTimeout(slowTimer);
      backoff.current = RETRY_START_MS;
      setFailedFor(null);
      setSlowFor(null);
    };
    map.on("error", onError);
    map.on("sourcedata", onData);
    return () => {
      clearTimeout(retry);
      clearTimeout(slowTimer);
      map.off("error", onError);
      map.off("sourcedata", onData);
      undo();
    };
  }, [map, mode, customUrl, key, attempt]);

  useEffect(() => {
    if (map && onlineRelief) return applyOnlineRelief(map);
  }, [map, onlineRelief]);

  // Offline but wanting online tiles: the same quiet note as a failed load.
  const wanted = prefs.base === "satellite" || (prefs.detail === "auto" && pastDetail);
  const failed = (!!mode && failedFor === key) || (!online && wanted);
  return { mode, failed, slow: !failed && !!mode && slowFor === key };
}

// What each map's online layers are doing, for its layers button (another React root).
export type OnlineBasemapState = { mode: OnlineMode | null; failed: boolean; slow?: boolean };
const IDLE: OnlineBasemapState = { mode: null, failed: false, slow: false };
const mapStates = new WeakMap<MapLibreMap, OnlineBasemapState>();
const stateListeners = new Set<() => void>();
export function publishOnlineState(map: MapLibreMap, state: OnlineBasemapState): void {
  const prev = mapStates.get(map);
  if (prev?.mode === state.mode && prev?.failed === state.failed && !!prev?.slow === !!state.slow) return;
  mapStates.set(map, state);
  for (const l of stateListeners) l();
}
const subscribeStates = (l: () => void) => {
  stateListeners.add(l);
  return () => stateListeners.delete(l);
};
export function useOnlineBasemapState(map: MapLibreMap | null): OnlineBasemapState {
  return useSyncExternalStore(subscribeStates, () => (map && mapStates.get(map)) || IDLE);
}
