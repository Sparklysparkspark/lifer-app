// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, useLocation, useSearchParams } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import { useGalleryFilters } from "./useGalleryFilters";
import { galleryParams } from "./galleryHelpers";

function useFiltersAt() {
  const [params, setParams] = useSearchParams();
  return { filters: useGalleryFilters(params, setParams), search: useLocation().search };
}

const at = (path: string) => ({
  wrapper: ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>,
});

beforeEach(() => localStorage.clear());

describe("Not edited yet", () => {
  it("comes from the URL, counts as a filter and asks the server for the backlog", () => {
    // A saved "hide RAW files" preset stays out of the way while it's on.
    localStorage.setItem("lifer:galleryRawFiles", JSON.stringify("hide"));
    const { result } = renderHook(useFiltersAt, at("/gallery?unedited=1&q=owl"));
    const { query, activeFilterCount } = result.current.filters;
    expect([query.rawFiles, activeFilterCount]).toEqual(["unedited", 1]);
    const params = galleryParams(query);
    expect([params.get("unedited"), params.get("includeRaw"), params.get("q")]).toEqual(["1", null, "owl"]);
  });

  it("is written to the URL, never saved as a preset, and Clear filters drops it", () => {
    const { result } = renderHook(useFiltersAt, at("/gallery"));
    act(() => result.current.filters.setRawFiles("unedited"));
    expect(new URLSearchParams(result.current.search).get("unedited")).toBe("1");
    expect(localStorage.getItem("lifer:galleryRawFiles")).toBeNull();
    act(() => result.current.filters.clearFilters());
    expect(new URLSearchParams(result.current.search).get("unedited")).toBeNull();
    expect(result.current.filters.query.rawFiles).toBe("show");
  });
});
