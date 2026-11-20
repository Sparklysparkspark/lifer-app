// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Map as MapLibreMap } from "maplibre-gl";
import { addMapCredits, MapCredits } from "./MapCredits";
import { mapPanelBox } from "../../lib/mapCredits";

let handlers: Record<string, Array<() => void>> = {};
const map = {
  getZoom: () => 5,
  getStyle: () => ({ layers: [{ id: "earth", source: "protomaps" }], sources: {} }),
  isStyleLoaded: () => true,
  on: (ev: string, fn: () => void) => (handlers[ev] ??= []).push(fn),
  off: (ev: string, fn: () => void) => (handlers[ev] = (handlers[ev] ?? []).filter((f) => f !== fn)),
} as unknown as MapLibreMap;

beforeEach(() => {
  vi.useFakeTimers();
  handlers = {};
});
afterEach(() => vi.useRealTimers());

const button = () => screen.getByRole("button", { name: "Map credits" });
const panel = () => screen.queryByTestId("map-credits-panel");
const wait = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
const mouse = { pointerType: "mouse" };

describe("MapCredits", () => {
  it("shows OpenStreetMap's credit at first, then only the info button", async () => {
    render(<MapCredits map={map} />);
    expect(screen.getByTestId("map-credits").textContent).toBe("© OpenStreetMap contributors");
    await wait(5100);
    expect(screen.getByTestId("map-credits").textContent).toBe("");
  });

  it("opens the full credits on the page, outside the map, so a small map never clips them", () => {
    render(<MapCredits map={map} />);
    expect(button().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button());
    expect(button().getAttribute("aria-expanded")).toBe("true");
    expect(panel()?.parentElement).toBe(document.body);
    expect(screen.getByTestId("map-credits").contains(panel())).toBe(false);
    expect(panel()?.textContent).toMatch(/Open Database License/);
  });

  it("closes on Esc, on a click elsewhere, and when the map moves", () => {
    render(<MapCredits map={map} />);
    fireEvent.click(button());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(panel()).toBeNull();
    fireEvent.click(button());
    fireEvent.click(document.body);
    expect(panel()).toBeNull();
    fireEvent.click(button());
    act(() => handlers.movestart?.forEach((fn) => fn()));
    expect(panel()).toBeNull();
  });

  it("opens on a short hover and goes almost at once when the pointer leaves both", async () => {
    render(<MapCredits map={map} />);
    const area = screen.getByTestId("map-credits");
    fireEvent.pointerEnter(area, mouse);
    await wait(350);
    expect(panel()).not.toBeNull();
    // Crossing from the button into the panel keeps it.
    fireEvent.pointerLeave(area, mouse);
    fireEvent.pointerEnter(panel()!, mouse);
    await wait(400);
    expect(panel()).not.toBeNull();
    fireEvent.pointerLeave(panel()!, mouse);
    await wait(250);
    expect(panel()).toBeNull();
  });

  it("stays after a tap on a touch screen, which has no hover to leave", async () => {
    render(<MapCredits map={map} />);
    fireEvent.pointerDown(button(), { pointerType: "touch" });
    fireEvent.click(button());
    await wait(1000);
    expect(panel()).not.toBeNull();
  });
});

describe("mapPanelBox", () => {
  const view = { width: 390, height: 700 };
  it("sits above a button in a map's bottom corner, inside the window", () => {
    const box = mapPanelBox({ left: 340, top: 600, right: 372, bottom: 632 }, view);
    expect(box.left).toBeGreaterThanOrEqual(8);
    expect(box.left + box.width).toBeLessThanOrEqual(view.width - 8);
    expect(box.bottom).toBe(view.height - 600 + 4);
    expect(box.maxHeight).toBe(600 - 4 - 8);
  });

  it("drops below a button near the top of the window, with room to scroll", () => {
    const box = mapPanelBox({ left: 340, top: 40, right: 372, bottom: 72 }, view);
    expect(box.top).toBe(76);
    expect(box.maxHeight).toBe(700 - 72 - 4 - 8);
  });
});

describe("addMapCredits", () => {
  it("gives a map that offers satellite the layers button too, once, in the top corner", () => {
    const added: string[] = [];
    const container = document.createElement("div");
    const target = {
      ...map,
      getContainer: () => container,
      addControl: (_c: unknown, where: string) => added.push(where),
    } as unknown as MapLibreMap;
    addMapCredits(target, { satellite: true });
    expect(added).toEqual(["bottom-right", "top-right"]);
    added.length = 0;
    addMapCredits(target);
    expect(added).toEqual(["bottom-right"]);
  });
});
