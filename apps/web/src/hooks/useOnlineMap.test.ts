// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import {
  applyOnlineBasemap,
  onlineMode,
  resetOnlineMapPrefs,
  useOnlineBasemap,
  useOnlineMapPrefs,
  type OnlineMapPrefs,
} from "./useOnlineMap";
import {
  BASEMAP_ATTRIBUTION,
  customSatelliteUrl,
  DETAIL_SOURCE_ID,
  onlineSources,
  SATELLITE_SOURCE_ID,
} from "../lib/mapStyle";

// Just enough of a MapLibre map to record what goes where.
function fakeMap(layerIds: Array<[string, string?]>) {
  const layers = layerIds.map(([id, source]) => ({ id, type: id === "background" ? "background" : "fill", source }));
  const sources = new Map<string, unknown>();
  const paint: Record<string, unknown> = { "circle-opacity": 0.01, "circle-stroke-opacity": 0.55 };
  let maxZoom = 22;
  const map = {
    getStyle: () => ({ layers }),
    addSource: (id: string, spec: unknown) => sources.set(id, spec),
    getSource: (id: string) => sources.get(id),
    removeSource: (id: string) => sources.delete(id),
    addLayer: (layer: { id: string }, before?: string) => {
      const at = before ? layers.findIndex((l) => l.id === before) : layers.length;
      layers.splice(at, 0, layer as never);
    },
    getLayer: (id: string) => layers.find((l) => l.id === id),
    removeLayer: (id: string) =>
      layers.splice(
        layers.findIndex((l) => l.id === id),
        1,
      ),
    setMaxZoom: (z: number) => (maxZoom = z),
    getPaintProperty: (_l: string, k: string) => paint[k],
    setPaintProperty: (_l: string, k: string, v: unknown) => (paint[k] = v),
  };
  return {
    map: map as unknown as MapLibreMap,
    ids: () => layers.map((l) => l.id),
    sources,
    paint,
    maxZoom: () => maxZoom,
  };
}

const BUNDLED: Array<[string, string?]> = [
  ["background"],
  ["earth", "protomaps"],
  ["relief-hillshade", "relief"],
  ["water", "protomaps"],
  ["boundaries_country", "protomaps"],
  ["label-country", "protomaps"],
  ["region-view-mask", "region-view-mask"],
  ["photo-map-region-bubbles", "photo-map-regions"],
];

afterEach(() => {
  localStorage.clear();
  act(() => resetOnlineMapPrefs());
});

describe("applyOnlineBasemap", () => {
  it("adds nothing while online is off", () => {
    const m = fakeMap(BUNDLED);
    applyOnlineBasemap(m.map, null, null);
    expect(m.sources.size).toBe(0);
    expect(m.maxZoom()).toBe(22);
  });

  it("slots detail under the relief, borders and the overlays, and takes it all out again", () => {
    const m = fakeMap(BUNDLED);
    const undo = applyOnlineBasemap(m.map, "detail", null);
    const ids = m.ids();
    expect(ids.indexOf("detail-landcover")).toBeLessThan(ids.indexOf("relief-hillshade"));
    expect(ids.indexOf("detail-road")).toBeLessThan(ids.indexOf("boundaries_country"));
    expect(ids.indexOf("detail-label-place")).toBeLessThan(ids.indexOf("region-view-mask"));
    expect(ids.indexOf("detail-label-place")).toBeGreaterThan(ids.indexOf("label-country"));
    expect([...m.sources.keys()]).toEqual([DETAIL_SOURCE_ID]);
    expect(m.maxZoom()).toBe(18);
    undo();
    expect(m.ids()).toEqual(BUNDLED.map(([id]) => id));
    expect(m.sources.size).toBe(0);
    expect(m.maxZoom()).toBe(22);
  });

  it("puts imagery under the region dim and firms up the rings over it, then restores them", () => {
    const m = fakeMap(BUNDLED);
    const undo = applyOnlineBasemap(m.map, "satellite", null);
    const ids = m.ids();
    expect(ids.indexOf("satellite-imagery")).toBeGreaterThan(ids.indexOf("label-country"));
    expect(ids.indexOf("satellite-imagery")).toBeLessThan(ids.indexOf("region-view-mask"));
    expect(m.paint["circle-opacity"]).toBe(0.3);
    expect(m.maxZoom()).toBe(16);
    undo();
    expect(m.paint).toEqual({ "circle-opacity": 0.01, "circle-stroke-opacity": 0.55 });
  });
});

