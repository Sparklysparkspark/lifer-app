// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { ToastContext } from "../../hooks/useToast";

const { UnmatchedReviewPanel } = await import("./LibraryReimportSection");
const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn(), dismiss: vi.fn() };

const file = {
  relativePath: "2024/Belize/very long trip folder name/IMG_0042.jpg",
  contentHash: "abc",
  scientificNames: null,
  suggestion: { inatTaxonId: 1, scientificName: "Ardea herodias", commonName: "Great Blue Heron", exact: true },
};

describe("Re-import review", () => {
  it("opens an unmatched photo full size and leads with its file name", () => {
    render(
      <MemoryRouter>
        <ToastContext.Provider value={toast}>
          <UnmatchedReviewPanel files={[file]} onIgnored={async () => {}} />
        </ToastContext.Provider>
      </MemoryRouter>,
    );
    expect(screen.getByText("IMG_0042.jpg").closest("[title]")?.getAttribute("title")).toBe(file.relativePath);
    fireEvent.click(screen.getByRole("button", { name: `Open ${file.relativePath}` }));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});
