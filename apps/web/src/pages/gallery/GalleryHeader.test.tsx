// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { GalleryFilters } from "./useGalleryFilters";
import type { GalleryFacets } from "./useGalleryFacets";
import type { GalleryDisplayPrefs } from "./useGalleryDisplayPrefs";

// The View and Filters menus have tests of their own; stubs keep this one about the toolbar order.
vi.mock("../../components/PhotoGridControls", () => ({
  PhotoViewMenu: () => <button type="button">View</button>,
}));
vi.mock("../../components/PhotoFiltersMenu", () => ({
  default: () => <button type="button">Filters</button>,
  ScopeChip: () => null,
}));

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { GalleryToolbar } = await import("./GalleryHeader");

function renderToolbar(activeFilterCount: number) {
  const filters = {
    query: { similarTo: null, regionIds: [], shotActions: new Set(), shotFramings: new Set(), searchQuery: "" },
    activeFilterCount,
    searchInput: "",
    setSearchInput: vi.fn(),
    clearFilters: vi.fn(),
  } as unknown as GalleryFilters;
  render(
    <MemoryRouter>
      <GalleryToolbar
        filters={filters}
        facets={{ libraryEmpty: false } as GalleryFacets}
        display={{} as GalleryDisplayPrefs}
        groupBy="none"
        tagOptions={[]}
        searching={false}
        hasPhotos
        selectMode={false}
        onEnterSelectMode={vi.fn()}
        onExitSelectMode={vi.fn()}
        onSaveSmartAlbum={vi.fn()}
        onPinFilters={vi.fn()}
      />
    </MemoryRouter>,
  );
  return filters;
}

const buttons = () => screen.getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);

describe("GalleryToolbar", () => {
  it("puts Select before the More menu, which is last", () => {
    renderToolbar(0);
    expect(buttons()).toEqual(["View", "Filters", "Select", "More options"]);
  });

  it("shows Clear all filters only with a filter set, and it clears them", () => {
    const filters = renderToolbar(2);
    expect(buttons()).toEqual(["View", "Filters", "Clear all filters", "Select", "More options"]);
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(filters.clearFilters).toHaveBeenCalled();
  });

  it("keeps Save as smart album in the More menu, after Find similar", () => {
    renderToolbar(1);
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Find similar photos",
      "Save as smart album",
      "Pin these filters",
    ]);
  });
});
