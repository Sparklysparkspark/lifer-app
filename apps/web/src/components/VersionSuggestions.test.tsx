// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const suggestion = (i: number) => ({
  captureId: `c${i}`,
  photoId: `p${i}`,
  fileName: `IMG_${i}_edit.jpg`,
  groupPhotoId: `g${i}`,
  groupFileName: `IMG_${i}.CR3`,
});
const data = { current: { suggestions: [suggestion(1)] } };
vi.mock("../lib/resource", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/resource")>()),
  // Only the review's own list; the viewer's other lookups find nothing.
  useApiRoute: (path: unknown) => ({
    data: String(path).includes("version-suggestions") ? data.current : null,
    reload: async () => {},
  }),
}));

vi.mock("../hooks/useToast", () => ({ useToast: () => ({ show: vi.fn(), error: vi.fn() }) }));

const { default: VersionSuggestions } = await import("./VersionSuggestions");
afterEach(cleanup);
const renderIt = () =>
  render(
    <MemoryRouter>
      <VersionSuggestions />
    </MemoryRouter>,
  );

describe("VersionSuggestions", () => {
  it("opens a pair full size from either thumbnail, to tell whether they're the same photo", async () => {
    data.current = { suggestions: [suggestion(1)] };
    renderIt();
    // Each name on its own line, never joined with a separator.
    expect(screen.getByText("IMG_1.CR3")).toBeTruthy();
    expect(screen.getByText("IMG_1_edit.jpg")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View IMG_1_edit.jpg full size" }));
    const viewer = await screen.findByRole("dialog");
    expect(within(viewer).getByText("2 / 2")).toBeTruthy();
    expect(viewer.querySelector("img[src$='/display']")?.getAttribute("src")).toBe("/api/photos/p1/display");
  });

  it("shows a big review a page at a time", () => {
    data.current = { suggestions: Array.from({ length: 120 }, (_, i) => suggestion(i)) };
    renderIt();
    expect(screen.getAllByRole("listitem")).toHaveLength(50);
    fireEvent.click(screen.getByRole("button", { name: /^Show 50 more/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(100);
  });
});
