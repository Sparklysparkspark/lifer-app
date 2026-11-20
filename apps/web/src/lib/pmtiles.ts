import { setWorkerUrl, addProtocol } from "maplibre-gl";
import { Protocol } from "pmtiles";
import type { Map as MapLibreMap, StyleSpecification } from "maplibre-gl";
// MapLibre builds its worker URL at runtime, which the production bundle can't see; `?url`
// makes Vite emit the worker file and hand back its real path.
import maplibreWorkerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { detailMapUrl, detailMaps, PMTILES_URL, RELIEF_URL, reliefAvailable } from "./pmtilesAvailable";
import {
  BASEMAP_ATTRIBUTION,
  LANDCOVER_SOURCE_ID,
  OFFLINE_DETAIL_PREFIX,
  offlineDetailLayers,
  PMTILES_SOURCE_ID,
  quietLayers,
  reliefStyleParts,
  RELIEF_SOURCE_ID,
} from "./mapStyle";
setWorkerUrl(maplibreWorkerUrl);

// Self-hosted offline basemap: a Protomaps PMTiles archive (zoom 0-8) served by our API, with
// the calm style generated client-side (mapStyle.ts). Labels use bundled glyphs; no sprites or icons.
export { PMTILES_URL, checkPmtilesAvailable } from "./pmtilesAvailable";
export { PMTILES_SOURCE_ID };

// Noto Sans (OFL) in the web bundle, Latin ranges only (public/map-glyphs, about 0.5 MB). Any other
// range answers empty, so a stray character is skipped instead of fetching the app's HTML.
const GLYPH_RANGES = new Set(["0-255", "256-511", "512-767", "7680-7935", "8192-8447"]);
const GLYPHS_URL = "lifer-glyphs://{fontstack}/{range}";

let protocolRegistered = false;
export function ensurePmtilesProtocol(): void {
  if (protocolRegistered) return;
  const protocol = new Protocol();
  addProtocol("pmtiles", protocol.tile);
  addProtocol("lifer-glyphs", async ({ url }, controller) => {
    const range = url.split("/").pop() ?? "";
    if (!GLYPH_RANGES.has(range)) return { data: new ArrayBuffer(0) };
    const res = await fetch(`/map-glyphs/noto-sans-regular/${range}.pbf`, { signal: controller.signal });
    if (!res.ok) throw new Error(`Map glyphs ${range}: ${res.status}`);
    return { data: await res.arrayBuffer() };
  });
  protocolRegistered = true;
}

// maxzoom must match the archive's real max (8) so deeper zooms reuse z8 tiles instead of
// requesting ones that don't exist.
export function pmtilesStyle(theme: "light" | "dark"): StyleSpecification {
  const absolute = (url: string) => new URL(url, window.location.origin).toString();
  const base = quietLayers(PMTILES_SOURCE_ID, theme);
  const archive = `pmtiles://${absolute(PMTILES_URL)}`;
  const style: StyleSpecification = {
    version: 8,
    glyphs: GLYPHS_URL,
    sources: {
      [PMTILES_SOURCE_ID]: { type: "vector", url: archive, maxzoom: 8, attribution: BASEMAP_ATTRIBUTION },
      [LANDCOVER_SOURCE_ID]: { type: "vector", url: archive, maxzoom: 7, attribution: BASEMAP_ATTRIBUTION },
    },
    layers: base,
  };
  return withDetailMaps(reliefAvailable() ? withRelief(style, absolute(RELIEF_URL)) : style, absolute);
}

function withRelief(style: StyleSpecification, url: string): StyleSpecification {
  const relief = reliefStyleParts(url);
  const water = style.layers.findIndex((l) => l.id === "water");
  return {
    ...style,
    sources: { ...style.sources, ...relief.sources },
    // Between land and water, so the sea stays flat.
    layers: [...style.layers.slice(0, water), relief.hillshade, ...style.layers.slice(water)],
  };
}

// Each downloaded country map is drawn over the world map where its tiles exist (the archive's own
// bounds and zooms keep it from being asked for anywhere else), so the world map shows elsewhere.
// shortcut: inside a detailed country the zoom 5 hillshade is covered from zoom 9; give extracts
// their own terrain when they ship it.
function withDetailMaps(style: StyleSpecification, absolute: (url: string) => string): StyleSpecification {
  const codes = detailMaps();
  if (codes.length === 0) return style;
  const parts = codes.map(offlineDetailLayers);
  const water = style.layers.findIndex((l) => l.id === "water") + 1;
  const sources = Object.fromEntries(
    codes.map((code) => [
      `${OFFLINE_DETAIL_PREFIX}${code}`,
      { type: "vector" as const, url: `pmtiles://${absolute(detailMapUrl(code))}`, attribution: BASEMAP_ATTRIBUTION },
    ]),
  );
  return {
    ...style,
    sources: { ...style.sources, ...sources },
    layers: [
      ...style.layers.slice(0, water),
      ...parts.flatMap((p) => p.fills),
      ...style.layers.slice(water),
      ...parts.flatMap((p) => p.labels),
    ],
  };
}

// Per map, set by the region camera: bigger regions get a little more relief.
const exaggerations = new WeakMap<MapLibreMap, number>();

/** Terrain only while the map is tilted (the region camera, two-finger drag, Ctrl-drag or
 *  Shift+Up/Down), since a flat map gains nothing from it. Zoom never tilts: the world stays flat and
 *  3D is a choice made in region view (useRegionCamera). No-op without the relief archive.
 *  Returns a function that flattens the map when `tilted()` is false (after the 3D toggle turns off). */
export function tiltTerrain(map: MapLibreMap, tilted: () => boolean): () => void {
  map.on("pitch", () => {
    if (!map.getSource(RELIEF_SOURCE_ID)) return;
    const on = map.getPitch() > 0;
    if (on !== (map.getTerrain() !== null)) map.setTerrain(on ? terrainFor(map) : null);
  });
  return () => {
    if (!tilted() && map.getPitch() > 0) map.setPitch(0);
  };
}

function terrainFor(map: MapLibreMap) {
  const terrain = reliefStyleParts("").terrain!;
  return { ...terrain, exaggeration: exaggerations.get(map) ?? terrain.exaggeration };
}

export function setTerrainExaggeration(map: MapLibreMap, exaggeration: number): void {
  exaggerations.set(map, exaggeration);
  if (map.getTerrain()) map.setTerrain(terrainFor(map));
}
