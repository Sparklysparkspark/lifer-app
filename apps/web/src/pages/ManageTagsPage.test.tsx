// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const patch = vi.fn();
vi.mock("../api/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api/client")>()),
  api: {
    get: () => Promise.resolve({ tags: [{ tag: "flight", count: 3 }] }),
    patch: (...a: unknown[]) => patch(...a),
  },
}));
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    disconnect() {}
  },
);

const { default: ManageTagsPage } = await import("./ManageTagsPage");
afterEach(cleanup);

describe("ManageTagsPage", () => {
  it("shows plain words, not the runtime's text, when a rename fails", async () => {
    patch.mockRejectedValue(new TypeError("x.map is not a function"));
    render(
      <MemoryRouter>
        <ManageTagsPage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "More options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "New name for flight" });
    fireEvent.change(input, { target: { value: "in flight" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByText("Couldn't rename that tag.")).toBeTruthy();
    expect(screen.queryByText(/is not a function/)).toBeNull();
  });
});