describe("online sources", () => {
  it("uses the user's own imagery URL only when it is a usable https template", () => {
    expect(customSatelliteUrl("http://a.com/{z}/{x}/{y}.png")).toBeNull();
    expect(customSatelliteUrl("https://a.com/tiles.png")).toBeNull();
    const url = "https://api.example.com/sat/{z}/{x}/{y}.jpg?key=k";
    expect(customSatelliteUrl(` ${url} `)).toBe(url);
    const sat = onlineSources("satellite", url)[SATELLITE_SOURCE_ID] as { tiles: string[]; attribution: string };
    expect(sat.tiles).toEqual([url]);
    expect(sat.attribution).toBe("api.example.com");
  });

  it("credits every source it shows", () => {
    const detail = onlineSources("detail", null)[DETAIL_SOURCE_ID] as { attribution: string };
    expect(detail.attribution).toMatch(/OpenFreeMap.*OpenMapTiles.*OpenStreetMap/);
    const sat = onlineSources("satellite", null);
    expect(Object.keys(sat)).toEqual([DETAIL_SOURCE_ID, SATELLITE_SOURCE_ID]);
    expect(BASEMAP_ATTRIBUTION).toMatch(/OpenStreetMap.*contributors/);
  });

  it("credits EOX and stops imagery at its native zoom", () => {
    const sat = onlineSources("satellite", null)[SATELLITE_SOURCE_ID] as { maxzoom: number; attribution: string };
    expect(sat.maxzoom).toBe(14);
    expect(sat.attribution).toMatch(/EOX IT Services GmbH.*Copernicus Sentinel data/);
  });
});

describe("onlineMode", () => {
  const auto = { detail: "auto", base: "map" } as const;
  it("loads detail only when zoomed in and online, and never with Off or offline", () => {
    expect(onlineMode(auto, { online: true, zoomedIn: false })).toBeNull();
    expect(onlineMode(auto, { online: true, zoomedIn: true })).toBe("detail");
    expect(onlineMode(auto, { online: false, zoomedIn: true })).toBeNull();
    expect(onlineMode({ ...auto, detail: "off" }, { online: true, zoomedIn: true })).toBeNull();
  });
  it("shows satellite whenever picked and online", () => {
    const sat = { detail: "off", base: "satellite" } as const;
    expect(onlineMode(sat, { online: true, zoomedIn: false })).toBe("satellite");
    expect(onlineMode(sat, { online: false, zoomedIn: false })).toBeNull();
  });
});

describe("useOnlineMapPrefs", () => {
  it("defaults to Automatic and remembers the three-way choice", () => {
    const { result } = renderHook(() => useOnlineMapPrefs());
    expect(result.current.choice).toBe("auto");
    act(() => result.current.setChoice("satellite"));
    expect(result.current.choice).toBe("satellite");
    expect(result.current.detail).toBe("auto");
    act(() => result.current.setChoice("off"));
    expect(result.current.base).toBe("map");
    expect(localStorage.getItem("lifer:photo-map-detail")).toBe('"off"');
    expect(renderHook(() => useOnlineMapPrefs()).result.current.choice).toBe("off");
  });

  it("shares one live copy, so a change in one place shows at once everywhere", () => {
    const a = renderHook(() => useOnlineMapPrefs());
    const b = renderHook(() => useOnlineMapPrefs());
    act(() => a.result.current.setChoice("satellite"));
    expect(b.result.current.choice).toBe("satellite");
  });

  it("moves the old on/off switch over: an explicit off stays off, on becomes Automatic", () => {
    localStorage.setItem("lifer:photo-map-online", "false");
    expect(renderHook(() => useOnlineMapPrefs()).result.current.detail).toBe("off");
    expect(localStorage.getItem("lifer:photo-map-online")).toBeNull();
    localStorage.clear();
    localStorage.setItem("lifer:photo-map-online", "true");
    localStorage.setItem("lifer:photo-map-base", '"satellite"');
    expect(renderHook(() => useOnlineMapPrefs()).result.current.choice).toBe("satellite");
    expect(localStorage.getItem("lifer:photo-map-detail")).toBe('"auto"');
  });
});

