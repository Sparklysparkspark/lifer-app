// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hdrScreen, hdrUrlFor, useHdrPhoto, useHdrScreen, useHdrViewerSetting } from "./hdrViewer";

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
  const ready = new Set(["p1"]);

  it("asks for the rendition of the owner's photo only when on and the screen shows HDR", () => {
    expect(hdrUrlFor("/api/photos/p1/display", true, true, ready)).toBe("/api/photos/p1/hdr");
    expect(hdrUrlFor("/api/photos/p1/display", false, true, ready)).toBeNull();
    expect(hdrUrlFor("/api/photos/p1/display", true, false, ready)).toBeNull();
  });

  it("only for photos with a rendition, or any when the list couldn't be had", () => {
    expect(hdrUrlFor("/api/photos/p2/display", true, true, ready)).toBeNull();
    expect(hdrUrlFor("/api/photos/p2/display", true, true, null)).toBe("/api/photos/p2/hdr");
  });

  it("never for share links, reference photos or other renditions", () => {
    expect(hdrUrlFor("/api/share/t1/photos/p1/display", true, true, null)).toBeNull();
    expect(hdrUrlFor("/api/species/s1/reference-photo/display", true, true, null)).toBeNull();
    expect(hdrUrlFor("/api/photos/p1/full?original=raw", true, true, null)).toBeNull();
    expect(hdrUrlFor("/api/photos/p1/display?download=1", true, true, null)).toBeNull();
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

describe("useHdrPhoto", () => {
  it("loads the rendition only for photos the server lists as having one", async () => {
    stubScreen(true);
    localStorage.setItem("lifer:hdrViewer", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ photoIds: ["p1"] }), { headers: { "Content-Type": "application/json" } }),
      ),
    );
    const decoded: string[] = [];
    Object.defineProperty(HTMLImageElement.prototype, "decode", {
      configurable: true,
      value(this: HTMLImageElement) {
        decoded.push(this.getAttribute("src") ?? "");
        return Promise.resolve();
      },
    });
    try {
      const listed = renderHook(() => useHdrPhoto("/api/photos/p1/display"));
      const unlisted = renderHook(() => useHdrPhoto("/api/photos/p2/display"));
      await waitFor(() => expect(listed.result.current).toBe("/api/photos/p1/hdr"));
      expect(unlisted.result.current).toBeNull();
      expect(decoded).toEqual(["/api/photos/p1/hdr"]);
    } finally {
      delete (HTMLImageElement.prototype as Partial<HTMLImageElement>).decode;
    }
  });
});
