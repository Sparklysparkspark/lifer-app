// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { useGalleryDisplayPrefs } from "./useGalleryDisplayPrefs";

const at =
  (url = "/gallery") =>
  ({ children }: { children: ReactNode }) =>
    createElement(MemoryRouter, { initialEntries: [url] }, children);

describe("useGalleryDisplayPrefs groupBy", () => {
  afterEach(() => localStorage.clear());

  it("carries a saved Group by region toggle over as Group = Region", () => {
    localStorage.setItem("lifer:galleryGroupByRegion", "true");
    expect(renderHook(() => useGalleryDisplayPrefs(), { wrapper: at() }).result.current.groupBy).toBe("region");
  });

  it("starts ungrouped otherwise, and remembers the choice", () => {
    localStorage.setItem("lifer:galleryGroupByRegion", "false");
    const { result } = renderHook(() => useGalleryDisplayPrefs(), { wrapper: at() });
    expect(result.current.groupBy).toBe("none");
    act(() => result.current.setGroupBy("broad"));
    expect(renderHook(() => useGalleryDisplayPrefs(), { wrapper: at() }).result.current.groupBy).toBe("broad");
  });
});

describe("useGalleryDisplayPrefs groupBursts", () => {
  afterEach(() => localStorage.clear());

  it("starts off, and remembers the choice in storage and the URL", () => {
    const { result } = renderHook(() => ({ prefs: useGalleryDisplayPrefs(), search: useLocation().search }), {
      wrapper: at(),
    });
    expect(result.current.prefs.groupBursts).toBe(false);
    act(() => result.current.prefs.setGroupBursts(true));
    expect(result.current.prefs.groupBursts).toBe(true);
    expect(result.current.search).toBe("?bursts=1");
    expect(renderHook(() => useGalleryDisplayPrefs(), { wrapper: at() }).result.current.groupBursts).toBe(true);
  });

  it("lets a link's ?bursts= win over the saved choice", () => {
    localStorage.setItem("lifer:galleryGroupBursts", "true");
    const off = renderHook(() => useGalleryDisplayPrefs(), { wrapper: at("/gallery?bursts=0") });
    expect(off.result.current.groupBursts).toBe(false);
  });
});
