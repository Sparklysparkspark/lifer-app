// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ProgressiveImg from "./ProgressiveImg";

// An observer that never reports, like a tile still waiting for its first intersection callback.
class SilentObserver {
  observe() {}
  disconnect() {}
}

describe("ProgressiveImg", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("waits for the observer before loading a photo it hasn't shown", () => {
    vi.stubGlobal("IntersectionObserver", SilentObserver);
    render(<ProgressiveImg thumbSrc="/p/1/thumb" fullSrc="/p/1/display" alt="Wren" />);
    expect(screen.getByAltText("Wren").getAttribute("src")).toBeNull();
  });

  it("redraws an already shown photo on remount without waiting for the observer", () => {
    const first = render(<ProgressiveImg thumbSrc="/p/2/thumb" fullSrc="/p/2/display" alt="Heron" />);
    fireEvent.load(screen.getByAltText("Heron"));
    first.unmount();

    vi.stubGlobal("IntersectionObserver", SilentObserver);
    render(<ProgressiveImg thumbSrc="/p/2/thumb" fullSrc="/p/2/display" alt="Heron" />);
    expect(screen.getByAltText("Heron").getAttribute("src")).toBe("/p/2/thumb");
  });
});
