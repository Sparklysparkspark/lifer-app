// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useGalleryDisplayPrefs } from "./useGalleryDisplayPrefs";

describe("useGalleryDisplayPrefs groupBy", () => {
  afterEach(() => localStorage.clear());

  it("carries a saved Group by region toggle over as Group = Region", () => {
    localStorage.setItem("lifer:galleryGroupByRegion", "true");
    expect(renderHook(() => useGalleryDisplayPrefs()).result.current.groupBy).toBe("region");
  });

  it("starts ungrouped otherwise, and remembers the choice", () => {
    localStorage.setItem("lifer:galleryGroupByRegion", "false");
    const { result } = renderHook(() => useGalleryDisplayPrefs());
    expect(result.current.groupBy).toBe("none");
    act(() => result.current.setGroupBy("broad"));
    expect(renderHook(() => useGalleryDisplayPrefs()).result.current.groupBy).toBe("broad");
  });
});
