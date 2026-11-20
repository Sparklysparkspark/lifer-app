// @vitest-environment jsdom
import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ZoomPane from "./ZoomPane";
import { clampView, containFit, FIT, pinchFactor, wheelPixels, zoomView } from "../lib/compareZoom";

let frames: FrameRequestCallback[] = [];
const flush = () =>
  act(() => {
    const run = frames;
    frames = [];
    run.forEach((f) => f(0));
  });
beforeEach(() => {
  frames = [];
  vi.stubGlobal("requestAnimationFrame", (f: FrameRequestCallback) => frames.push(f));
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

function setup(onBackdropClick?: () => void) {
  const onViewChange = vi.fn();
  const r = render(
    <ZoomPane view={FIT} onViewChange={onViewChange} onBackdropClick={onBackdropClick}>
      <img alt="" />
    </ZoomPane>,
  );
  const frame = r.container.querySelector<HTMLElement>("[data-zoom-pane]")!;
  frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
  const pinch = (deltaY: number) =>
    frame.dispatchEvent(new WheelEvent("wheel", { deltaY, ctrlKey: true, clientX: 50, clientY: 50, cancelable: true }));
  return { onViewChange, frame, pinch, layer: frame.firstElementChild as HTMLElement };
}

describe("ZoomPane", () => {
  it("draws a burst of pinch events once per frame, each building on the last", () => {
    const { onViewChange, pinch, layer } = setup();
    pinch(-10);
    pinch(-10);
    pinch(-10);
    expect(onViewChange).not.toHaveBeenCalled();
    flush();
    expect(onViewChange).toHaveBeenCalledTimes(1);
    // Three steps, not one: no event read a stale view.
    expect(onViewChange.mock.calls[0][0].scale).toBeCloseTo(pinchFactor(-10) ** 3);
    expect(layer.style.transform).toContain("scale(1.3");
    expect(layer.style.transition).toBe("");
  });

  it("stops the page from zooming on a pinch, but lets a plain scroll through when not zoomed", () => {
    const { frame } = setup();
    const scroll = new WheelEvent("wheel", { deltaY: 10, cancelable: true });
    frame.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);
    const pinch = new WheelEvent("wheel", { deltaY: -10, ctrlKey: true, cancelable: true });
    frame.dispatchEvent(pinch);
    expect(pinch.defaultPrevented).toBe(true);
  });

  it("closes on a click beside the photo only", () => {
    const onBackdropClick = vi.fn();
    const { frame } = setup(onBackdropClick);
    fireEvent.click(frame, { clientX: 50, clientY: 50 });
    expect(onBackdropClick).not.toHaveBeenCalled();
    // A wide photo in this square frame leaves bars above and below.
    const img = frame.querySelector("img")!;
    Object.defineProperties(img, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 } });
    Object.defineProperties(frame, { offsetWidth: { value: 100 }, offsetHeight: { value: 100 } });
    fireEvent.load(img);
    fireEvent.click(frame, { clientX: 50, clientY: 5 });
    expect(onBackdropClick).toHaveBeenCalledTimes(1);
  });
});

describe("ZoomPane opening", () => {
  function setupOpen() {
    const onOpen = vi.fn();
    const r = render(
      <ZoomPane view={{ scale: 2, x: 0, y: 0 }} onViewChange={() => {}} onOpen={onOpen} openLabel="Photo">
        <img alt="" />
      </ZoomPane>,
    );
    const frame = r.container.querySelector<HTMLElement>("[data-zoom-pane]")!;
    frame.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
    return { onOpen, frame };
  }
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("opens on a plain click, but not on a double-click or at the end of a drag", () => {
    // jsdom has no PointerEvent, so a drag's coordinates would be lost.
    vi.stubGlobal("PointerEvent", class extends MouseEvent {});
    const { onOpen, frame } = setupOpen();
    fireEvent.click(frame, { detail: 1 });
    vi.advanceTimersByTime(300);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.click(frame, { detail: 1 });
    fireEvent.click(frame, { detail: 2 });
    fireEvent.doubleClick(frame);
    vi.advanceTimersByTime(300);
    expect(onOpen).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(frame, { button: 0, clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(frame, { clientX: 40, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(frame, { pointerId: 1 });
    fireEvent.click(frame, { detail: 1 });
    vi.advanceTimersByTime(300);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is a focusable button that F or Enter opens", () => {
    const { onOpen, frame } = setupOpen();
    expect(frame.getAttribute("role")).toBe("button");
    expect(frame.tabIndex).toBe(0);
    fireEvent.keyDown(frame, { key: "f" });
    fireEvent.keyDown(frame, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });
});

describe("zoom math", () => {
  it("normalises wheel deltas and caps a mouse notch's step", () => {
    expect(wheelPixels(3, 1, 500)).toBe(48);
    expect(wheelPixels(1, 2, 500)).toBe(500);
    expect(pinchFactor(-100)).toBeCloseTo(pinchFactor(-25));
    expect(pinchFactor(0)).toBe(1);
  });

  it("keeps the zoomed photo inside its own edges, and an axis it doesn't fill centred", () => {
    const wide = containFit(2);
    expect(wide).toEqual({ w: 1, h: 0.5 });
    // At 1.5x the wide photo is 0.75 of the frame tall: no vertical pan yet.
    expect(clampView({ scale: 1.5, x: 1, y: 1 }, wide)).toEqual({ scale: 1.5, x: 0.25, y: 0 });
    // At 4x it overhangs by 0.5 above and below.
    expect(clampView({ scale: 4, x: 0, y: 9 }, wide).y).toBe(0.5);
    expect(zoomView(FIT, 0.5)).toEqual(FIT);
    expect(containFit(NaN)).toEqual({ w: 1, h: 1 });
  });
});
