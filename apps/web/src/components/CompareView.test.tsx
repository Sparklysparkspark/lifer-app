// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import CompareView, { type ComparePhoto } from "./CompareView";
import { zoomView, FIT } from "../lib/compareZoom";

const photos: ComparePhoto[] = [
  { captureId: "c1", photoId: "p1", name: "Snowy Egret", takenAt: "2025-05-01T10:00:00Z", rating: null },
  { captureId: "c2", photoId: "p2", name: "Snowy Egret", takenAt: "2025-05-01T10:00:01Z", rating: 3 },
  {
    captureId: "c3",
    photoId: "p3",
    name: "Snowy Egret",
    takenAt: "2025-05-01T10:00:02Z",
    rating: null,
    isFeatured: true,
  },
];

function setup(props: Partial<Parameters<typeof CompareView>[0]> = {}) {
  const handlers = { onClose: vi.fn(), onRate: vi.fn(), onFeature: vi.fn(), onSetAlbumCover: vi.fn() };
  render(<CompareView photos={photos} {...handlers} {...props} />);
  const focusedIndex = () => screen.getAllByRole("figure").findIndex((f) => f.hasAttribute("data-focused"));
  return { ...handlers, focusedIndex };
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(window, { key, code: /^\d$/.test(key) ? `Digit${key}` : undefined, ...init });

describe("CompareView keyboard", () => {
  it("moves the focus with the arrow keys, wrapping at the ends", () => {
    const { focusedIndex } = setup();
    expect(focusedIndex()).toBe(0);
    press("ArrowRight");
    expect(focusedIndex()).toBe(1);
    press("ArrowLeft");
    press("ArrowLeft");
    expect(focusedIndex()).toBe(2);
  });

  it("rates the focused photo with 1 to 5, clears with 0, and the same number twice clears it", () => {
    const { onRate } = setup();
    press("4");
    expect(onRate).toHaveBeenLastCalledWith("c1", 4);
    press("ArrowRight");
    press("3"); // already 3 stars
    expect(onRate).toHaveBeenLastCalledWith("c2", null);
    press("0");
    expect(onRate).toHaveBeenLastCalledWith("c2", null);
    press("6");
    expect(onRate).toHaveBeenCalledTimes(3);
  });

  it("features the focused photo with K, unless it's already the featured photo", () => {
    const { onFeature } = setup();
    press("ArrowRight");
    press("k");
    expect(onFeature).toHaveBeenCalledWith(photos[1]);
    press("ArrowRight");
    press("K");
    expect(onFeature).toHaveBeenCalledTimes(1);
  });

  it("ignores keys typed with Command", () => {
    const { onRate } = setup();
    press("2", { metaKey: true });
    expect(onRate).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const { onClose } = setup();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});

describe("CompareView on a narrow screen", () => {
  it("asks for the better of two at a time and offers the one kept as the featured photo", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} }));
    try {
      const { onFeature } = setup();
      expect(screen.getByRole("heading", { name: "Pick the best" })).toBeTruthy();
      // c1 against c2: keep the bottom (c2); then c2 against c3: keep the top (c2).
      fireEvent.click(screen.getByRole("button", { name: "Keep the bottom photo" }));
      fireEvent.click(screen.getByRole("button", { name: "Keep the top photo" }));
      fireEvent.click(screen.getByRole("button", { name: "Set as featured photo" }));
      expect(onFeature).toHaveBeenCalledWith(photos[1]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("compare zoom", () => {
  it("keeps the point under the pointer still and never pans past an edge", () => {
    const zoomed = zoomView(FIT, 2, 0.25, 0);
    expect(zoomed.scale).toBe(2);
    expect(zoomed.x).toBeCloseTo(-0.25);
    expect(zoomView(zoomed, 1)).toEqual(FIT);
    expect(zoomView(FIT, 3, 0.5, -0.5)).toEqual({ scale: 3, x: -1, y: 1 });
    expect(zoomView(FIT, 100).scale).toBe(6);
  });
});
