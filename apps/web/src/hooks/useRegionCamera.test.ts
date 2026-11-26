// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { isMac } from "../lib/platform";
import { useRegionCamera } from "./useRegionCamera";

vi.mock("../lib/pmtiles", () => ({ setTerrainExaggeration: vi.fn() }));
vi.mock("../lib/mapRegionLayers", () => ({ showRegionOutline: vi.fn(), hideRegionOutline: vi.fn() }));

const outline = {
  type: "Polygon",
  coordinates: [
    [
      [-10, 40],
      [5, 40],
      [5, 50],
      [-10, 50],
      [-10, 40],
    ],
  ],
};

function fakeMap() {
  const handlers: Record<string, () => void> = {};
  return {
    cameraForBounds: vi.fn(() => ({ center: [-2.5, 45], zoom: 5 })),
    jumpTo: vi.fn(),
    flyTo: vi.fn(),
    easeTo: vi.fn(),
    once: vi.fn((ev: string, fn: () => void) => (handlers[ev] = fn)),
    setMaxBounds: vi.fn(),
    setMinZoom: vi.fn(),
    getPitch: vi.fn(() => 40),
    getBounds: vi.fn(() => ({
      getWest: (): number => -20,
      getSouth: (): number => 39,
      getEast: (): number => 15,
      getNorth: (): number => 51,
    })),
    land: () => handlers.moveend?.(),
    // The soft hold listens here for zoom-out past the floor.
    container: document.createElement("div"),
    getCanvasContainer() {
      return this.container;
    },
    zoom: 4.5,
    getZoom() {
      return this.zoom;
    },
    getMinZoom: () => 4.5,
    on: vi.fn(),
    off: vi.fn(),
  };
}

function setReducedMotion(on: boolean) {
  window.matchMedia = vi.fn(() => ({ matches: on }) as MediaQueryList);
}

describe("useRegionCamera", () => {
  beforeEach(() => setReducedMotion(false));
  afterEach(cleanup);

  it("flies north up and flat, then holds pan and zoom-out near the framing", () => {
    const map = fakeMap();
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, {}));
    act(() => result.current.enter(outline));
    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ bearing: 0, pitch: 0, duration: 900, zoom: 5 }));
    expect(map.setMinZoom).toHaveBeenLastCalledWith(null);
    map.land();
    expect(map.setMinZoom).toHaveBeenLastCalledWith(4.5);
    // The framing plus a quarter, widened to the view at the zoom floor.
    expect(map.setMaxBounds).toHaveBeenLastCalledWith([
      [-28.75, 36],
      [23.75, 54],
    ]);
    expect(result.current.framing?.bounds).toEqual([-10, 40, 5, 50]);
  });

  it("holds no pan when the landed view already wraps the world", () => {
    const map = fakeMap();
    map.getBounds.mockReturnValue({ getWest: () => -300, getSouth: () => -80, getEast: () => 120, getNorth: () => 85 });
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, {}));
    act(() => result.current.enter(outline));
    map.land();
    expect(map.setMinZoom).toHaveBeenLastCalledWith(4.5);
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(null);
  });

  it("jumps with reduced motion", () => {
    setReducedMotion(true);
    const map = fakeMap();
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, {}));
    act(() => result.current.enter(outline));
    expect(map.flyTo).not.toHaveBeenCalled();
    expect(map.jumpTo).toHaveBeenCalledWith(expect.objectContaining({ pitch: 0, bearing: 0, duration: 0 }));
    expect(map.setMinZoom).toHaveBeenLastCalledWith(4.5);
  });

  it("Mod+0 returns to the framing, and leave lifts the limits and flattens", () => {
    const map = fakeMap();
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, {}));
    act(() => result.current.enter(outline));
    map.flyTo.mockClear();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", code: "Digit0", ctrlKey: !isMac, metaKey: isMac }));
    });
    expect(map.flyTo).toHaveBeenCalledWith(expect.objectContaining({ zoom: 5, bearing: 0 }));
    act(() => result.current.leave());
    expect(result.current.framing).toBeNull();
    expect(map.setMaxBounds).toHaveBeenLastCalledWith(null);
  });

  it("frames a far part on its own", () => {
    const map = fakeMap();
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, {}));
    act(() => result.current.enter(null, "NO", 0));
    expect(result.current.framing?.bounds).toEqual([10.5, 76.4, 33.6, 80.9]);
    expect(map.cameraForBounds).toHaveBeenCalledWith(
      [
        [10.5, 76.4],
        [33.6, 80.9],
      ],
      expect.objectContaining({ maxZoom: 9, bearing: 0 }),
    );
  });

  it("lets go of the region after zooming out past its framing, building up a hint first", () => {
    const map = fakeMap();
    const onRelease = vi.fn();
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, { onRelease }));
    act(() => result.current.enter(outline));
    const notch = () => act(() => void map.container.dispatchEvent(new WheelEvent("wheel", { deltaY: 100 })));
    notch();
    expect(result.current.overshoot).toBeGreaterThan(0);
    expect(onRelease).not.toHaveBeenCalled();
    notch();
    notch();
    expect(onRelease).toHaveBeenCalledTimes(1);
    expect(result.current.overshoot).toBe(0);
  });

  it("frames a region without a flight when let go into it", () => {
    const map = fakeMap();
    const { result } = renderHook(() => useRegionCamera(map as unknown as MapLibreMap, {}));
    act(() => result.current.enter(outline, null, null, { still: true }));
    expect(map.flyTo).not.toHaveBeenCalled();
    expect(map.jumpTo).not.toHaveBeenCalled();
    expect(map.setMinZoom).toHaveBeenLastCalledWith(4.5);
  });
});
