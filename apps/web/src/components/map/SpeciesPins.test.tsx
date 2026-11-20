// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zoomAnchor } from "../../lib/mapCamera";
import type { Map as MapLibreMap } from "maplibre-gl";
import { PIN_CLUSTERS, PIN_HIGHLIGHT, PIN_POINTS, PIN_SOURCE } from "../../lib/mapSpeciesPins";

const env = vi.hoisted(() => ({ data: null as unknown, gets: [] as string[] }));
const ITEM = (photoId: string, rating: number) => ({
  photoId,
  captureId: `c-${photoId}`,
  speciesId: "s1",
  commonName: "Pin Warbler",
  scientificName: "Pinna warbleri",
  taxonClass: "aves",
  kind: "photo",
  qualityRating: rating,
  takenAt: null,
  tags: [],
});
vi.mock("../../api/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  api: {
    get: async (path: string) => {
      env.gets.push(path);
      return path.startsWith("/collection/map/photos") ? { items: [ITEM("p1", 5), ITEM("p2", 3)] } : { checklists: [] };
    },
    patch: vi.fn(async () => ({})),
    post: vi.fn(async () => ({})),
  },
}));
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };
vi.mock("../../hooks/useToast", () => ({ useToast: () => toast }));
vi.mock("../../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiResource: () => ({ data: env.data, error: null, reload: () => {} }),
}));

type Handler = (e?: unknown) => void;
// Stands in for maplibre's Map (jsdom has no WebGL), keeping handlers so a test can hover and click.
class FakeMap {
  handlers: Record<string, Handler[]> = {};
  canvasHandlers: Record<string, Handler> = {};
  canvas = {
    style: { cursor: "" },
    addEventListener: (type: string, fn: Handler) => (this.canvasHandlers[type] = fn),
    removeEventListener: (type: string) => delete this.canvasHandlers[type],
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  };
  sources = new Map<
    string,
    {
      setData: ReturnType<typeof vi.fn>;
      getClusterExpansionZoom: ReturnType<typeof vi.fn>;
      getClusterLeaves: ReturnType<typeof vi.fn>;
    }
  >();
  layers = new Map<string, { visibility?: string; filter?: unknown }>();
  rendered: unknown[] = [];
  // Every camera and limit call, in order, so a test can read the trace of a click.
  trace: Array<[string, unknown?]> = [];
  limit: unknown = { extend: (b: unknown) => ({ widened: b }) };
  easeTo = vi.fn((o: unknown) => {
    this.trace.push(["easeTo", o]);
    this.fire("moveend", {});
  });
  fitBounds = vi.fn(() => this.trace.push(["fitBounds"]));
  flyTo = vi.fn(() => this.trace.push(["flyTo"]));
  jumpTo = vi.fn(() => this.trace.push(["jumpTo"]));
  getMaxBounds() {
    return this.limit;
  }
  setMaxBounds(b: unknown) {
    this.trace.push(["setMaxBounds", b]);
  }
  getBounds() {
    return "view";
  }
  once(event: string, fn: Handler) {
    const wrapped: Handler = (e) => {
      this.off(event, wrapped);
      fn(e);
    };
    return this.on(event, wrapped);
  }
  moving = false;
  on(event: string, fn: Handler) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }
  off(event: string, fn: Handler) {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== fn);
    return this;
  }
  fire(event: string, arg?: unknown) {
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }
  addSource(id: string) {
    this.sources.set(id, {
      setData: vi.fn(),
      getClusterExpansionZoom: vi.fn(async () => 9),
      getClusterLeaves: vi.fn(async () => []),
    });
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addLayer(layer: { id: string; filter?: unknown }) {
    this.layers.set(layer.id, { filter: layer.filter });
  }
  getLayer(id: string) {
    return this.layers.get(id);
  }
  setLayoutProperty(id: string, _k: string, v: string) {
    this.layers.get(id)!.visibility = v;
  }
  getLayoutProperty(id: string) {
    return this.layers.get(id)?.visibility;
  }
  setFilter(id: string, filter: unknown) {
    this.layers.get(id)!.filter = filter;
  }
  queryRenderedFeatures(_box: unknown, options?: { layers?: string[] }) {
    return this.rendered.filter((f) => options?.layers?.includes((f as { layer: { id: string } }).layer.id));
  }
  project() {
    return { x: 50, y: 50 };
  }
  // A 200 x 100 map whose screen points read back as themselves, for the zoom-onto maths.
  getContainer() {
    return { clientWidth: 200, clientHeight: 100, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  }
  unproject([x, y]: [number, number]) {
    return { lng: x, lat: y };
  }
  getZoom() {
    return 6;
  }
  isMoving() {
    return this.moving;
  }
  getCanvas() {
    return this.canvas;
  }
}

const PIN = {
  speciesId: "s1",
  commonName: "Very Long Named Rufous-throated Pin Warbler of the Northern Highlands",
  scientificName: "Pinna warbleri",
  taxonClass: "aves",
  iconicTaxon: null,
  lat: 43,
  lon: 13,
  count: 3,
  photoId: "p1",
};
const pointFeature = {
  layer: { id: PIN_POINTS },
  properties: { i: 0, speciesId: "s1" },
  geometry: { coordinates: [13, 43] },
};
const clusterFeature = {
  layer: { id: PIN_CLUSTERS },
  properties: { cluster_id: 7, point_count: 4 },
  geometry: { coordinates: [13, 43] },
};

function Where() {
  return <span data-testid="where">{useLocation().pathname + useLocation().search}</span>;
}

async function renderPins(map: FakeMap) {
  const { default: SpeciesPins } = await import("./SpeciesPins");
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <SpeciesPins map={map as unknown as MapLibreMap} regionId="r1" regionName="Pin Country" dark={false} />
      <Where />
    </MemoryRouter>,
  );
}