describe("useOnlineBasemap", () => {
  // A map whose zoom a test can move, recording the sources added.
  function zoomable(zoom: number) {
    const m = fakeMap(BUNDLED);
    const handlers: Record<string, Array<(e?: unknown) => void>> = {};
    Object.assign(m.map, {
      getZoom: () => zoom,
      on: (ev: string, fn: () => void) => (handlers[ev] ??= []).push(fn),
      off: (ev: string, fn: () => void) => (handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn)),
    });
    return {
      ...m,
      emit: (ev: string, e: unknown) => [...(handlers[ev] ?? [])].forEach((fn) => fn(e)),
      zoomTo: (z: number) => {
        zoom = z;
        for (const fn of handlers.zoom ?? []) fn();
      },
    };
  }
  const prefs = (over: Partial<OnlineMapPrefs> = {}) =>
    ({ detail: "auto", base: "map", satelliteUrl: "", ...over }) as OnlineMapPrefs;
  const setOnline = (on: boolean) => Object.defineProperty(navigator, "onLine", { value: on, configurable: true });
  afterEach(() => setOnline(true));

  it("adds detail by itself once zoomed in, never on the world view", () => {
    const m = zoomable(3);
    renderHook(() => useOnlineBasemap(m.map, prefs()));
    expect(m.sources.size).toBe(0);
    act(() => m.zoomTo(12));
    expect([...m.sources.keys()]).toEqual([DETAIL_SOURCE_ID]);
  });

  it("asks nothing online with Off, or while offline, and says so offline", () => {
    const off = zoomable(14);
    renderHook(() => useOnlineBasemap(off.map, prefs({ detail: "off" })));
    expect(off.sources.size).toBe(0);
    setOnline(false);
    const offline = zoomable(14);
    const { result } = renderHook(() => useOnlineBasemap(offline.map, prefs()));
    expect(offline.sources.size).toBe(0);
    expect(result.current.failed).toBe(true);
  });

  describe("on a weak connection", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const tileError = { sourceId: DETAIL_SOURCE_ID, error: new Error("Failed to fetch") };
    const tile = { sourceId: DETAIL_SOURCE_ID, tile: {} };

    it("waits for slow tiles without calling them unavailable, with only a quiet hint", async () => {
      const m = zoomable(12);
      const { result } = renderHook(() => useOnlineBasemap(m.map, prefs()));
      await act(() => vi.advanceTimersByTimeAsync(8000));
      expect(result.current.failed).toBe(false);
      expect(result.current.slow).toBe(true);
      act(() => m.emit("sourcedata", tile));
      expect(result.current.slow).toBe(false);
      expect([...m.sources.keys()]).toEqual([DETAIL_SOURCE_ID]);
    });

    it("keeps trying a dead host in the background, says so only after a run of errors, and clears", async () => {
      const m = zoomable(12);
      const { result } = renderHook(() => useOnlineBasemap(m.map, prefs()));
      const burst = () => act(() => [1, 2, 3, 4, 5].forEach(() => m.emit("error", tileError)));
      burst();
      expect(result.current.failed).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(5000));
      burst();
      expect(result.current.failed).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      burst();
      expect(result.current.failed).toBe(true);
      // Never turned off: the layers are still there, and the next tile clears the notice.
      expect([...m.sources.keys()]).toEqual([DETAIL_SOURCE_ID]);
      act(() => m.emit("sourcedata", tile));
      expect(result.current.failed).toBe(false);
    });
  });
});
