// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import PhotoFiltersMenu, { PhotoFilterFields } from "./PhotoFiltersMenu";
import type { GalleryFilters } from "../pages/gallery/useGalleryFilters";
import type { AppearanceFacets, GalleryFacets } from "../pages/gallery/useGalleryFacets";
import type { AppearanceFilter } from "../pages/gallery/types";

vi.mock("../hooks/useRegions", () => ({ useRegions: () => ({ regions: [] }) }));
vi.mock("../hooks/useInatStatus", () => ({ useInatStatus: () => null }));

const NONE: AppearanceFilter = { lifeStage: [], sex: [], plumage: [], morph: [] };

function renderAppearance(facets: Partial<AppearanceFacets> | null, chosen: Partial<AppearanceFilter> = {}) {
  const filters = {
    query: { appearance: { ...NONE, ...chosen }, regionIds: [], tiers: [], selectedTaxa: new Set() },
    activeFilterCount: 0,
    setAppearance: vi.fn(),
  } as unknown as GalleryFilters;
  const appearance = facets && { lifeStage: [], sex: [], plumage: [], morph: [], ...facets };
  render(
    <PhotoFilterFields
      filters={filters}
      facets={{ appearance } as GalleryFacets}
      tagOptions={[]}
      sections={["appearance"]}
    />,
  );
  return filters;
}

describe("Appearance filter", () => {
  it("hides when the library holds no appearance values", () => {
    renderAppearance({});
    expect(screen.queryByText("Appearance")).toBeNull();
  });

  it("offers only the life stages and sexes the library holds, in their natural order", () => {
    const filters = renderAppearance(
      {
        lifeStage: [
          { value: "adult", count: 4 },
          { value: "juvenile", count: 2 },
        ],
        sex: [{ value: "female", count: 1 }],
      },
      { lifeStage: ["adult"] },
    );
    const stages = screen.getByRole("group", { name: "Life stage" });
    expect([...stages.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Juvenile", "Adult"]);
    expect(screen.getByRole("group", { name: "Sex" }).textContent).toContain("Female");
    fireEvent.click(screen.getByRole("button", { name: "Juvenile" }));
    expect(filters.setAppearance).toHaveBeenCalledWith("lifeStage", ["adult", "juvenile"]);
  });

  it("lists many morphs with counts and narrows them with a search, keeping picked ones", () => {
    const morph = Array.from({ length: 300 }, (_, i) => ({ value: `morph ${i}`, count: 300 - i }));
    const filters = renderAppearance({ morph }, { morph: ["morph 5"] });
    const list = screen.getByRole("group", { name: "Colour morph" });
    expect(list.querySelectorAll("input[type=checkbox]")).toHaveLength(300);
    fireEvent.change(screen.getByRole("textbox", { name: "Find a morph" }), { target: { value: "morph 29" } });
    // "morph 29", "morph 290".."morph 299", and the picked "morph 5".
    expect(list.querySelectorAll("input[type=checkbox]")).toHaveLength(12);
    fireEvent.click(screen.getByRole("checkbox", { name: /morph 290/ }));
    expect(filters.setAppearance).toHaveBeenCalledWith("morph", ["morph 5", "morph 290"]);
  });
});

describe("PhotoFiltersMenu Clear all", () => {
  it("ends the menu with Clear all once a filter is on, clearing the species choice too", () => {
    const filters = {
      query: { appearance: NONE, regionIds: [], tiers: [], selectedTaxa: new Set() },
      activeFilterCount: 2,
      clearFilters: vi.fn(),
    } as unknown as GalleryFilters;
    const onChange = vi.fn();
    render(
      <PhotoFiltersMenu
        filters={filters}
        facets={{ appearance: null } as unknown as GalleryFacets}
        tagOptions={[]}
        sections={[]}
        species={{ options: [], selected: new Set(["s1"]), onChange }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Filters/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clear all filters" }));
    expect(filters.clearFilters).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(new Set());
  });
});

describe("RAW files filter", () => {
  it("offers Not edited yet with its hint, and switching away picks the other choice", () => {
    const filters = {
      query: {
        appearance: NONE,
        regionIds: [],
        tiers: [],
        selectedTaxa: new Set(),
        rawFiles: "unedited",
        editedRaw: "any",
      },
      activeFilterCount: 1,
      setRawFiles: vi.fn(),
      setEditedRaw: vi.fn(),
    } as unknown as GalleryFilters;
    render(
      <PhotoFilterFields
        filters={filters}
        facets={{ appearance: null } as unknown as GalleryFacets}
        tagOptions={[]}
        sections={["raw"]}
      />,
    );
    const group = screen.getByRole("group", { name: "RAW files" });
    expect(group.textContent).toContain("Not edited yet");
    expect(screen.getByText("RAW photos with no edited version. Edits Lifer has linked count.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Only" }));
    expect(filters.setRawFiles).toHaveBeenCalledWith("only");
  });
});
