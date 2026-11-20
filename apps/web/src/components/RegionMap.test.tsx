// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// maplibre-gl needs WebGL, which jsdom lacks: a stand-in that records the sources asked for.
const maps: FakeMap[] = [];
const env = vi.hoisted(() => ({ zoom: 12 }));
class FakeMap {
  handlers: Record<string, Array<() => void>> = {};
  specs = new Map<string, unknown>();
  layers: Array<{ id: string }> = [];
  touchZoomRotate = { disableRotation: () => {} };
  keyboard = { disableRotation: () => {} };
  container: HTMLElement;
  constructor(options: { container: HTMLElement }) {
    this.container = options.container;
    maps.push(this);
    queueMicrotask(() => this.fire("load"));
  }
  on(event: string, fn: () => void) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  once(event: string, fn: () => void) {
    return this.on(event, fn);
  }
  off() {
    return this;
  }
  fire(event: string) {
    if (event === "load") this.loaded = true;
    for (const fn of this.handlers[event] ?? []) fn();
  }
  getZoom() {
    return env.zoom;
  }
  getBounds() {
    return {
      toArray: () => [
        [0, 0],
        [1, 1],
      ],
    };
  }
  getStyle() {
    return { layers: this.layers };
  }
  addSource(id: string, spec: unknown) {
    this.specs.set(id, spec);
  }
  getSource(id: string) {
    return this.specs.get(id);
  }
  removeSource(id: string) {
    this.specs.delete(id);
  }
  addLayer(layer: { id: string }) {
    this.layers.push(layer);
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  removeLayer(id: string) {
    this.layers = this.layers.filter((l) => l.id !== id);
  }
  setMaxBounds() {}
  // Can't fit (as MapLibre answers for an empty or degenerate box): the lock uses the view itself.
  cameraForBounds() {
    return undefined;
  }
  getCenter() {
    return { lng: 0, lat: 0 };
  }
  project() {
    return { x: 0, y: 0 };
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
  setMinZoom() {}
  setMaxZoom() {}
  resize() {}
  // Like MapLibre: a control is added at once, so its online detail driver mounts.
  addControl(control: { onAdd: (map: unknown) => HTMLElement }) {
    this.container.appendChild(control.onAdd(this));
  }
  getContainer() {
    return this.container;
  }
  loaded = false;
  isStyleLoaded() {
    return this.loaded;
  }
  remove() {}
  fitBounds() {}
}
vi.mock("maplibre-gl", () => ({
  Map: FakeMap,
  LngLatBounds: class {
    empty = true;
    extend() {
      this.empty = false;
    }
    isEmpty() {
      return this.empty;
    }
    toArray() {
      return [
        [0, 0],
        [1, 1],
      ];
    }
  },
}));
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("../lib/pmtiles", () => ({ ensurePmtilesProtocol: () => {}, pmtilesStyle: () => ({}) }));
vi.mock("../lib/mapRegionLayers", () => ({ showRegionOutline: () => {} }));
vi.mock("../hooks/useMapAvailable", () => ({ useMapAvailable: () => true }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ theme: "light" }) }));
vi.mock("./map/SpeciesPins", () => ({ default: () => null }));

const { default: RegionMap } = await import("./RegionMap");
const { resetOnlineMapPrefs } = await import("../hooks/useOnlineMap");

const OUTLINE = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ],
  },
};
const setOnline = (on: boolean) => Object.defineProperty(navigator, "onLine", { value: on, configurable: true });
const onlineSpecs = () => JSON.stringify([...maps.at(-1)!.specs.values()]);

afterEach(() => {
  // The map (and its controls) is kept for the next mount, like leaving the page: close its panel.
  fireEvent.keyDown(document, { key: "Escape" });
  localStorage.clear();
  act(() => resetOnlineMapPrefs());
  setOnline(true);
  act(() => void window.dispatchEvent(new Event("online")));
  env.zoom = 12;
});

async function renderMap() {
  const view = render(<RegionMap boundaryGeoJson={OUTLINE} regionCode={null} />);
  await act(async () => {});
  return view;
}

describe("RegionMap layers", () => {
  it("has the photo map's layers button, shown on hover or focus", async () => {
    await renderMap();
    const button = screen.getByRole("button", { name: "Map layers" });
    const wrapper = button.closest(".transition-opacity")!;
    expect(wrapper.className).toMatch(/pointer-fine:opacity-0/);
    expect(wrapper.className).toMatch(/group-has-\[:focus-visible\]:opacity-100/);
    expect(button.closest(".group")).toBeTruthy();
    // No place search on this map, so no place switch.
    fireEvent.click(button);
    expect(screen.queryByText("Online place names and search")).toBeNull();
  });

  it("shares the photo map's remembered choice", async () => {
    localStorage.setItem("lifer:photo-map-detail", '"off"');
    await renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Map layers" }));
    expect(screen.getByRole("button", { name: "Off" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Satellite" }));
    expect(localStorage.getItem("lifer:photo-map-base")).toBe('"satellite"');
  });

  it("loads online detail when zoomed in and online, and nothing while Off or offline", async () => {
    const auto = await renderMap();
    await waitFor(() => expect(onlineSpecs()).toMatch(/openfreemap/));
    auto.unmount();

    localStorage.setItem("lifer:photo-map-detail", '"off"');
    act(() => resetOnlineMapPrefs());
    const off = await renderMap();
    expect(onlineSpecs()).not.toMatch(/https?:/);
    off.unmount();

    localStorage.clear();
    act(() => resetOnlineMapPrefs());
    setOnline(false);
    act(() => void window.dispatchEvent(new Event("offline")));
    await renderMap();
    expect(onlineSpecs()).not.toMatch(/https?:/);
  });
});
