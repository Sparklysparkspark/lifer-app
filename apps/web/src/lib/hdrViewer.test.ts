// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hdrScreen, hdrUrlFor, useHdrScreen, useHdrViewerSetting } from "./hdrViewer";

function stubScreen(hdr: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: hdr,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  vi.stubGlobal("matchMedia", () => query);
  return {
    set(next: boolean) {
      query.matches = next;
      listeners.forEach((fn) => fn());
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("hdrUrlFor", () => {
  it("asks for the HDR copy of the owner's photo only when on and the screen shows HDR", () => {
    expect(hdrUrlFor("/api/photos/p1/display", true, true)).toBe("/api/photos/p1/hdr");
    expect(hdrUrlFor("/api/photos/p1/display", false, true)).toBeNull();
    expect(hdrUrlFor("/api/photos/p1/display", true, false)).toBeNull();
  });

  it("never for share links, reference photos or other renditions", () => {
    expect(hdrUrlFor("/api/share/t1/photos/p1/display", true, true)).toBeNull();
    expect(hdrUrlFor("/api/species/s1/reference-photo/display", true, true)).toBeNull();
    expect(hdrUrlFor("/api/photos/p1/full?original=raw", true, true)).toBeNull();
    expect(hdrUrlFor("/api/photos/p1/display?download=1", true, true)).toBeNull();
  });
});

describe("HDR screen detection", () => {
  it("is false where the browser has no matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(hdrScreen()).toBe(false);
  });

  it("follows the screen as HDR is turned on and off", () => {
    const screen = stubScreen(false);
    const { result } = renderHook(() => useHdrScreen());
    expect(result.current).toBe(false);
    act(() => screen.set(true));
    expect(result.current).toBe(true);
  });
});

describe("Show HDR photos in the viewer", () => {
  it("is off by default, remembered as lifer:hdrViewer, and unreadable storage reads as off", () => {
    const { result } = renderHook(() => useHdrViewerSetting());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(localStorage.getItem("lifer:hdrViewer")).toBe("true");
    expect(renderHook(() => useHdrViewerSetting()).result.current[0]).toBe(true);

    localStorage.setItem("lifer:hdrViewer", "{broken");
    expect(renderHook(() => useHdrViewerSetting()).result.current[0]).toBe(false);
  });
});
