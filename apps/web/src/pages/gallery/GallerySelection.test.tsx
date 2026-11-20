// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastContext, type ToastApi } from "../../hooks/useToast";
import type { GalleryEdits } from "./useGalleryEdits";

vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { GallerySelectBar } = await import("./GallerySelection");

const toast: ToastApi = { success: vi.fn(), error: vi.fn(), info: vi.fn(), show: vi.fn(), dismiss: vi.fn() };

const edits = {
  bulk: {
    tags: [],
    changeTags: vi.fn(),
    reassignSelected: vi.fn(),
    batchReassigning: false,
    rate: vi.fn(),
    setRegion: vi.fn(),
    settingRegion: false,
    download: vi.fn(),
  },
  batch: { setOpen: vi.fn() },
  hide: vi.fn(),
  tagOptions: [],
  exitSelectMode: vi.fn(),
  addSelectedToTargetAlbum: vi.fn(),
  addingToTargetAlbum: false,
} as unknown as GalleryEdits;

function renderBar(count: number, regionFirst = false) {
  return render(
    <MemoryRouter>
      <ToastContext.Provider value={toast}>
        <GallerySelectBar
          selectedIds={new Set(Array.from({ length: count }, (_, i) => `c${i}`))}
          selectingAll={false}
          targetAlbumId={null}
          edits={edits}
          suggestedRegionIds={[]}
          regionFirst={regionFirst}
        />
      </ToastContext.Provider>
    </MemoryRouter>,
  );
}

// Lays the row out at `rowPx` wide with every button `buttonPx` wide.
function layout(rowPx: number, buttonPx: number) {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(rowPx);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(buttonPx);
}

afterEach(() => vi.restoreAllMocks());

const names = () => screen.getAllByRole("button").map((b) => b.textContent);

describe("GallerySelectBar", () => {
  it("asks for a selection instead of showing disabled actions", () => {
    renderBar(0);
    expect(screen.getByText("Select photos to edit them")).toBeTruthy();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("puts the actions that don't fit into More, Delete included", () => {
    layout(350, 100);
    renderBar(2);
    expect(names()).toEqual(["Correct ID", "Add tag", "More"]);
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const items = screen.getAllByRole("menuitem").map((b) => b.textContent);
    expect(items).toEqual([
      "Rate",
      "Set region",
      "Add to album",
      "Download originals",
      "Hide",
      "Add location coordinates",
      "Adjust date and time",
      "Delete selected",
    ]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete selected" }));
    expect(edits.batch.setOpen).toHaveBeenCalledWith(true);
  });

  it("keeps Add coordinates and Adjust date and time in More even when the row has room", () => {
    layout(5000, 100);
    renderBar(2);
    expect(names()).not.toContain("Adjust date and time");
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getAllByRole("menuitem").map((b) => b.textContent)).toEqual([
      "Add location coordinates",
      "Adjust date and time",
    ]);
  });

  it("leads with Set region when fixing photos with no region", () => {
    renderBar(1, true);
    expect(names()[0]).toBe("Set region");
  });

  it("opens Correct ID as its own dialog with the species search focused", () => {
    renderBar(1);
    fireEvent.click(screen.getByRole("button", { name: "Correct ID" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByPlaceholderText("Type a species…"));
  });
});
