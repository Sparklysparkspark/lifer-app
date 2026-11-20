// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";

vi.mock("../../hooks/useMapAvailable", () => ({ useMapAvailable: () => true }));
const { default: MapOnlineDetail } = await import("./MapOnlineDetail");
const { resetOnlineMapPrefs, useOnlineBasemapState } = await import("../../hooks/useOnlineMap");

// A map whose style reads "not loaded" while a newly added source loads, like MapLibre's.
function fakeMap(zoom: number) {
  const handlers: Record<string, Array<() => void>> = {};
  const sources = new Map<string, unknown>();
  let loading = false;
  const map = {
    getZoom: () => zoom,
    isStyleLoaded: () => !loading,
    getStyle: () => ({ layers: [] }),
    addSource: vi.fn((id: string, spec: unknown) => {
      sources.set(id, spec);
      loading = true;
      for (const fn of handlers.styledata ?? []) fn();
    }),
    getSource: (id: string) => sources.get(id),
    removeSource: vi.fn((id: string) => sources.delete(id)),
    addLayer: () => {},
    getLayer: () => undefined,
    removeLayer: () => {},
    setMaxZoom: () => {},
    on: (ev: string, fn: () => void) => (handlers[ev] ??= []).push(fn),
    off: (ev: string, fn: () => void) => (handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn)),
  };
  return map;
}

afterEach(() => {
  localStorage.clear();
  act(() => resetOnlineMapPrefs());
});

describe("MapOnlineDetail", () => {
  it("adds detail once on any zoomed-in map, without taking it out while its tiles load", async () => {
    const map = fakeMap(12);
    render(<MapOnlineDetail map={map as unknown as MapLibreMap} satellite={false} />);
    await act(async () => {});
    expect(map.addSource).toHaveBeenCalledTimes(1);
    expect(map.removeSource).not.toHaveBeenCalled();
  });

  it("publishes what it shows for the map's layers button", async () => {
    const map = fakeMap(12) as unknown as MapLibreMap;
    function Probe() {
      return <span data-testid="mode">{useOnlineBasemapState(map).mode ?? "none"}</span>;
    }
    const view = render(
      <>
        <MapOnlineDetail map={map} satellite={false} />
        <Probe />
      </>,
    );
    await act(async () => {});
    expect(view.getByTestId("mode").textContent).toBe("detail");
  });

  it("leaves satellite out on maps that don't offer it", async () => {
    localStorage.setItem("lifer:photo-map-base", '"satellite"');
    act(() => resetOnlineMapPrefs());
    const map = fakeMap(3);
    render(<MapOnlineDetail map={map as unknown as MapLibreMap} satellite={false} />);
    await act(async () => {});
    expect(map.addSource).not.toHaveBeenCalled();
  });
});
