// @vitest-environment jsdom
// Going from a province up to its country (British Columbia to Canada) on the Collection map:
// the camera must land on the country, not snap elsewhere because of a pan limit.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const maps: FakeMap[] = [];
// The view each fitBounds lands on: Canada fits a wide, short map below zoom 1, wider than the world.
const views = vi.hoisted(() => ({ next: [] as Array<{ box: number[][]; zoom: number }> }));
class FakeMap {
  handlers: Record<string, Array<() => void>> = {};
  view = {
    box: [
      [-139, 48],
      [-114, 60],
    ],
    zoom: 3.2,
  };
  maxBounds: unknown = "unset";
  minZoom: number | null = null;
  fitted: number[][][] = [];
  touchZoomRotate = { disableRotation: () => {} };
  keyboard = { disableRotation: () => {} };
  constructor() {
    maps.push(this);
    queueMicrotask(() => this.fire("load"));
  }
  on(event: string, fn: () => void) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  once(event: string, fn: () => void) {
    const wrapped = () => {
      this.handlers[event] = (this.handlers[event] ?? []).filter((f) => f !== wrapped);
      fn();
    };
    return this.on(event, wrapped);
  }
  off() {
    return this;
  }
  fire(event: string) {
    for (const fn of [...(this.handlers[event] ?? [])]) fn();
  }
  getZoom() {
    return this.view.zoom;
  }
  getBounds() {
    return { toArray: () => this.view.box };
  }
  getStyle() {
    return { layers: [] };
  }
  addSource() {}
  getSource() {}
  addLayer() {}
  getLayer() {}
  setMaxBounds(b: unknown) {
    // A box held while the camera moves clamps it there; that was the bug.
    this.maxBounds = b;
  }
  getContainer() {
    return { clientWidth: 1500, clientHeight: 320 };
  }
  // Can't fit (as MapLibre answers for an empty or degenerate box): the lock uses the view itself.
  cameraForBounds() {
    return undefined;
  }
  // The centre of the shown view; projected, it sits in the middle of the 1500 x 320 map.
  getCenter() {
    const [[w, s], [e, n]] = this.view.box;
    return { lng: (w + e) / 2, lat: (s + n) / 2 };
  }
  project(ll: [number, number]) {
    const c = this.getCenter();
    return ll[0] === c.lng && ll[1] === c.lat ? { x: 750, y: 160 } : { x: 0, y: 0 };
  }
  // The wheel zoom, which RegionMap turns on only off the starting view.
  scrollZoom = {
    on: true,
    enable() {
      this.on = true;
    },
    disable() {
      this.on = false;
    },
    isEnabled() {
      return this.on;
    },
  };
  canvasContainer = { addEventListener: () => {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  getCanvasContainer() {
    return this.canvasContainer;
  }
  setMinZoom(z: number | null) {
    this.minZoom = z;
  }
  setMaxZoom() {}
  resize() {}
  addControl() {}
  remove() {}
  fitBounds(bounds: { box: number[][] }) {
    this.fitted.push(bounds.box);
    this.view = views.next.shift() ?? this.view;
    this.fire("moveend");
  }
}
vi.mock("maplibre-gl", () => ({
  Map: FakeMap,
  LngLatBounds: class {
    box: number[][];
    constructor(sw?: number[], ne?: number[]) {
      this.box = sw && ne ? [sw, ne] : [];
    }
    extend() {}
    isEmpty() {
      return this.box.length === 0;
    }
    toArray() {
      return this.box;
    }
  },
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("../lib/pmtiles", () => ({ ensurePmtilesProtocol: () => {}, pmtilesStyle: () => ({}) }));
vi.mock("../lib/mapRegionLayers", () => ({ showRegionOutline: () => {} }));
vi.mock("../hooks/useMapAvailable", () => ({ useMapAvailable: () => true }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./map/SpeciesPins", () => ({ default: () => null }));
vi.mock("./map/MapLayersControl", () => ({ default: () => null }));
// The control stack's slot for Reset view (the layers control's, not built by the stand-in map).
vi.mock("../lib/mapControlSlot", () => ({ useMapControlSlot: () => document.body }));

const { default: RegionMap } = await import("./RegionMap");

const square = (w: number, s: number, e: number, n: number) => ({
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [w, s],
        [e, s],
        [e, n],
        [w, n],
        [w, s],
      ],
    ],
  },
});
const BC = square(-139, 48.3, -114, 60);
const CANADA = square(-141, 41.7, -52.6, 83.1);

// The map is kept between renders (RegionMap parks it), so tests share maps[0].
afterEach(() => {
  views.next = [];
});

describe("RegionMap region changes", () => {
  it("frames Canada after British Columbia without holding it to a box wider than the world", async () => {
    const view = render(<RegionMap boundaryGeoJson={BC} regionCode="CA-BC" />);
    await act(async () => {});
    const map = maps[0];
    // British Columbia's view is held.
    expect(map.maxBounds).toEqual([
      [-139, 48],
      [-114, 60],
    ]);
    views.next.push({
      box: [
        [-359, 33.6],
        [165.5, 84.2],
      ],
      zoom: 0.72,
    });
    view.rerender(<RegionMap boundaryGeoJson={CANADA} regionCode="CA" />);
    await act(async () => {});
    // The flight goes to Canada's first view (its framing with the far north above 76°N cropped),
    // with the old limits lifted first.
    expect(map.fitted.at(-1)).toEqual([
      [-141, 41.7],
      [-52.6, 76],
    ]);
    // Canada's view wraps the world: no pan limit, just the zoom-out stop at its view.
    expect(map.maxBounds).toBeNull();
    expect(map.minZoom).toBe(0.72);
  });

  it("crops Canada's far north from the first view but lets zooming out reach all of it", async () => {
    const view = render(<RegionMap boundaryGeoJson={BC} regionCode="CA-BC" />);
    await act(async () => {});
    const map = maps[0];
    // The whole country fits at zoom 0.72 (its Arctic to 83°N); its first view lands at 1.4.
    map.cameraForBounds = () => ({ center: { lng: -96.8, lat: 71.3 }, zoom: 0.72 }) as never;
    views.next.push({
      box: [
        [-180, 38],
        [-14, 77],
      ],
      zoom: 1.4,
    });
    view.rerender(<RegionMap boundaryGeoJson={CANADA} regionCode="CA" />);
    await act(async () => {});
    expect(map.fitted.at(-1)).toEqual([
      [-141, 41.7],
      [-52.6, 76],
    ]);
    expect(map.minZoom).toBe(0.72);
    // That whole view wraps the world at this size, so no pan limit holds it in.
    expect(map.maxBounds).toBeNull();
  });

  it("Reset view returns to the (cropped) first view, and the wheel zooms only off it", async () => {
    const view = render(<RegionMap boundaryGeoJson={BC} regionCode="CA-BC" />);
    await act(async () => {});
    const map = maps[0];
    views.next.push({
      box: [
        [-180, 38],
        [-14, 77],
      ],
      zoom: 1.4,
    });
    view.rerender(<RegionMap boundaryGeoJson={CANADA} regionCode="CA" />);
    await act(async () => {});
    // The first view: the page scrolls over it, and there's nothing to reset.
    expect(map.scrollZoom.isEnabled()).toBe(false);
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
    // The user zooms in.
    map.view = {
      box: [
        [-130, 48],
        [-110, 56],
      ],
      zoom: 5,
    };
    act(() => map.fire("moveend"));
    expect(map.scrollZoom.isEnabled()).toBe(true);
    views.next.push({
      box: [
        [-180, 38],
        [-14, 77],
      ],
      zoom: 1.4,
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset view" })));
    // Back to Canada's first view (north cropped at 76°N), the wheel scrolling the page again.
    expect(map.fitted.at(-1)).toEqual([
      [-141, 41.7],
      [-52.6, 76],
    ]);
    expect(map.scrollZoom.isEnabled()).toBe(false);
    expect(screen.queryByRole("button", { name: "Reset view" })).toBeNull();
  });

  it("frames every downloaded country at a hub, and Reset view goes back there (Belize with Canada)", async () => {
    const belize = square(-89.2, 15.9, -87.8, 18.5);
    const northAmerica = {
      type: "Feature",
      geometry: { type: "MultiPolygon", coordinates: [CANADA, belize].map((c) => c.geometry.coordinates) },
      properties: { countries: [CANADA, belize].map((outline) => ({ outline, code: null })) },
    };
    render(<RegionMap boundaryGeoJson={northAmerica} regionCode={null} />);
    await act(async () => {});
    const map = maps[0];
    const start = [
      [-141, 15.9],
      [-52.6, 76],
    ];
    expect(map.fitted.at(-1)).toEqual(start);
    map.view = {
      box: [
        [-92, 14],
        [-86, 20],
      ],
      zoom: 6,
    };
    act(() => map.fire("moveend"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset view" })));
    expect(map.fitted.at(-1)).toEqual(start);
  });
});