const mouse = (x: number, y: number) => ({ point: { x, y }, originalEvent: { buttons: 0, pointerType: "mouse" } });

describe("SpeciesPins", () => {
  beforeEach(() => {
    env.data = { pins: [PIN], truncated: false };
  });
  afterEach(() => vi.useRealTimers());

  it("adds the pin layers once and draws the pins", async () => {
    const map = new FakeMap();
    await renderPins(map);
    expect(map.getLayer(PIN_POINTS)).toBeTruthy();
    expect(map.getLayer(PIN_CLUSTERS)).toBeTruthy();
    const setData = map.getSource(PIN_SOURCE)!.setData;
    expect(setData.mock.lastCall?.[0].features).toHaveLength(1);
    // No count line, and no note while there are pins.
    expect(screen.queryByTestId("species-pins-empty")).toBeNull();
  });

  it("explains an empty map and links to the Needs placing tray", async () => {
    env.data = { pins: [], truncated: false };
    await renderPins(new FakeMap());
    const link = screen.getByRole("link", { name: "Place photos on the map" });
    expect(link.getAttribute("href")).toBe("/gallery?view=map&at=tray");
  });

  it("shows nothing over the map until the pins arrive", async () => {
    env.data = null;
    await renderPins(new FakeMap());
    expect(screen.queryByTestId("species-pins-empty")).toBeNull();
  });

  it("previews a pin near the pointer: photo, name, photo count and a species link", async () => {
    vi.useFakeTimers();
    const map = new FakeMap();
    map.rendered = [pointFeature];
    await renderPins(map);
    // 10 px off the pin's centre still counts.
    act(() => map.fire("mousemove", mouse(58, 56)));
    await act(async () => vi.advanceTimersByTime(300));
    const card = screen.getByTestId("species-pin-card");
    expect(card.textContent).toContain(PIN.commonName);
    expect(card.textContent).toContain("3 photos here");
    expect(card.querySelector("img")?.getAttribute("src")).toContain("/api/photos/p1/thumb");
    // Its species' pins get a ring.
    expect(JSON.stringify(map.getLayer(PIN_HIGHLIGHT)?.filter)).toContain("s1");
  });

  it("previews the pin's photos on a click, without leaving the page, and not after a drag", async () => {
    const map = new FakeMap();
    map.rendered = [pointFeature];
    await renderPins(map);
    map.canvasHandlers.pointerdown({ clientX: 20, clientY: 50, pointerType: "mouse" });
    act(() => map.fire("click", mouse(50, 50)));
    expect(screen.queryByRole("dialog")).toBeNull();
    map.canvasHandlers.pointerdown({ clientX: 50, clientY: 50, pointerType: "mouse" });
    await act(async () => map.fire("click", mouse(51, 50)));
    const dialog = await screen.findByRole("dialog");
    expect(screen.getByTestId("where").textContent).toBe("/");
    expect(env.gets.some((g) => g.includes("speciesId=s1") && g.includes("lat=43") && g.includes("lon=13"))).toBe(true);
    // Best first, and the arrow keys move through the pin's photos.
    expect(dialog.querySelector("img")?.getAttribute("src")).toContain("/api/photos/p1/");
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByRole("dialog").querySelector("img")?.getAttribute("src")).toContain("/api/photos/p2/");
    // The species page is one deliberate step away.
    fireEvent.click(screen.getByRole("link", { name: /View species/ }));
    expect(screen.getByTestId("where").textContent).toBe("/species/s1");
  });

  it("closes the preview with Esc and leaves the map as it was", async () => {
    const map = new FakeMap();
    map.rendered = [pointFeature];
    await renderPins(map);
    map.canvasHandlers.pointerdown({ clientX: 50, clientY: 50, pointerType: "mouse" });
    await act(async () => map.fire("click", mouse(50, 50)));
    await screen.findByRole("dialog");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(map.easeTo).not.toHaveBeenCalled();
    expect(screen.getByTestId("where").textContent).toBe("/");
  });

  it("opens the same preview from the hover card's photo, and links the species from its footer", async () => {
    vi.useFakeTimers();
    const map = new FakeMap();
    map.rendered = [pointFeature];
    await renderPins(map);
    act(() => map.fire("mousemove", mouse(50, 50)));
    await act(async () => vi.advanceTimersByTime(300));
    const link = screen.getByRole("link", { name: "View species" });
    expect(link.getAttribute("href")).toBe("/species/s1?regionId=r1");
    vi.useRealTimers();
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: `Open the photos of ${PIN.commonName} here` })),
    );
    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
  it("names one species in a cluster's card, counts several, and opens a thumbnail's photos", async () => {
    vi.useFakeTimers();
    const fox = { ...PIN, speciesId: "s2", commonName: "Pin Fox", photoId: "p9", count: 2 };
    env.data = { pins: [PIN, fox], truncated: false };
    const map = new FakeMap();
    map.rendered = [clusterFeature];
    await renderPins(map);
    map.getSource(PIN_SOURCE)!.getClusterLeaves.mockResolvedValue([{ properties: { i: 0 } }, { properties: { i: 1 } }]);
    act(() => map.fire("mousemove", mouse(50, 50)));
    await act(async () => vi.advanceTimersByTime(300));
    const card = screen.getByTestId("species-cluster-card");
    // Several species: counted, with no photo total beside it.
    expect(card.textContent).toContain("2 species here");
    expect(card.textContent).not.toContain("photos here");
    vi.useRealTimers();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Open the photos of Pin Fox here" })));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(env.gets.some((g) => g.includes("speciesId=s2"))).toBe(true);
  });

  it("titles a one-species cluster with its name and photos", async () => {
    vi.useFakeTimers();
    const map = new FakeMap();
    map.rendered = [clusterFeature];
    await renderPins(map);
    map.getSource(PIN_SOURCE)!.getClusterLeaves.mockResolvedValue([{ properties: { i: 0 } }, { properties: { i: 0 } }]);
    act(() => map.fire("mousemove", mouse(50, 50)));
    await act(async () => vi.advanceTimersByTime(300));
    const card = screen.getByTestId("species-cluster-card");
    expect(card.textContent).toContain(PIN.commonName);
    expect(card.textContent).toContain("6 photos here");
    expect(card.textContent).not.toContain("species here");
  });

  it("zooms onto a clicked cluster in one move that ends centred on it", async () => {
    const map = new FakeMap();
    map.rendered = [clusterFeature];
    await renderPins(map);
    map.canvasHandlers.pointerdown({ clientX: 50, clientY: 50, pointerType: "mouse" });
    await act(async () => map.fire("click", mouse(50, 50)));
    expect(map.getSource(PIN_SOURCE)!.getClusterExpansionZoom).toHaveBeenCalledWith(7);
    // The pan limit is lifted, one eased move zooms to the split zoom (from 6, so 750 ms) around
    // the point that slides the cluster (on screen at 50, 50) straight to the centre (100, 50),
    // then the limit comes back widened to hold the end. No recentre on the region.
    const [ax, ay] = zoomAnchor([50, 50], [100, 50], 3)!;
    expect(map.trace).toEqual([
      ["setMaxBounds", null],
      ["easeTo", expect.objectContaining({ around: { lng: ax, lat: ay }, zoom: 9, bearing: 0, duration: 750 })],
      ["setMaxBounds", { widened: "view" }],
    ]);
    expect(map.trace.filter(([k]) => k === "easeTo")).toHaveLength(1);
    expect(map.fitBounds).not.toHaveBeenCalled();
    expect(map.flyTo).not.toHaveBeenCalled();
    expect(map.jumpTo).not.toHaveBeenCalled();
    // A single pin click opens the preview and never moves the camera.
    map.trace = [];
    map.rendered = [pointFeature];
    map.canvasHandlers.pointerdown({ clientX: 50, clientY: 50, pointerType: "mouse" });
    await act(async () => map.fire("click", mouse(50, 50)));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(map.trace).toEqual([]);
  });
  it("removes its handlers and hides its pins on unmount, since the map outlives the page", async () => {
    const map = new FakeMap();
    const view = await renderPins(map);
    expect(map.getLayoutProperty(PIN_POINTS)).toBe("visible");
    view.unmount();
    expect(map.getLayoutProperty(PIN_POINTS)).toBe("none");
    expect(map.handlers.click).toEqual([]);
    expect(map.canvasHandlers.pointerdown).toBeUndefined();
  });
});
