// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { useCuratedTilt } from "./useCuratedTilt";

function fakeMap(zoom: number, pitch = 0) {
  const handlers: Record<string, () => void> = {};
  return {
    zoom,
    pitch,
    getZoom() {
      return this.zoom;
    },
    getPitch() {
      return this.pitch;
    },
    easeTo: vi.fn(),
    on: vi.fn((ev: string, fn: () => void) => (handlers[ev] = fn)),
    off: vi.fn(),
    moved: () => handlers.moveend?.(),
  };
}

const motion = (reduce: boolean) => (window.matchMedia = vi.fn(() => ({ matches: reduce }) as MediaQueryList));

describe("useCuratedTilt", () => {
  afterEach(cleanup);

  it("eases to the curated angle when zoomed in, and back to flat when zoomed out", () => {
    motion(false);
    const map = fakeMap(6);
    renderHook(() => useCuratedTilt(map as unknown as MapLibreMap, "auto", true));
    expect(map.easeTo).toHaveBeenLastCalledWith({ pitch: 50, bearing: 0, duration: 500 });
    map.pitch = 50;
    map.zoom = 4;
    map.moved();
    expect(map.easeTo).toHaveBeenLastCalledWith({ pitch: 0, bearing: 0, duration: 500 });
  });

  it("never tilts when Flat is picked, and jumps with reduced motion", () => {
    motion(true);
    const flat = fakeMap(7);
    renderHook(() => useCuratedTilt(flat as unknown as MapLibreMap, "flat", true));
    expect(flat.easeTo).not.toHaveBeenCalled();
    const tilted = fakeMap(7, 50);
    renderHook(() => useCuratedTilt(tilted as unknown as MapLibreMap, "flat", true));
    expect(tilted.easeTo).toHaveBeenLastCalledWith({ pitch: 0, bearing: 0, duration: 0 });
  });
});
