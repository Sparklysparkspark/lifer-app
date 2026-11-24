// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CaptureEdits } from "./useCaptureEdits";

// The bar measures its buttons; jsdom has no ResizeObserver.
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);
const { CaptureSelectBar } = await import("./CaptureSelection");
afterEach(cleanup);

const edits = () =>
  ({
    tagOptions: [],
    bulkTags: [],
    batchReassigning: false,
    exitSelectMode: vi.fn(),
    hideSelected: vi.fn(),
    rateSelected: vi.fn(),
    reassignSelected: vi.fn(),
    addBulkTags: vi.fn(),
    deleteDialog: { setOpen: vi.fn() },
  }) as unknown as CaptureEdits;

describe("CaptureSelectBar", () => {
  it("is the shared select bar: count, Select all and Deselect all, then the actions", () => {
    const onSelectAll = vi.fn();
    const onDeselectAll = vi.fn();
    const e = edits();
    render(
      <MemoryRouter>
        <CaptureSelectBar
          selectedCount={2}
          total={5}
          edits={e}
          onSelectAll={onSelectAll}
          onDeselectAll={onDeselectAll}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    expect(onSelectAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Deselect all" }));
    expect(onDeselectAll).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(e.hideSelected).toHaveBeenCalled();
  });

  it("asks for a selection instead of offering actions on nothing", () => {
    render(
      <MemoryRouter>
        <CaptureSelectBar selectedCount={0} total={5} edits={edits()} />
      </MemoryRouter>,
    );
    expect(screen.getByText("Select photos to edit them")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Hide" })).toBeNull();
  });
});
