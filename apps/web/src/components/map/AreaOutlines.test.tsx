// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { AREA_FILL, AREA_SOURCE, highlightedArea } from "../../lib/mapAreaOutlines";
import { PIN_POINTS } from "../../lib/mapSpeciesPins";

const env = vi.hoisted(() => ({ paths: [] as string[] }));
const shape = { geometry: { type: "Polygon", coordinates: [[[0, 0]]] } };
vi.mock("../../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useApiResource: (path: string) => {
    env.paths.push(path);
    return {
      data: {
        regions: [
          { id: "a", parentId: "country", boundaryGeoJson: shape },
          { id: "b", parentId: "country", boundaryGeoJson: shape },
        ],
      },
      error: null,
    };
  },
}));
vi.mock("../../lib/mapStyle", () => ({ token: () => "gray" }));

type Handler = (e?: unknown) => void;
// Stands in for maplibre's Map (jsdom has no WebGL): `rendered` is what the pointer is over.
class FakeMap {
  handlers: Record<string, Handler[]> = {};
  container = Object.assign(document.createElement("div"), { getBoundingClientRect: () => ({ left: 0, top: 0 }) });
  sources = new Map<string, { setData: ReturnType<typeof vi.fn> }>();
  layers: Array<{ id: string; before?: string }> = [{ id: "region-view-outline" }];
  rendered: Array<{ layer: { id: string }; properties: Record<string, unknown> }> = [];
  states: Array<[unknown, unknown]> = [];
  on(event: string, fn: Handler) {
    (this.handlers[event] ??= []).push(fn);
  }
  off(event: string, fn: Handler) {
    this.handlers[event] = (this.handlers[event] ?? []).filter((h) => h !== fn);
  }
  fire(event: string, arg?: unknown) {
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }
  addSource(id: string) {
    this.sources.set(id, { setData: vi.fn() });
  }
  getSource(id: string) {
    return this.sources.get(id);
  }
  addLayer(layer: { id: string }, before?: string) {
    this.layers.push({ id: layer.id, before });
  }
  getLayer(id: string) {
    return this.layers.find((l) => l.id === id);
  }
  getCanvasContainer() {
    return this.container;
  }
  queryRenderedFeatures(_at: unknown, options?: { layers?: string[] }) {
    return this.rendered.filter((f) => options?.layers?.includes(f.layer.id));
  }
  setFeatureState(feature: unknown, state: unknown) {
    this.states.push([feature, state]);
  }
  getZoom() {
    return 6;
  }
  isMoving() {
    return false;
  }
}

const { default: AreaOutlines } = await import("./AreaOutlines");

const AREAS = [
  { id: "a", name: "Alpha" },
  { id: "b-landing", name: "A very long area name that would never fit in a pill" },
];
const target = (id: string) => (id === "b" ? "b-landing" : id);
const over = (map: FakeMap, area: string) => (map.rendered = [{ layer: { id: AREA_FILL }, properties: { area } }]);
const move = (map: FakeMap) => act(() => map.fire("mousemove", { point: { x: 10, y: 20 }, originalEvent: {} }));

afterEach(() => act(() => highlightedArea.set(null)));

function renderOutlines(onOpen = vi.fn()) {
  const map = new FakeMap();
  render(
    <AreaOutlines
      map={map as unknown as MapLibreMap}
      regionId="country"
      areas={AREAS}
      target={target}
      onOpen={onOpen}
    />,
  );
  return { map, onOpen };
}

describe("AreaOutlines", () => {
  it("draws every area in one source under the region's edge, tagged with the id its pill opens", () => {
    const { map } = renderOutlines();
    expect(env.paths.at(-1)).toBe("/regions/boundaries?parentId=country");
    expect(map.layers.slice(1).every((l) => l.before === "region-view-outline")).toBe(true);
    const data = map.sources.get(AREA_SOURCE)!.setData.mock.calls.at(-1)![0];
    expect(data.features.map((f: { properties: { area: string } }) => f.properties.area)).toEqual(["a", "b-landing"]);
  });

  it("names a pointed-at area in full and lights it for its pill", () => {
    const { map } = renderOutlines();
    over(map, "b-landing");
    move(map);
    expect(screen.getByTestId("area-outline-name").textContent).toBe(AREAS[1].name);
    expect(highlightedArea.get()).toBe("b-landing");
    expect(map.states).toContainEqual([{ source: AREA_SOURCE, id: "b-landing" }, { hover: true }]);
    map.rendered = [];
    move(map);
    expect(screen.queryByTestId("area-outline-name")).toBeNull();
    expect(highlightedArea.get()).toBeNull();
  });

  it("lights an outline when its pill is pointed at, without a map label", () => {
    const { map } = renderOutlines();
    act(() => highlightedArea.set("a"));
    expect(map.states).toContainEqual([{ source: AREA_SOURCE, id: "a" }, { hover: true }]);
    expect(screen.queryByTestId("area-outline-name")).toBeNull();
  });

  it("opens a clicked area like its pill, but leaves a click on a pin to the pin", () => {
    const { map, onOpen } = renderOutlines();
    over(map, "a");
    act(() => map.fire("click", { point: { x: 10, y: 20 } }));
    expect(onOpen).toHaveBeenCalledWith("a");

    onOpen.mockClear();
    map.layers.push({ id: PIN_POINTS });
    map.rendered.push({ layer: { id: PIN_POINTS }, properties: {} });
    act(() => map.fire("click", { point: { x: 10, y: 20 } }));
    expect(onOpen).not.toHaveBeenCalled();
  });
});
